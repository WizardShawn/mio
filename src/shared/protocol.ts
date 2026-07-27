// Canonical Mio wire protocol — transport-agnostic.
//
// Both transports (Electron IPC for the local renderer; WebSocket for
// mobile / future off-process clients) speak this exact schema. The
// IPC transport keeps the `IpcChannels` string keys in `./ipc.ts` for
// renderer back-compat (the contextBridge calls them by name through
// preload); the WS transport keys frames on the `method` field below.
//
// Phase 0 rule of thumb: every server-side function in
// `src/server/methods.ts` matches exactly one entry in
// `ServerMethodMap`, and every push-to-client signal matches exactly
// one entry in `ServerEventMap`. The brain emits events through the
// event bus; both transports subscribe and forward.

// ─── Payload / value types ───────────────────────────────────────────
//
// These were previously declared in `./ipc.ts`. They're hoisted here
// so the server can `import { ChatMessage } from '@shared/protocol'`
// without touching the renderer-side IPC channel constants.

export interface AssetManifest {
  vrmPath: string | null;
  idleAnimations: string[];
  talkingAnimations: string[];
  extrasAnimations: string[];
  /**
   * Wardrobe — every `.vrm` file the asset resolver found, surfaced
   * as a list of named outfits the model can switch between via the
   * `change_clothes` tool. The currently-active outfit is also
   * mirrored in `vrmPath` so existing callers (renderer boot, asset
   * test scripts) keep working without knowing about the wardrobe.
   *
   * Optional so a mobile build that ships a single VRM and never
   * implemented the wardrobe path can keep returning the historical
   * 4-field shape without forcing a kotlin update.
   */
  outfits?: OutfitDescriptor[];
  /** Stable id of the outfit currently mirrored in `vrmPath`. */
  activeOutfitId?: string;
}

/**
 * One row in Mio's wardrobe. `id` is a stable, snake_case slug we
 * use on the wire ({@link AvatarOutfitPayload.outfitId}) and as the
 * `change_clothes` tool argument. `label` is the human-readable
 * name Mio uses when she talks about the outfit out loud.
 */
export interface OutfitDescriptor {
  id: string;
  label: string;
  vrmPath: string;
}

/**
 * Pushed when Mio swaps clothes mid-session. The renderer reloads
 * its VRM from `vrmPath`, rebinds animation clips, and recreates
 * the gesture controller against the new humanoid rig.
 */
export interface AvatarOutfitPayload {
  outfitId: string;
  label: string;
  vrmPath: string;
}

export type ReplyMood =
  | 'neutral'
  | 'playful'
  | 'warm'
  | 'shy'
  | 'amused'
  | 'concerned'
  | 'thinking'
  | 'firm';

export interface AvatarTalkingPayload {
  mood?: ReplyMood;
}

export type ChatStreamEvent =
  | { type: 'start' }
  | { type: 'text'; delta: string }
  | { type: 'error'; message: string }
  | { type: 'end'; stopReason?: string };

/**
 * A base64-encoded user-attached file. Despite the legacy name, the
 * media type union now also includes `'application/pdf'` for the
 * mobile attachment sheet — the chat-tool builder branches on the
 * media type (image → `ImageBlockParam`, pdf → `DocumentBlockParam`).
 */
export interface AttachedImage {
  mediaType:
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'image/gif'
    | 'application/pdf';
  data: string;
}

/**
 * Which surface a chat turn (typed message or avatar touch) originated
 * from. The brain uses this to decide what *implicit* visual context to
 * attach: a `'desktop'` turn brings the desktop primary-monitor
 * screenshot; a `'mobile'` turn brings the phone's back camera + phone
 * screen instead, because the user is physically holding the phone and
 * unrelated Windows context would only confuse Mio.
 *
 * Undefined is treated as `'desktop'` — the local Electron renderer
 * never sets it, so it keeps its pre-existing behaviour for free; only
 * the mobile client stamps `'mobile'` explicitly.
 */
export type ChatOrigin = 'desktop' | 'mobile';

export interface ChatSendOptions {
  manualImage?: AttachedImage;
  includeAutoScreenshot?: boolean;
  /** Surface the turn came from. Undefined ⇒ `'desktop'`. */
  origin?: ChatOrigin;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: AttachedImage[];
  createdAt: number;
}

export type GestureKind =
  | 'caress'
  | 'poke'
  | 'pat'
  | 'tickle'
  | 'stroke'
  | 'grab'
  | 'tug'
  | 'pinch';

export type GestureTone =
  | 'casual'
  | 'ticklish'
  | 'affectionate'
  | 'shy';

export type GestureTarget = string;

export interface GestureEvent {
  kind: GestureKind;
  target: GestureTarget;
  tone: GestureTone;
}

export interface GesturePrefs {
  gesturesEnabled: boolean;
}

export interface ApiKeyStatus {
  hasKey: boolean;
  encryptionAvailable: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface UtterancePayload {
  text: string;
  audioUrl: string | null;
  audioOnly?: boolean;
}

export interface ReplyCaptionPayload {
  text: string;
  language: 'zh-Hant' | 'ja';
}

export interface ReplyChunkPayload {
  chunkIndex: number;
  totalChunks: number;
  zhText: string;
  audioUrl: string | null;
  audioDurationMs?: number;
}

// ─── Mobile perception (Phase M-3) ─────────────────────────────────
//
// `perception.upload` is a method whose JSON frame is followed
// immediately by exactly one binary frame on the same WebSocket
// carrying the encoded image bytes. The kind enum is broader than
// "phone camera" deliberately — Phase M-5 reuses the same call shape
// for MediaProjection screen captures, and a desktop client could
// theoretically ship its own webcam if we ever needed dogfooding
// parity.

export type PerceptionFrameKind = 'back-cam' | 'front-cam' | 'screen';

/**
 * MIME type the binary frame uses. `image/jpeg` is the only supported
 * value for v0; left as a string so we can grow to AVIF/WebP without
 * a protocol version bump.
 */
export type PerceptionMediaType = 'image/jpeg' | 'image/webp' | 'image/png';

export interface PerceptionUploadArgs {
  kind: PerceptionFrameKind;
  mediaType: PerceptionMediaType;
  /** Pixel width of the source frame BEFORE any server-side scaling. */
  width: number;
  /** Pixel height of the source frame BEFORE any server-side scaling. */
  height: number;
  /** Client capture timestamp (epoch ms). Used for staleness checks. */
  ts: number;
  /**
   * If this upload is the answer to a `perception.requestFrame` push,
   * echo back the originating `requestId` so the server can finish
   * resolving any waiter that paired with the request.
   */
  requestId?: string;
  /** Optional bytes count for early validation; the WS layer also tracks size. */
  byteLength?: number;
}

export interface PerceptionRequestFramePayload {
  kind: PerceptionFrameKind;
  /**
   * Correlation handle. The mobile client echoes this back through
   * `PerceptionUploadArgs.requestId` so requester ↔ response matching
   * doesn't have to rely on timing.
   */
  requestId: string;
  /**
   * Free-form human-friendly reason ("agent loop wants a back-cam
   * frame", "user asked 'what is this?'"). Mobile may surface it as
   * a permission prompt; the server treats it as documentation.
   */
  reason?: string;
  /**
   * Maximum staleness the requester is willing to accept (epoch ms
   * absolute deadline). Lets the mobile client short-circuit if a
   * fresh capture would already miss the window.
   */
  notLaterThan?: number;
}

/**
 * The phone's current foreground app, as observed by the Android
 * `MioAccessibilityService` (Phase M-5.4). Package name plus a
 * human-readable label resolved on-device; `ts` is the mobile-side
 * capture timestamp. The accessibility service reads the package
 * name ONLY — never window text or content.
 */
export interface MobileActiveApp {
  packageName: string;
  activityLabel: string;
  /** Mobile-side capture timestamp (epoch ms). */
  ts: number;
}

/**
 * Where the *implicit* perception step (agent loop, chat-turn auto
 * snapshot, gesture-turn auto snapshot) sources visual context.
 *
 * - 'desktop-only': only the desktop primary monitor screenshot is
 *   captured. The behaviour Mio shipped with before M-3.
 * - 'mobile-only': only the phone's back camera is captured; if the
 *   pull times out or no client is paired, the perception step
 *   attaches no image at all rather than falling back to the
 *   desktop screen (a privacy-preserving choice for mobile-tethered
 *   workflows).
 * - 'mobile-priority': pull the phone camera first; if it lands
 *   within the 800-ms budget, attach mobile only. Otherwise fall
 *   back to a desktop screenshot. Saves one extra image upload per
 *   tick at the cost of giving up the desktop context entirely
 *   when the phone is available.
 * - 'both' (default since the M-3 polish pass): capture the desktop
 *   screen and the phone back camera in parallel and attach
 *   whichever arrives (one or both). The model gets two views of
 *   the world from a single tick, matching the way Mio thinks
 *   about "what's in front of the user" — the screen they were
 *   working on plus the room they were in.
 *
 * Regardless of mode, **automatically-captured** perception images
 * stay ephemeral — they're never persisted into `chat_messages`,
 * `memory_entries`, or the recall vector store. Only the
 * `ChatSendOptions.manualImage` path (the bottom-row camera button
 * on mobile, future drag-and-drop on desktop) writes images to
 * history.
 */
export type AgentPerceptionMode =
  | 'desktop-only'
  | 'mobile-priority'
  | 'mobile-only'
  | 'both';

export interface AgentPrefs {
  enabled: boolean;
  intervalMinutes: number;
  dailyCostCapUsd: number;
  hourlyCycleCap: number;
  hourlyNotifyCap: number;
  notableCheckInChat: boolean;
  /**
   * Phase M-3 — operator's preferred perception source for the agent
   * loop, the chat-turn auto-snapshot, and the gesture-turn auto-
   * snapshot. Defaults to `'both'` so a mobile-paired Mio sees the
   * screen and the room every implicit tick; users who don't want
   * the camera firing can flip to `'desktop-only'` from Settings.
   */
  perceptionMode?: AgentPerceptionMode;
}

export type AgentState =
  | 'disabled'
  | 'idle'
  | 'running'
  | 'paused'
  | 'capped'
  | 'error';

/**
 * Phase-1 cost-meter — per-surface breakdown of today's Anthropic
 * spend so the HUD can show which leg (typed chat vs cycle vs
 * notable check-in vs welcome-back vs gesture vs computer-use) is
 * actually burning the daily cap. The roll-up in `AgentStatus.
 * estimatedCostUsdToday` is still the source of truth for the cap
 * check; this is purely attribution.
 */
export type ApiPathwayLabel =
  | 'chat'
  | 'cycle'
  | 'check_in'
  | 'welcome_back'
  | 'gesture'
  | 'computer_use';

export interface PathwayUsageToday {
  pathway: ApiPathwayLabel;
  calls: number;
  estimatedCostUsd: number;
}

export interface AgentStatus {
  state: AgentState;
  reason: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  cyclesToday: number;
  estimatedCostUsdToday: number;
  consecutiveErrors: number;
  imagesToday: number;
  dailyImageCap: number;
  /** Per-pathway attribution of today's spend (highest spend first). */
  pathwayBreakdownToday: PathwayUsageToday[];
}

export interface MemoryContextStats {
  estimatedTokens: number;
  messageCount: number;
  observationCount: number;
}

export type TrayMenuStatusTone = 'idle' | 'busy' | 'paused' | 'error';

export interface TrayMenuState {
  avatarVisible: boolean;
  agentPaused: boolean;
  statusTone: TrayMenuStatusTone;
  statusLabel: string;
}

export type PermissionMode = 'guarded' | 'autopilot' | 'readonly';

export interface PermissionPrefs {
  toolsEnabled: boolean;
  mode: PermissionMode;
  workspacePath: string;
  sensitiveApps: string[];
  allowlist: string[];
  denylistExtras: string[];
}

export type PermissionChoice = 'deny' | 'once' | 'task' | 'always';

export interface PermissionRequest {
  id: string;
  title: string;
  summary: string;
  preview: string | null;
  previewKind: 'text' | 'code' | 'diff';
  tool: string;
  allowAlways: boolean;
}

export interface PermissionResponse {
  id: string;
  choice: PermissionChoice;
}

export interface ComputerUseStatus {
  active: boolean;
  label: string;
  step: number;
  maxSteps: number;
}

export interface AuditEntry {
  at: number;
  tool: string;
  summary: string;
  decision: 'auto' | 'allowed' | 'denied' | 'blocked';
  detail: string | null;
}

export interface ComfyUiPrefs {
  enabled: boolean;
  serverUrl: string;
  dailyImageCap: number;
  imageOverlayAutoDismissSec: number;
}

export interface ImageOverlayPayload {
  absPath: string;
  dataUrl: string;
  intent: string | null;
  sourcePrompt: string;
  sourceKind: 'chat' | 'gesture' | 'cycle';
  autoDismissSec: number;
}

export interface ChatToolActivityPayload {
  text: string | null;
}

/**
 * Phase M-6 — a proactive notification the brain wants surfaced to the
 * user wherever they happen to be paying attention. Today it's emitted
 * by the agent loop's `notify_user` tool (see
 * `src/server/brain/agent.ts > dispatchNotification`) on the
 * same path that triggers the desktop OS toast, so a paired phone
 * shows a heads-up at the moment the user's desktop chirps.
 *
 * The desktop renderers deliberately ignore this event — the OS toast
 * already covers the local user. The WS transport forwards it to every
 * authenticated client so any number of phones can render it.
 *
 * `priority` maps to the two Android importance buckets the phone
 * uses: `'normal'` → `IMPORTANCE_DEFAULT`, `'high'` → `IMPORTANCE_HIGH`.
 * `id` lets a re-fired notification de-dupe across phone reconnects;
 * `emittedAt` lets the phone age out stale entries on cold restart.
 */
export interface NotificationSurfacePayload {
  title: string;
  body: string;
  priority: 'normal' | 'high';
  id?: string;
  emittedAt: number;
}

// ─── Server method map ──────────────────────────────────────────────
//
// `ServerMethodMap[K]` describes one RPC. Both transports route
// `{ method: K, args }` to `server.methods[K](args)`. Args/return
// types are spelled out here so the WS transport can be code-gen-free
// and the IPC shim layer can be thin.
//
// Naming: dot-separated `noun.verb`. Match `IpcChannels` semantics
// 1:1 where one exists; add new methods (e.g. mobile-specific) here
// over time.

export interface ServerMethodMap {
  // ── Chat ────────────────────────────────────────────────────────
  'chat.send': {
    args: { text: string; options?: ChatSendOptions };
    /** Resolves after the post-reply translation + TTS hold window. */
    result: void;
  };
  'chat.cancel': { args: void; result: void };
  'chat.getHistory': { args: void; result: ChatMessage[] };
  'chat.clearHistory': { args: void; result: void };
  'chat.gesture': {
    args: { event: GestureEvent; origin?: ChatOrigin };
    result: void;
  };

  // ── Sessions ────────────────────────────────────────────────────
  'sessions.list': { args: void; result: ChatSession[] };
  'sessions.getActive': { args: void; result: string | null };
  'sessions.create': { args: void; result: ChatSession };
  'sessions.activate': { args: { id: string }; result: void };
  'sessions.rename': {
    args: { id: string; title: string };
    result: { ok: boolean; error?: string };
  };
  /** Caller (IPC shim) is responsible for confirmation dialog before invoking. */
  'sessions.delete': { args: { id: string }; result: void };
  /** Caller is responsible for confirmation dialog before invoking. */
  'sessions.clearAll': { args: void; result: void };

  // ── Greeting ────────────────────────────────────────────────────
  'greeting.get': { args: void; result: { effective: string; override: string } };
  'greeting.setOverride': { args: { text: string }; result: void };
  'greeting.getPlayOnLaunch': { args: void; result: boolean };
  'greeting.setPlayOnLaunch': { args: { value: boolean }; result: void };
  'greeting.trigger': { args: void; result: void };

  // ── Agent loop ──────────────────────────────────────────────────
  'agent.prefsGet': { args: void; result: AgentPrefs };
  'agent.prefsSet': { args: { prefs: AgentPrefs }; result: AgentPrefs };
  'agent.statusGet': { args: void; result: AgentStatus };
  'agent.runNow': { args: void; result: void };
  'agent.pauseToggle': { args: void; result: AgentStatus };
  'agent.contextStatsGet': { args: void; result: MemoryContextStats };

  // ── Permission gate ─────────────────────────────────────────────
  'permission.prefsGet': { args: void; result: PermissionPrefs };
  'permission.prefsSet': { args: { prefs: PermissionPrefs }; result: PermissionPrefs };
  'permission.auditGet': { args: void; result: AuditEntry[] };
  'permission.respond': { args: { response: PermissionResponse }; result: void };
  'permission.stop': { args: void; result: void };

  // ── ComfyUI ─────────────────────────────────────────────────────
  'comfyui.prefsGet': { args: void; result: ComfyUiPrefs };
  'comfyui.prefsSet': { args: { prefs: ComfyUiPrefs }; result: ComfyUiPrefs };
  'comfyui.testConnection': { args: void; result: { ok: boolean; detail: string } };

  // ── API keys ────────────────────────────────────────────────────
  'apiKey.getStatus': { args: void; result: ApiKeyStatus };
  'apiKey.set': { args: { key: string }; result: { ok: boolean; error?: string } };
  'apiKey.clear': { args: void; result: { ok: boolean } };

  'geminiKey.getStatus': { args: void; result: ApiKeyStatus };
  'geminiKey.set': { args: { key: string }; result: { ok: boolean; error?: string } };
  'geminiKey.clear': { args: void; result: { ok: boolean } };

  'comfyCloudKey.getStatus': { args: void; result: ApiKeyStatus };
  'comfyCloudKey.set': { args: { key: string }; result: { ok: boolean; error?: string } };
  'comfyCloudKey.clear': { args: void; result: { ok: boolean } };

  // ── User prefs ──────────────────────────────────────────────────
  'userPrefs.getDisplayName': { args: void; result: string };
  'userPrefs.setDisplayName': { args: { name: string }; result: void };

  // ── Gesture prefs ───────────────────────────────────────────────
  'gesturePrefs.get': { args: void; result: GesturePrefs };
  'gesturePrefs.set': { args: { prefs: GesturePrefs }; result: void };

  // ── Avatar ──────────────────────────────────────────────────────
  /** Returns the manifest with TRANSPORT-RELATIVE asset URLs. IPC = cortana-asset://; WS = http://host:port/asset/... */
  'avatar.requestAssets': { args: void; result: AssetManifest };
  /**
   * Switch Mio's outfit. The brain persists the choice as the active
   * wardrobe selection AND fires `avatar.setOutfit` so any connected
   * renderer reloads the VRM live. `outfitId` must match one of the
   * ids in the most-recent `avatar.requestAssets` response.
   */
  'avatar.changeOutfit': {
    args: { outfitId: string };
    result: { ok: boolean; activeOutfitId: string; label: string };
  };

  // ── Mobile perception (Phase M-3) ───────────────────────────────
  /**
   * Mobile client ships a single perception frame to the desktop. The
   * call's JSON frame is immediately followed on the same WebSocket
   * by exactly ONE binary frame carrying the encoded image bytes
   * (typically JPEG @ 75 quality, ≤ 720p — see `mobile/.../camera/
   * CameraSession.kt`). The server holds the pending-binary state in
   * `transport/ws.ts` and only resolves the call once the binary
   * frame lands and is buffered into `server/brain/mobileFrames.ts`.
   *
   * `args.ts` is the client's monotonic capture timestamp (epoch ms)
   * and is used by `agent.ts`'s perception step to age out stale
   * frames before consulting them.
   */
  'perception.upload': {
    args: PerceptionUploadArgs;
    result: { frameId: string };
  };

  /**
   * Mobile pushes the phone's current foreground app (package name +
   * resolved label) whenever it changes — debounced to ≤ 1/s by the
   * Android `MioAccessibilityService`. The server keeps only the most
   * recent sample (`server/brain/mobileActiveApp.ts`); the agent loop
   * reads it alongside the desktop foreground-window probe and uses
   * whichever is fresher for the cycle's "active window" line.
   */
  'perception.activeApp': {
    args: MobileActiveApp;
    result: void;
  };
}

export type ServerMethodName = keyof ServerMethodMap;
export type ServerMethodArgs<K extends ServerMethodName> = ServerMethodMap[K]['args'];
export type ServerMethodResult<K extends ServerMethodName> = ServerMethodMap[K]['result'];

// ─── Server event map ───────────────────────────────────────────────
//
// Push-to-client signals that originate INSIDE the brain (a Claude
// stream chunk landed; the agent loop changed state; an approval
// popup is needed). The brain calls `bus.emit('chat.stream', payload)`;
// every transport subscribed forwards to its connected client(s).

export interface ServerEventMap {
  'chat.stream': ChatStreamEvent;
  'chat.replyCaption': ReplyCaptionPayload;
  'chat.replyChunk': ReplyChunkPayload;
  'chat.toolActivity': ChatToolActivityPayload;
  'chat.playUtterance': UtterancePayload;
  /** Critical agent-loop alert; rendered as red warning text. */
  'chat.showWarning': { message: string };
  /** Global hotkey (Ctrl+Enter) toggling the chat input pill. */
  'chat.toggleInput': void;

  'avatar.setTalking': AvatarTalkingPayload;
  'avatar.setIdle': void;
  'avatar.setGesturePrefs': GesturePrefs;
  /**
   * Mio just changed outfits. The renderer reloads the VRM from the
   * supplied path. Carries the resolved transport-relative URL so
   * the avatar window doesn't have to re-walk the asset manifest.
   */
  'avatar.setOutfit': AvatarOutfitPayload;

  'agent.status': AgentStatus;

  'trayMenu.state': TrayMenuState;

  'permission.request': PermissionRequest;
  'permission.status': ComputerUseStatus;

  'imageOverlay.show': ImageOverlayPayload;

  /**
   * Phase M-6 — proactive notification the brain wants surfaced. The
   * desktop OS toast still fires inside `HostNotifier.notify`; this
   * event is the wire-side mirror for any paired phones. The mobile
   * `MioForegroundService` renders it as a heads-up on the
   * `mio.surface.v1` channel.
   */
  'notification.surface': NotificationSurfacePayload;

  /**
   * Phase M-3 — desktop asks the mobile client to ship the next
   * available perception frame (typically the back camera). The
   * client replies by issuing a `perception.upload` call followed by
   * the binary image frame on the same WebSocket. `requestId` is
   * echoed back through the upload call's `args.requestId` (when
   * present) so the requester can correlate response to request.
   */
  'perception.requestFrame': PerceptionRequestFramePayload;
}

export type ServerEventName = keyof ServerEventMap;
export type ServerEventPayload<E extends ServerEventName> = ServerEventMap[E];

// ─── WebSocket wire framing ─────────────────────────────────────────
//
// Most frames are JSON-text. Phase M-3 introduces a binary-after-call
// pattern: certain methods (currently only `perception.upload`) ship
// their JSON `call` frame followed by EXACTLY one binary frame on the
// same WebSocket carrying the encoded image bytes. The server enters
// a per-client "pending upload" state on the JSON call and resolves
// the call once the binary frame lands. See
// `src/server/transport/ws.ts` for the receiver state machine
// and `mobile/.../net/MioClient.kt` for the sender.

/**
 * Methods that use the binary-after-call wire pattern. The JSON `call`
 * frame for one of these methods MUST be followed by exactly one
 * binary WS frame on the same socket before the next JSON frame is
 * sent; the server keeps that order strict to avoid mis-pairing
 * payloads with calls.
 */
export const BINARY_AFTER_CALL_METHODS: readonly ServerMethodName[] = [
  'perception.upload',
] as const;

export function methodUsesBinaryAfterCall(method: string): boolean {
  return (BINARY_AFTER_CALL_METHODS as readonly string[]).includes(method);
}

export type WsClientFrame =
  | { kind: 'hello'; token: string; deviceId: string; clientVersion: string; protocolVersion: number }
  | {
      kind: 'call';
      callId: string;
      method: ServerMethodName;
      args: unknown;
    };

export type WsServerFrame =
  | { kind: 'welcome'; serverVersion: string; protocolVersion: number }
  | { kind: 'authFailed'; reason: string }
  | {
      kind: 'callResult';
      callId: string;
      ok: true;
      result: unknown;
    }
  | {
      kind: 'callResult';
      callId: string;
      ok: false;
      error: { message: string; code?: string };
    }
  | {
      kind: 'event';
      event: ServerEventName;
      payload: unknown;
      /**
       * Routing-origin meta for surface-bound events. `'mobile'` means
       * the originating turn was driven from a phone; `'desktop'`
       * means it came from the desktop chat pill / hotkey; omitted
       * means a no-surface broadcast (agent loop cycle, greeting,
       * gesture prefs push). Mobile uses this to gate optional
       * mobile-side "Receive proactive messages" / "Voice replies"
       * preferences without needing to inspect the originating call.
       *
       * The desktop chat pill ignores this field — its own filtering
       * happens in the IPC shim before the renderer ever sees it.
       */
      origin?: ChatOrigin;
    };

/** Wire protocol version. Bump on breaking change. */
export const PROTOCOL_VERSION = 0;
