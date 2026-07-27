// Single source of truth for every server verb. Both transports
// (Electron IPC shim and WebSocket) call into THIS module — there is
// exactly one implementation per protocol method.
//
// Naming: a function per `ServerMethodMap` key, named in `noun_verb`
// camelCase. The IPC shim and the WS dispatcher both map a method
// string to the matching exported function.

import { agentLoop } from './brain/agent';
import {
  clearApiKey,
  getApiKeyStatus,
  saveApiKey,
} from './brain/apiKey';
import {
  findOutfitById,
  manifestWithActiveOutfit,
  resolveAssets,
  type ResolvedAssets,
} from './brain/assets';
import { chatService } from './brain/chatService';
import { runAssistantChatTurn } from './brain/chatTurn';
import {
  createSession,
  deleteAllSessions,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  type SessionRow,
} from './brain/chatStore';
import {
  clearComfyCloudKey,
  getComfyCloudKeyStatus,
  loadComfyCloudKey,
  saveComfyCloudKey,
} from './brain/comfyKey';
import {
  probeCloudKey as probeComfyCloudKey,
  probeServer as probeComfyUiServer,
} from './brain/comfyui/client';
import { triggerComputerUseStop } from './brain/computerUseStatus';
import {
  clearGeminiKey,
  getGeminiKeyStatus,
  saveGeminiKey,
} from './brain/geminiKey';
import {
  effectiveGreetingText,
  playGreeting,
} from './brain/greeting';
import { storeMobileActiveApp } from './brain/mobileActiveApp';
import { storeMobileFrame } from './brain/mobileFrames';
import { handlePermissionResponse } from './brain/permissionResponses';
import { readAudit } from './brain/permissions/auditLog';
import { moodFromGestureToneList } from './brain/replyMood';
import { estimateMemoryContextTokens } from './brain/replyContext';
import {
  getActiveSessionId,
  getAgentPrefs,
  getComfyUiPrefs,
  getCurrentOutfitId,
  getGesturePrefs,
  getGreetingOverride,
  getGreetOnLaunch,
  getPermissionPrefs,
  getUserDisplayName,
  setActiveSessionId,
  setComfyUiPrefs,
  setCurrentOutfitId,
  setGesturePrefs,
  setGreetingOverride,
  setGreetOnLaunch,
  setPermissionPrefs,
  setUserDisplayName,
} from './brain/userPreferences';
import { eventBus } from './eventBus';
import type {
  AgentPrefs,
  AgentStatus,
  ApiKeyStatus,
  AssetManifest,
  AuditEntry,
  ChatMessage,
  ChatOrigin,
  ChatSendOptions,
  ChatSession,
  ComfyUiPrefs,
  GestureEvent,
  GestureKind,
  GesturePrefs,
  MemoryContextStats,
  MobileActiveApp,
  PerceptionUploadArgs,
  PermissionPrefs,
  PermissionResponse,
} from '@shared/protocol';

// ─── Gesture rendering + burst batching ──────────────────────────────
//
// A single gesture → `[gesture: kind · region] (…)` line.
// A burst (multiple gestures within BATCH_WINDOW_MS) → one combined
//   `[gestures] kind · region; kind · region; … (…)` line.

const BATCH_WINDOW_MS = 1500;
const BATCH_MAX_EVENTS = 6;

const GESTURE_VERBS = new Set<GestureKind>([
  'caress',
  'poke',
  'pat',
  'tickle',
  'stroke',
  'grab',
  'tug',
  'pinch',
]);

function isGestureEvent(value: unknown): value is GestureEvent {
  if (!value || typeof value !== 'object') return false;
  const g = value as Partial<GestureEvent>;
  return (
    typeof g.kind === 'string' &&
    GESTURE_VERBS.has(g.kind as GestureKind) &&
    typeof g.target === 'string' &&
    g.target.length > 0 &&
    typeof g.tone === 'string'
  );
}

function describeGesture(event: GestureEvent): string {
  const r = event.target;
  switch (event.kind) {
    case 'caress':
      return `gently caressing your ${r}`;
    case 'poke':
      return `poking your ${r}`;
    case 'pat':
      return `patting your ${r}`;
    case 'tickle':
      return `tickling your ${r}`;
    case 'stroke':
      return `stroking along your ${r}`;
    case 'grab':
      return `holding onto your ${r}`;
    case 'tug':
      return `tugging at your ${r}`;
    case 'pinch':
      return `pinching your ${r}`;
  }
}

function renderSingleGesture(event: GestureEvent): string {
  return `[gesture: ${event.kind} · ${event.target}] (the user is ${describeGesture(event)})`;
}

function renderGestureBatch(events: readonly GestureEvent[]): string {
  if (events.length === 1) return renderSingleGesture(events[0]!);
  const tagged = events.map((e) => `${e.kind} · ${e.target}`).join('; ');
  const phrases = events.map(describeGesture).join(', then ');
  return `[gestures] ${tagged} (the user is ${phrases} in quick succession)`;
}

interface PendingBatch {
  events: GestureEvent[];
  /**
   * Surface the touches came from. A burst could in principle mix
   * desktop + mobile touches; mobile wins — routing the turn's
   * perception to the phone is the whole point of tracking origin, so
   * any mobile touch in the batch stamps the batch `'mobile'`.
   */
  origin: ChatOrigin;
  timer: NodeJS.Timeout;
}

let pendingBatch: PendingBatch | null = null;

interface FlushedBatch {
  events: GestureEvent[];
  origin: ChatOrigin;
}

function flushBatch(): FlushedBatch | null {
  if (!pendingBatch) return null;
  clearTimeout(pendingBatch.timer);
  const { events, origin } = pendingBatch;
  pendingBatch = null;
  return { events, origin };
}

function appendToBatch(
  event: GestureEvent,
  origin: ChatOrigin,
  fire: () => void,
): void {
  if (pendingBatch) {
    pendingBatch.events.push(event);
    if (pendingBatch.events.length > BATCH_MAX_EVENTS) {
      pendingBatch.events.shift();
    }
    if (origin === 'mobile') pendingBatch.origin = 'mobile';
    clearTimeout(pendingBatch.timer);
    pendingBatch.timer = setTimeout(fire, BATCH_WINDOW_MS);
    return;
  }
  pendingBatch = {
    events: [event],
    origin,
    timer: setTimeout(fire, BATCH_WINDOW_MS),
  };
}

function fireGestureBatch(): void {
  const flushed = flushBatch();
  if (!flushed || flushed.events.length === 0) return;
  const { events, origin } = flushed;
  const text = renderGestureBatch(events);
  const tones = events.map((e) => e.tone);
  const initialMood = moodFromGestureToneList(tones);
  // M-3 polish — touch/gesture turns collect the same implicit
  // perception as a typed user message, routed by `origin`: a desktop
  // touch brings the desktop screenshot, a mobile touch brings the
  // phone's camera + screen. The model gets a view of the world to
  // colour its reaction to the touch. All legs are transient (see
  // `chatService.send` & `perception.ts`).
  void runAssistantChatTurn({
    text,
    options: { includeAutoScreenshot: true, origin },
    kind: 'gesture',
    initialMood,
    pathway: 'gesture',
  });
}

// ─── Assets cache ────────────────────────────────────────────────────

let resolvedAssets: ResolvedAssets | null = null;

/** Avatar requires the bundled VRM + animation set. */
export function getResolvedAssets(): ResolvedAssets {
  if (!resolvedAssets) resolvedAssets = resolveAssets();
  return resolvedAssets;
}

function rowToSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Chat ────────────────────────────────────────────────────────────

export async function chatSend(args: {
  text: string;
  options?: ChatSendOptions;
}): Promise<void> {
  const flushed = flushBatch();
  const preamble = flushed ? renderGestureBatch(flushed.events) : '';
  const combined = preamble.length > 0
    ? (args.text.trim().length > 0 ? `${preamble}\n\n${args.text}` : preamble)
    : args.text;
  await runAssistantChatTurn({
    text: combined,
    options: args.options ?? {},
    kind: 'user',
  });
}

export function chatCancel(): void {
  chatService.cancel();
}

export function chatGetHistory(): ChatMessage[] {
  return chatService.getHistory();
}

export function chatClearHistory(): void {
  chatService.clearHistory();
}

export function chatGesture(args: {
  event: GestureEvent;
  origin?: ChatOrigin;
}): void {
  if (!isGestureEvent(args.event)) {
    console.warn('[methods] discarded malformed gesture event', args.event);
    return;
  }
  appendToBatch(args.event, args.origin ?? 'desktop', () => fireGestureBatch());
}

// ─── Sessions ────────────────────────────────────────────────────────

export function sessionsList(): ChatSession[] {
  return listSessions().map(rowToSession);
}

export function sessionsGetActive(): string | null {
  return getActiveSessionId();
}

export async function sessionsCreate(): Promise<ChatSession> {
  const row = createSession();
  setActiveSessionId(row.id);
  chatService.switchSession(row.id);
  void playGreeting({ persist: true });
  return rowToSession(row);
}

export function sessionsActivate(args: { id: string }): void {
  const row = getSession(args.id);
  if (!row) return;
  setActiveSessionId(row.id);
  chatService.switchSession(row.id);
}

export function sessionsRename(args: {
  id: string;
  title: string;
}): { ok: boolean; error?: string } {
  const row = getSession(args.id);
  if (!row) return { ok: false, error: 'Session not found.' };
  const t = typeof args.title === 'string' ? args.title.trim() : '';
  if (!t) return { ok: false, error: 'Name cannot be empty.' };
  renameSession(args.id, t);
  return { ok: true };
}

/**
 * The caller is responsible for showing a confirmation dialog (the
 * IPC shim does so via Electron `dialog`; mobile pops its own sheet)
 * BEFORE invoking this method.
 */
export function sessionsDelete(args: { id: string }): void {
  const sessions = listSessions();
  const target = sessions.find((s) => s.id === args.id);
  if (!target) return;
  deleteSession(args.id);
  if (getActiveSessionId() === args.id) {
    const remaining = listSessions();
    if (remaining.length > 0 && remaining[0]) {
      setActiveSessionId(remaining[0].id);
      chatService.switchSession(remaining[0].id);
    } else {
      const fresh = createSession();
      setActiveSessionId(fresh.id);
      chatService.switchSession(fresh.id);
    }
  }
}

/** Caller is responsible for confirmation dialog before invoking. */
export function sessionsClearAll(): void {
  deleteAllSessions();
  const fresh = createSession();
  setActiveSessionId(fresh.id);
  chatService.switchSession(fresh.id);
}

// ─── Greeting ────────────────────────────────────────────────────────

export function greetingGet(): { effective: string; override: string } {
  return {
    effective: effectiveGreetingText(),
    override: getGreetingOverride(),
  };
}

export function greetingSetOverride(args: { text: string }): void {
  setGreetingOverride(typeof args.text === 'string' ? args.text : '');
}

export function greetingGetPlayOnLaunch(): boolean {
  return getGreetOnLaunch();
}

export function greetingSetPlayOnLaunch(args: { value: boolean }): void {
  setGreetOnLaunch(!!args.value);
}

export async function greetingTrigger(): Promise<void> {
  await playGreeting();
}

// ─── Agent ───────────────────────────────────────────────────────────

export function agentPrefsGet(): AgentPrefs {
  return getAgentPrefs();
}

export function agentPrefsSet(args: { prefs: AgentPrefs }): AgentPrefs {
  return agentLoop.applyPrefs(args.prefs);
}

export function agentStatusGet(): AgentStatus {
  return agentLoop.getStatus();
}

export async function agentRunNow(): Promise<void> {
  await agentLoop.runNow();
}

export function agentPauseToggle(): AgentStatus {
  return agentLoop.togglePause();
}

export function agentContextStatsGet(): MemoryContextStats {
  return estimateMemoryContextTokens(getActiveSessionId());
}

// ─── Permissions ─────────────────────────────────────────────────────

export function permissionPrefsGet(): PermissionPrefs {
  return getPermissionPrefs();
}

export function permissionPrefsSet(args: { prefs: PermissionPrefs }): PermissionPrefs {
  return setPermissionPrefs(args.prefs);
}

export function permissionAuditGet(): AuditEntry[] {
  return readAudit();
}

export function permissionRespond(args: { response: PermissionResponse }): void {
  const r = args.response;
  if (r && typeof r.id === 'string') {
    handlePermissionResponse(r.id, r.choice);
  }
}

export function permissionStop(): void {
  triggerComputerUseStop();
}

// ─── ComfyUI ─────────────────────────────────────────────────────────

export function comfyuiPrefsGet(): ComfyUiPrefs {
  return getComfyUiPrefs();
}

export function comfyuiPrefsSet(args: { prefs: ComfyUiPrefs }): ComfyUiPrefs {
  return setComfyUiPrefs(args.prefs);
}

export async function comfyuiTestConnection(): Promise<{ ok: boolean; detail: string }> {
  const [local, cloud] = await Promise.all([
    probeComfyUiServer(),
    probeComfyCloudKey(loadComfyCloudKey()),
  ]);
  const ok = local.ok && cloud.ok;
  const localTag = local.ok ? `Local: ${local.detail}` : `Local FAIL: ${local.detail}`;
  const cloudTag = cloud.ok ? `Cloud: ${cloud.detail}` : `Cloud FAIL: ${cloud.detail}`;
  return { ok, detail: `${localTag} · ${cloudTag}` };
}

// ─── API keys ────────────────────────────────────────────────────────

export function apiKeyGetStatus(): ApiKeyStatus {
  return getApiKeyStatus();
}

export function apiKeySet(args: { key: string }): { ok: boolean; error?: string } {
  return saveApiKey(args.key);
}

export function apiKeyClear(): { ok: boolean } {
  clearApiKey();
  return { ok: true };
}

export function geminiKeyGetStatus(): ApiKeyStatus {
  return getGeminiKeyStatus();
}

export function geminiKeySet(args: { key: string }): { ok: boolean; error?: string } {
  return saveGeminiKey(args.key);
}

export function geminiKeyClear(): { ok: boolean } {
  clearGeminiKey();
  return { ok: true };
}

export function comfyCloudKeyGetStatus(): ApiKeyStatus {
  return getComfyCloudKeyStatus();
}

export function comfyCloudKeySet(args: { key: string }): { ok: boolean; error?: string } {
  return saveComfyCloudKey(args.key);
}

export function comfyCloudKeyClear(): { ok: boolean } {
  clearComfyCloudKey();
  return { ok: true };
}

// ─── User prefs ──────────────────────────────────────────────────────

export function userPrefsGetDisplayName(): string {
  return getUserDisplayName();
}

export function userPrefsSetDisplayName(args: { name: string }): void {
  setUserDisplayName(typeof args.name === 'string' ? args.name : '');
}

// ─── Gesture prefs ───────────────────────────────────────────────────

export function gesturePrefsGet(): GesturePrefs {
  return getGesturePrefs();
}

export function gesturePrefsSet(args: { prefs: GesturePrefs }): void {
  const next = setGesturePrefs(args.prefs);
  eventBus.emit('avatar.setGesturePrefs', next);
}

// ─── Avatar ──────────────────────────────────────────────────────────

/**
 * Returns the asset manifest with transport-agnostic absolute paths;
 * each transport rewrites them to its own URL scheme (cortana-asset://
 * for IPC, http://host:port/asset/... for WS). The active outfit
 * preference is overlaid here so `manifest.vrmPath` matches whatever
 * Mio was last seen wearing — without it the renderer would always
 * boot the first outfit alphabetically.
 */
export function avatarRequestAssets(): AssetManifest {
  const { manifest } = getResolvedAssets();
  const persisted = getCurrentOutfitId();
  return manifestWithActiveOutfit(manifest, persisted);
}

/**
 * Switch Mio's outfit. The brain validates the choice against the
 * resolved wardrobe, persists the new selection, and broadcasts the
 * `avatar.setOutfit` event so any connected renderer reloads its VRM.
 *
 * Callers (the `change_clothes` tool, a future Settings UI, etc.)
 * receive the resolved label so they can echo it back to the user
 * without re-walking the manifest.
 */
export function avatarChangeOutfit(args: { outfitId: string }): {
  ok: boolean;
  activeOutfitId: string;
  label: string;
} {
  const { manifest } = getResolvedAssets();
  const requested = typeof args.outfitId === 'string' ? args.outfitId.trim() : '';
  if (requested.length === 0) {
    throw new Error('outfitId is required.');
  }
  const outfit = findOutfitById(manifest, requested);
  if (!outfit) {
    const available = (manifest.outfits ?? []).map((o) => o.id).join(', ');
    throw new Error(
      `Unknown outfit "${requested}". Available: ${available || '(none)'}`,
    );
  }
  setCurrentOutfitId(outfit.id);
  eventBus.emit('avatar.setOutfit', {
    outfitId: outfit.id,
    label: outfit.label,
    vrmPath: outfit.vrmPath,
  });
  return { ok: true, activeOutfitId: outfit.id, label: outfit.label };
}

// ─── Mobile perception (Phase M-3) ─────────────────────────────────

/**
 * Sink for the binary-after-call `perception.upload` method. The WS
 * transport (see `transport/ws.ts`) parks the JSON `args` until the
 * matching binary WS frame arrives, then invokes this function with
 * BOTH the args and the binary buffer.
 *
 * Storage is in-memory only (no disk write — frames are short-lived
 * sensor data) and lives in `mobileFrames.ts`. The returned
 * `frameId` is the key callers like `agent.ts > perception` use to
 * pull the buffer back later.
 */
export function perceptionUpload(
  args: PerceptionUploadArgs,
  binary: Buffer | null,
): { frameId: string } {
  if (!binary || binary.length === 0) {
    throw new Error('perception.upload requires a binary frame');
  }
  const frameId = storeMobileFrame({
    kind: args.kind,
    mediaType: args.mediaType,
    width: args.width,
    height: args.height,
    ts: args.ts,
    requestId: args.requestId ?? null,
    bytes: binary,
  });
  return { frameId };
}

/**
 * Sink for `perception.activeApp` (Phase M-5.4). The mobile
 * `MioAccessibilityService` pushes the phone's foreground app whenever
 * it changes; we keep only the most recent sample in
 * `mobileActiveApp.ts`. The agent loop reads it next to the desktop
 * foreground-window probe and prefers whichever is fresher.
 */
export function perceptionActiveApp(args: MobileActiveApp): void {
  if (
    !args ||
    typeof args.packageName !== 'string' ||
    args.packageName.length === 0
  ) {
    return;
  }
  storeMobileActiveApp({
    packageName: args.packageName,
    activityLabel:
      typeof args.activityLabel === 'string' ? args.activityLabel : '',
    ts: typeof args.ts === 'number' ? args.ts : Date.now(),
  });
}
