import {
  awaitCompletion,
  ComfyExecutionError,
  fetchImage,
  findPartnerNodes,
  isAspectRatio,
  loadAndPatchTemplate,
  randomSeed,
  submitWorkflow,
  type AspectRatio,
} from '../comfyui/client';
import { cacheKey, findByKey, save as saveImage } from '../comfyui/imageStore';
import { bumpImage, getDailyCounters } from '../agentCounters';
import { loadComfyCloudKey } from '../comfyKey';
import { eventBus } from '../../eventBus';
import { getDatabase } from '../database';
import { getComfyUiPrefs } from '../userPreferences';
import type { ToolContext, ToolDescriptor, ToolResultContent } from './types';

// Phase 10 — `generate_image`. Mio's drawing hand.

const HOUR_MS = 60 * 60 * 1000;
const HOURLY_IMAGE_CAP = 10;
const PER_CYCLE_IMAGE_CAP = 1;
const COMFY_BACKOFF_FAILURE_THRESHOLD = 3;
const COMFY_BACKOFF_MS = 5 * 60 * 1000;

const hourlyHistory: number[] = [];
let consecutiveFailures = 0;
let backoffUntil = 0;

let currentCycleId: string | null = null;
let currentCycleImageCount = 0;

export function beginCycle(cycleId: string): void {
  currentCycleId = cycleId;
  currentCycleImageCount = 0;
}

export function endCycle(cycleId: string): void {
  if (currentCycleId === cycleId) {
    currentCycleId = null;
    currentCycleImageCount = 0;
  }
}

interface CapVerdict {
  ok: boolean;
  reason?: string;
}

function checkCaps(ctx: ToolContext): CapVerdict {
  const prefs = getComfyUiPrefs();
  if (!prefs.enabled) {
    return {
      ok: false,
      reason:
        'ComfyUI is disabled in Settings → API Connections — flip Enabled on after starting the local server.',
    };
  }
  const now = Date.now();
  if (backoffUntil > now) {
    const sec = Math.ceil((backoffUntil - now) / 1000);
    return {
      ok: false,
      reason: `ComfyUI is in a ${COMFY_BACKOFF_MS / 60_000}-min cool-down after ${COMFY_BACKOFF_FAILURE_THRESHOLD} consecutive failures — try again in ${sec}s.`,
    };
  }
  const counters = getDailyCounters();
  if (counters.images >= prefs.dailyImageCap) {
    return {
      ok: false,
      reason: `Daily image cap reached (${counters.images}/${prefs.dailyImageCap}). Resets at local midnight.`,
    };
  }
  while (hourlyHistory.length > 0 && hourlyHistory[0]! < now - HOUR_MS) {
    hourlyHistory.shift();
  }
  if (hourlyHistory.length >= HOURLY_IMAGE_CAP) {
    return {
      ok: false,
      reason: `Hourly image cap reached (${hourlyHistory.length}/${HOURLY_IMAGE_CAP}). Burst protection — try again in a few minutes.`,
    };
  }
  if (ctx.sourceKind === 'cycle' && currentCycleId !== null) {
    if (currentCycleImageCount >= PER_CYCLE_IMAGE_CAP) {
      return {
        ok: false,
        reason: `Per-cycle image cap reached (${PER_CYCLE_IMAGE_CAP}). The autonomous loop only draws once per tick — wait for the next cycle.`,
      };
    }
  }
  return { ok: true };
}

function recordSuccess(ctx: ToolContext): void {
  hourlyHistory.push(Date.now());
  bumpImage();
  consecutiveFailures = 0;
  if (ctx.sourceKind === 'cycle' && currentCycleId !== null) {
    currentCycleImageCount += 1;
  }
  // Phase 10 — nudge the status HUD so the operator sees the new
  // image count without having to wait for the next agent-loop tick.
  // Lazy require keeps the import order one-directional (agent ->
  // tools/generateImage) and avoids a load-time cycle.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../agent') as typeof import('../agent');
    mod.agentLoop.republishStatus();
  } catch (err) {
    console.warn('[generate_image] HUD republish failed', err);
  }
}

function recordFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= COMFY_BACKOFF_FAILURE_THRESHOLD) {
    backoffUntil = Date.now() + COMFY_BACKOFF_MS;
    consecutiveFailures = 0;
    console.warn(
      `[generate_image] backoff engaged — ${COMFY_BACKOFF_MS / 60_000}-min cool-down after ${COMFY_BACKOFF_FAILURE_THRESHOLD} consecutive failures`,
    );
  }
}

function persistGeneratedImageRow(args: {
  prompt: string;
  intent: string | null;
  aspectRatio: AspectRatio;
  absPath: string;
  sourceKind: ToolContext['sourceKind'];
}): void {
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO generated_images
         (message_id, prompt, intent, aspect_ratio, file_path, source_kind, created_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.prompt,
      args.intent,
      args.aspectRatio,
      args.absPath,
      args.sourceKind,
      Date.now(),
    );
  } catch (err) {
    console.warn('[generate_image] DB insert failed', err);
  }
}

interface RunSuccess {
  ok: true;
  absPath: string;
  dataUrl: string;
  cached: boolean;
  intent: string | null;
}

interface RunFailure {
  ok: false;
  reason: string;
  retryable: boolean;
}

export async function runGenerateImage(args: {
  prompt: string;
  aspectRatio?: AspectRatio | undefined;
  intent?: string | undefined;
  ctx: ToolContext;
}): Promise<RunSuccess | RunFailure> {
  const { ctx } = args;
  const prompt = args.prompt.trim();
  if (prompt.length === 0) {
    return { ok: false, reason: 'prompt is required.', retryable: false };
  }

  const verdict = checkCaps(ctx);
  if (!verdict.ok) {
    console.warn(`[generate_image] gated: ${verdict.reason}`);
    return { ok: false, reason: verdict.reason ?? 'Capped.', retryable: false };
  }

  const aspectRatio: AspectRatio = args.aspectRatio ?? '16:9';
  const intent = args.intent?.trim() || null;
  const prefs = getComfyUiPrefs();

  console.log(
    `[generate_image] source=${ctx.sourceKind} aspect=${aspectRatio} prompt="${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}"`,
  );

  let patched;
  try {
    patched = loadAndPatchTemplate({
      prompt,
      aspectRatio,
      seed: randomSeed(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate_image] template load failed: ${msg}`);
    return { ok: false, reason: msg, retryable: false };
  }

  const comfyCloudApiKey = loadComfyCloudKey();
  const partnerNodes = findPartnerNodes(patched.workflow);
  if (partnerNodes.length > 0 && !comfyCloudApiKey) {
    console.warn(
      `[generate_image] Partner Nodes ${JSON.stringify(partnerNodes)} present but no Comfy Cloud key — short-circuiting.`,
    );
    return {
      ok: false,
      reason:
        `Workflow uses Comfy Cloud Partner Node(s) ${partnerNodes.join(', ')} but no ` +
        `Comfy Cloud API key is configured. Open Settings → API Connections → ComfyUI and ` +
        `paste a key from platform.comfy.org, or switch to an all-local workflow.`,
      retryable: false,
    };
  }

  const key = cacheKey({
    workflow: patched.workflow,
    prompt: patched.prompt,
    seed: patched.seed,
  });

  const cached = findByKey(key);
  if (cached) {
    console.log(`[generate_image] cache hit — skipping ComfyUI round-trip (key=${key})`);
    recordSuccess(ctx);
    persistGeneratedImageRow({
      prompt,
      intent,
      aspectRatio,
      absPath: cached.absPath,
      sourceKind: ctx.sourceKind,
    });
    eventBus.emit('imageOverlay.show', {
      absPath: cached.absPath,
      dataUrl: cached.dataUrl,
      intent,
      sourcePrompt: prompt,
      sourceKind: ctx.sourceKind,
      autoDismissSec: prefs.imageOverlayAutoDismissSec,
    });
    return { ok: true, ...cached, intent };
  }

  const overallStart = Date.now();
  try {
    const submission = await submitWorkflow({
      serverUrl: prefs.serverUrl,
      workflow: patched.workflow,
      comfyCloudApiKey,
      signal: ctx.signal,
    });
    const image = await awaitCompletion({
      serverUrl: prefs.serverUrl,
      promptId: submission.promptId,
      signal: ctx.signal,
    });
    const bytes = await fetchImage({
      serverUrl: prefs.serverUrl,
      image,
      signal: ctx.signal,
    });
    const saved = saveImage({ bytes, prompt, key });
    recordSuccess(ctx);
    persistGeneratedImageRow({
      prompt,
      intent,
      aspectRatio,
      absPath: saved.absPath,
      sourceKind: ctx.sourceKind,
    });
    eventBus.emit('imageOverlay.show', {
      absPath: saved.absPath,
      dataUrl: saved.dataUrl,
      intent,
      sourcePrompt: prompt,
      sourceKind: ctx.sourceKind,
      autoDismissSec: prefs.imageOverlayAutoDismissSec,
    });
    console.log(
      `[generate_image] success in ${Date.now() - overallStart}ms → ${saved.absPath}`,
    );
    return { ok: true, absPath: saved.absPath, dataUrl: saved.dataUrl, cached: false, intent };
  } catch (err) {
    recordFailure();
    const msg = err instanceof Error ? err.message : String(err);
    const surfaced =
      err instanceof ComfyExecutionError ? msg : `ComfyUI failed: ${msg}`;
    console.error(
      `[generate_image] failure after ${Date.now() - overallStart}ms (failureStreak=${consecutiveFailures}): ${surfaced}`,
    );
    return { ok: false, reason: surfaced, retryable: true };
  }
}

function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

export const generateImageTool: ToolDescriptor = {
  spec: {
    name: 'generate_image',
    description:
      'Render an image with ComfyUI from a short English prompt. The rendered ' +
      'PNG is shown to the operator as a glass card next to your avatar and ' +
      'attached back to you on the next round so you can see what you drew. ' +
      'Use whenever you feel like drawing — observation, gesture reply, chat — ' +
      'but never when you have nothing visual to say.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'English text-to-image prompt. Write it like a Grok / SD prompt — subject, lighting, ' +
            'mood, optional style. Keep it under ~80 words.',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['16:9', '1:1', '9:16', '4:3', '3:4'],
          description: 'Aspect ratio of the generated image. Defaults to 16:9.',
        },
        intent: {
          type: 'string',
          description:
            'Optional Japanese phrase — what you wanted to capture / why you drew this. ' +
            'Shown to the operator as a caption pill under the image. Keep it under ~25 chars.',
        },
      },
      required: ['prompt'],
    },
  },
  async execute(input, ctx): Promise<ToolResultContent> {
    const promptVal = input['prompt'];
    if (typeof promptVal !== 'string' || promptVal.trim().length === 0) {
      return 'Error: `prompt` is required.';
    }
    const aspectRaw = input['aspect_ratio'];
    const aspectRatio: AspectRatio | undefined = isAspectRatio(aspectRaw)
      ? aspectRaw
      : undefined;
    const intentVal = input['intent'];
    const intent = typeof intentVal === 'string' ? intentVal : undefined;

    const result = await runGenerateImage({
      prompt: promptVal,
      aspectRatio,
      intent,
      ctx,
    });

    if (!result.ok) {
      return `生成失敗: ${result.reason}`;
    }

    const captionPieces = [
      `生成成功 (path=${result.absPath})`,
      result.cached ? '(キャッシュ済み)' : null,
    ].filter((s): s is string => s !== null);
    const caption = captionPieces.join(' ');

    return [
      { type: 'text', text: caption },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: dataUrlToBase64(result.dataUrl),
        },
      },
    ];
  },
};
