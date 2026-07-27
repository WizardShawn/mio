import fs from 'node:fs';
import path from 'node:path';

import { getHost } from '../host';
import { getComfyUiPrefs } from '../userPreferences';

// Phase 10 — talks HTTP to a local ComfyUI server.

const HTTP_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 400;
const WORKFLOW_TEMPLATE_NAME = 'grok_text_to_image.json';
const POLL_BUDGET_MS = 90_000;

export type AspectRatio = '16:9' | '1:1' | '9:16' | '4:3' | '3:4';

const ALLOWED_ASPECT_RATIOS: ReadonlySet<AspectRatio> = new Set([
  '16:9',
  '1:1',
  '9:16',
  '4:3',
  '3:4',
]);

export function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && ALLOWED_ASPECT_RATIOS.has(value as AspectRatio);
}

class ComfyExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComfyExecutionError';
  }
}

const PARTNER_NODE_CLASS_TYPES = new Set<string>([
  'GrokImageNode',
]);

export function findPartnerNodes(workflow: Record<string, unknown>): string[] {
  const matches: string[] = [];
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue;
    const ct = (node as Record<string, unknown>)['class_type'];
    if (typeof ct === 'string' && PARTNER_NODE_CLASS_TYPES.has(ct)) {
      matches.push(ct);
    }
  }
  return matches;
}

// ─── Workflow template loading + patching ──────────────────────────

function workflowsRootCandidates(): string[] {
  const host = getHost();
  const candidates = [
    path.join(host.paths.userData, 'assets', 'workflows'),
  ];
  if (host.paths.isPackaged) {
    candidates.push(path.join(host.paths.resourcesPath, 'assets', 'workflows'));
  } else {
    candidates.push(path.resolve(__dirname, '..', '..', 'assets', 'workflows'));
  }
  return candidates;
}

function resolveTemplatePath(): string | null {
  for (const dir of workflowsRootCandidates()) {
    const candidate = path.join(dir, WORKFLOW_TEMPLATE_NAME);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface WorkflowPatch {
  prompt: string;
  aspectRatio: AspectRatio;
  seed: number;
  resolution?: string;
  numberOfImages?: number;
  filenamePrefix?: string;
}

export interface LoadedWorkflow {
  workflow: Record<string, unknown>;
  prompt: string;
  seed: number;
  templatePath: string;
}

export function loadAndPatchTemplate(patch: WorkflowPatch): LoadedWorkflow {
  const templatePath = resolveTemplatePath();
  if (!templatePath) {
    throw new Error(
      `ComfyUI workflow template missing — expected ${WORKFLOW_TEMPLATE_NAME} ` +
        `under assets/workflows/ in the app data or repo root.`,
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read workflow template at ${templatePath}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Workflow template ${templatePath} is not valid JSON: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Workflow template ${templatePath} must be a JSON object.`);
  }
  const workflow = parsed as Record<string, unknown>;
  const grokNode = workflow['2'];
  if (!grokNode || typeof grokNode !== 'object') {
    throw new Error(
      `Workflow template ${templatePath} is missing required node "2" (GrokImageNode).`,
    );
  }
  const grokInputs = ((grokNode as Record<string, unknown>)['inputs'] ?? {}) as Record<
    string,
    unknown
  >;
  grokInputs['prompt'] = patch.prompt;
  grokInputs['aspect_ratio'] = patch.aspectRatio;
  grokInputs['seed'] = patch.seed;
  grokInputs['number_of_images'] = patch.numberOfImages ?? 1;
  grokInputs['resolution'] = patch.resolution ?? '1K';
  (grokNode as Record<string, unknown>)['inputs'] = grokInputs;

  const saveNode = workflow['3'];
  if (saveNode && typeof saveNode === 'object') {
    const saveInputs = ((saveNode as Record<string, unknown>)['inputs'] ?? {}) as Record<
      string,
      unknown
    >;
    saveInputs['filename_prefix'] = patch.filenamePrefix ?? 'Mio';
    (saveNode as Record<string, unknown>)['inputs'] = saveInputs;
  }

  return { workflow, prompt: patch.prompt, seed: patch.seed, templatePath };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffff_ffff);
}

// ─── HTTP helpers ──────────────────────────────────────────────────

function joinUrl(serverUrl: string, p: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  const tail = p.startsWith('/') ? p : `/${p}`;
  return `${base}${tail}`;
}

function timeoutSignal(extra?: AbortSignal): AbortSignal {
  const inputs: AbortSignal[] = [AbortSignal.timeout(HTTP_TIMEOUT_MS)];
  if (extra) inputs.push(extra);
  return AbortSignal.any(inputs);
}

interface PromptResponse {
  prompt_id?: string;
}

export interface SubmitResult {
  promptId: string;
  clientId: string;
}

export async function submitWorkflow(args: {
  serverUrl: string;
  workflow: Record<string, unknown>;
  comfyCloudApiKey?: string | null;
  signal?: AbortSignal;
}): Promise<SubmitResult> {
  const { serverUrl, workflow, comfyCloudApiKey, signal } = args;
  const clientId = `mio-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const payload: Record<string, unknown> = {
    prompt: workflow,
    client_id: clientId,
  };
  if (comfyCloudApiKey && comfyCloudApiKey.length > 0) {
    payload['extra_data'] = { api_key_comfy_org: comfyCloudApiKey };
  }
  const body = JSON.stringify(payload);
  const url = joinUrl(serverUrl, '/prompt');
  const startedAt = Date.now();
  console.log(
    `[comfyui] POST ${url} (clientId=${clientId}, partnerKey=${comfyCloudApiKey ? 'yes' : 'no'}, bodyBytes=${body.length})`,
  );
  let res: Response;
  try {
    res = await getHost().net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: timeoutSignal(signal),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[comfyui] POST /prompt fetch threw: ${msg}`);
    throw new Error(
      `Could not reach ComfyUI at ${serverUrl} — is the server running with --enable-cors-header *? (${msg})`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[comfyui] POST /prompt HTTP ${res.status}: ${text.slice(0, 400)}`);
    throw new Error(
      `ComfyUI POST /prompt failed: HTTP ${res.status} ${text.slice(0, 400)}`,
    );
  }
  const json = (await res.json()) as PromptResponse;
  if (!json.prompt_id || typeof json.prompt_id !== 'string') {
    throw new Error(`ComfyUI POST /prompt returned no prompt_id: ${JSON.stringify(json).slice(0, 200)}`);
  }
  console.log(
    `[comfyui] /prompt accepted prompt_id=${json.prompt_id} in ${Date.now() - startedAt}ms`,
  );
  return { promptId: json.prompt_id, clientId };
}

interface HistoryOutputImage {
  filename?: string;
  subfolder?: string;
  type?: string;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: HistoryOutputImage[] }>;
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
}

type HistoryMap = Record<string, HistoryEntry>;

export async function awaitCompletion(args: {
  serverUrl: string;
  promptId: string;
  signal?: AbortSignal;
}): Promise<HistoryOutputImage> {
  const { serverUrl, promptId, signal } = args;
  const deadline = Date.now() + POLL_BUDGET_MS;
  let lastError: string | null = null;
  let polls = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('ComfyUI poll cancelled.');
    polls += 1;
    let res: Response | null = null;
    try {
      res = await getHost().net.fetch(
        joinUrl(serverUrl, `/history/${encodeURIComponent(promptId)}`),
        { signal: timeoutSignal(signal) },
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[comfyui] /history poll ${polls} fetch threw: ${lastError}`);
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      console.warn(`[comfyui] /history poll ${polls} returned ${lastError}`);
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    let map: HistoryMap;
    try {
      map = (await res.json()) as HistoryMap;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[comfyui] /history poll ${polls} JSON parse failed: ${lastError}`);
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const entry = map[promptId];
    if (entry) {
      const completed = entry.status?.completed === true;
      const first = firstImage(entry);
      if (entry.status?.status_str === 'error') {
        const extra = formatStatusMessages(entry.status?.messages);
        const msg = `ComfyUI reported an error for prompt ${promptId}.${extra ? ' ' + extra : ''}`;
        console.error(`[comfyui] execution error after ${polls} polls: ${msg}`);
        throw new ComfyExecutionError(msg);
      }
      if (completed && first) {
        console.log(
          `[comfyui] prompt ${promptId} completed in ${polls} polls (${Date.now() - (deadline - POLL_BUDGET_MS)}ms)`,
        );
        return first;
      }
      if (completed && !first) {
        const extra = formatStatusMessages(entry.status?.messages);
        const msg = `ComfyUI finished prompt ${promptId} but produced no image in history.${extra ? ' ' + extra : ''}`;
        console.error(`[comfyui] ${msg}`);
        throw new ComfyExecutionError(msg);
      }
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `ComfyUI did not complete within ${POLL_BUDGET_MS / 1000}s` +
      (lastError ? ` (last error: ${lastError})` : ''),
  );
}

function firstImage(entry: HistoryEntry): HistoryOutputImage | null {
  const outputs = entry.outputs ?? {};
  for (const node of Object.values(outputs)) {
    const images = node?.images ?? [];
    if (images.length > 0 && images[0]?.filename) return images[0];
  }
  return null;
}

function formatStatusMessages(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  try {
    const text = JSON.stringify(messages);
    return text.length > 520 ? `${text.slice(0, 520)}…` : text;
  } catch {
    return '';
  }
}

export async function fetchImage(args: {
  serverUrl: string;
  image: HistoryOutputImage;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const { serverUrl, image, signal } = args;
  if (!image.filename) throw new Error('ComfyUI output image had no filename.');
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  });
  const url = joinUrl(serverUrl, `/view?${params.toString()}`);
  const startedAt = Date.now();
  const res = await getHost().net.fetch(url, { signal: timeoutSignal(signal) });
  if (!res.ok) {
    console.error(`[comfyui] GET /view ${url} → HTTP ${res.status}`);
    throw new Error(`ComfyUI GET /view failed: HTTP ${res.status}.`);
  }
  const ab = await res.arrayBuffer();
  console.log(
    `[comfyui] fetched ${ab.byteLength} bytes from /view (${image.filename}) in ${Date.now() - startedAt}ms`,
  );
  return Buffer.from(ab);
}

export { ComfyExecutionError };

// ─── Health probe (Test connection button) ─────────────────────────

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

const COMFY_CLOUD_BASE_URL = 'https://cloud.comfy.org';

export async function probeCloudKey(apiKey: string | null | undefined): Promise<ProbeResult> {
  if (!apiKey || apiKey.trim().length === 0) {
    return { ok: false, detail: 'no key configured' };
  }
  let res: Response;
  try {
    res = await getHost().net.fetch(`${COMFY_CLOUD_BASE_URL}/api/user`, {
      headers: { 'X-API-Key': apiKey.trim() },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : 'cloud unreachable',
    };
  }
  if (res.status === 401) return { ok: false, detail: 'key rejected (401)' };
  if (res.status === 402) return { ok: false, detail: 'insufficient credits (402)' };
  if (res.status === 429) return { ok: false, detail: 'subscription inactive (429)' };
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  let balance: number | null = null;
  try {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    for (const key of ['credits', 'credit', 'balance', 'remaining_credits']) {
      const v = data[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        balance = v;
        break;
      }
    }
  } catch {
    /* swallow */
  }
  return {
    ok: true,
    detail:
      balance !== null
        ? `${balance.toLocaleString()} credits`
        : 'key valid',
  };
}

export async function probeServer(serverUrl?: string): Promise<ProbeResult> {
  const url = serverUrl ?? getComfyUiPrefs().serverUrl;
  try {
    const res = await getHost().net.fetch(joinUrl(url, '/system_stats'), {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status} from ${url}` };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const system = (data['system'] ?? {}) as Record<string, unknown>;
    const versionRaw = system['comfyui_version'];
    const version =
      typeof versionRaw === 'string' && versionRaw.length > 0
        ? versionRaw
        : 'unknown version';
    const devicesRaw = data['devices'];
    const deviceCount = Array.isArray(devicesRaw) ? devicesRaw.length : 0;
    const deviceSuffix =
      deviceCount > 0 ? ` — ${deviceCount} device${deviceCount === 1 ? '' : 's'}` : '';
    return { ok: true, detail: `ComfyUI ${version}${deviceSuffix}` };
  } catch (err) {
    return {
      ok: false,
      detail:
        err instanceof Error
          ? `${err.message} (${url})`
          : `Connection failed (${url})`,
    };
  }
}
