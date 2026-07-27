// Renderer ⇆ main Electron IPC channel names + the `contextBridge` API
// shapes the preload scripts hand to `window.*Api`.
//
// The PAYLOAD/VALUE types previously declared in this file now live in
// `./protocol.ts` so the new transport-agnostic server (which also
// speaks WebSocket for mobile) can import them without pulling in the
// Electron-specific channel constants. Renderer imports of types like
// `ChatMessage`, `GestureEvent`, etc. continue to resolve through this
// file by re-export — no renderer-side change.

export * from './protocol';

import type {
  AgentPrefs,
  AgentStatus,
  ApiKeyStatus,
  AssetManifest,
  AuditEntry,
  AvatarOutfitPayload,
  AvatarTalkingPayload,
  ChatMessage,
  ChatSendOptions,
  ChatSession,
  ChatStreamEvent,
  ChatToolActivityPayload,
  ComfyUiPrefs,
  ComputerUseStatus,
  GestureEvent,
  GesturePrefs,
  ImageOverlayPayload,
  MemoryContextStats,
  PermissionPrefs,
  PermissionRequest,
  PermissionResponse,
  ReplyCaptionPayload,
  ReplyChunkPayload,
  TrayMenuState,
  UtterancePayload,
} from './protocol';

export const IpcChannels = {
  // Avatar renderer -> main
  AvatarReady: 'avatar:ready',
  AvatarRequestAssets: 'avatar:request-assets',
  AvatarGesture: 'avatar:gesture',
  /** Delta move for the avatar window (Alt+drag); see renderer/avatar/style.css */
  AvatarMoveWindowBy: 'avatar:move-window-by',
  /**
   * Renderer -> main: toggle the sender window's click-through state.
   * The avatar and chat overlays default to click-through and flip this
   * off only while the cursor is over an interactive area, so the
   * transparent regions never block the desktop underneath.
   */
  WindowSetMouseIgnore: 'window:set-mouse-ignore',

  // Main -> avatar renderer (animation state)
  AvatarSetTalking: 'avatar:set-talking',
  AvatarSetIdle: 'avatar:set-idle',
  /** Main -> avatar: push refreshed gesture prefs so the renderer rebuilds its detector. */
  AvatarSetGesturePrefs: 'avatar:set-gesture-prefs',
  /** Main -> avatar: Mio changed outfits; reload the VRM from the supplied path. */
  AvatarSetOutfit: 'avatar:set-outfit',

  // Chat renderer <-> main
  ChatSendMessage: 'chat:send-message',
  ChatCancel: 'chat:cancel',
  ChatStreamEvent: 'chat:stream-event',
  ChatGetHistory: 'chat:get-history',
  ChatClearHistory: 'chat:clear-history',

  ChatToggleInput: 'chat:toggle-input',

  ChatPlayUtterance: 'chat:play-utterance',

  ChatReplyCaption: 'chat:reply-caption',

  ChatReplyChunk: 'chat:reply-chunk',

  ChatShowWarning: 'chat:show-warning',

  // API key management (used by the settings window)
  ApiKeyGetStatus: 'apikey:status',
  ApiKeySet: 'apikey:set',
  ApiKeyClear: 'apikey:clear',

  // Gemini TTS key — same shape as Anthropic, separate storage slot.
  GeminiKeyGetStatus: 'gemini-key:status',
  GeminiKeySet: 'gemini-key:set',
  GeminiKeyClear: 'gemini-key:clear',

  // Comfy Cloud API key (Phase 10) — Partner-Node credential.
  ComfyCloudKeyGetStatus: 'comfy-cloud-key:status',
  ComfyCloudKeySet: 'comfy-cloud-key:set',
  ComfyCloudKeyClear: 'comfy-cloud-key:clear',

  UserPrefsGetDisplayName: 'user-prefs:get-display-name',
  UserPrefsSetDisplayName: 'user-prefs:set-display-name',

  // Gesture prefs.
  GesturePrefsGet: 'gesture-prefs:get',
  GesturePrefsSet: 'gesture-prefs:set',

  // Chat sessions (Phase 4) — managed from Settings.
  SessionsList: 'sessions:list',
  SessionsGetActive: 'sessions:get-active',
  SessionsCreate: 'sessions:create',
  SessionsActivate: 'sessions:activate',
  SessionsDelete: 'sessions:delete',
  SessionsRename: 'sessions:rename',
  SessionsClearAll: 'sessions:clear-all',

  // Greeting line + playback prefs (Phase 4).
  GreetingGet: 'greeting:get',
  GreetingSetOverride: 'greeting:set-override',
  GreetingGetPlayOnLaunch: 'greeting:get-play-on-launch',
  GreetingSetPlayOnLaunch: 'greeting:set-play-on-launch',
  GreetingTrigger: 'greeting:trigger',

  // Agent loop (Phase 5).
  AgentPrefsGet: 'agent:prefs-get',
  AgentPrefsSet: 'agent:prefs-set',
  AgentStatusGet: 'agent:status-get',
  AgentRunNow: 'agent:run-now',
  AgentPauseToggle: 'agent:pause-toggle',
  AgentStatusEvent: 'agent:status-event',
  /** Settings -> main: estimated token footprint of the assistant's memory. */
  AgentContextStatsGet: 'agent:context-stats-get',

  // Window control.
  ChatDismiss: 'chat:dismiss',
  SettingsOpen: 'settings:open',
  SettingsClose: 'settings:close',

  // Tray menu (custom HTML popup).
  TrayMenuStateEvent: 'tray-menu:state',
  TrayMenuToggleAvatar: 'tray-menu:toggle-avatar',
  TrayMenuOpenSettings: 'tray-menu:open-settings',
  TrayMenuTogglePauseAgent: 'tray-menu:toggle-pause-agent',
  TrayMenuQuit: 'tray-menu:quit',
  TrayMenuClose: 'tray-menu:close',

  // ─── Agent tools + permissions (Phase 9) ───────────────────────────
  PermissionPrefsGet: 'permission:prefs-get',
  PermissionPrefsSet: 'permission:prefs-set',
  /** Settings -> main: open a native folder picker for the workspace dir. */
  PermissionPickWorkspace: 'permission:pick-workspace',
  /** main -> permission renderer: show an approval prompt. */
  PermissionRequestEvent: 'permission:request',
  /** main -> permission renderer: computer-use status bar (or clear). */
  PermissionStatusEvent: 'permission:status',
  /** permission renderer -> main: the user's decision on a prompt. */
  PermissionRespond: 'permission:respond',
  /** permission renderer -> main: user pressed Stop during a computer-use run. */
  PermissionStop: 'permission:stop',
  /** permission renderer -> main: report content height so main can size the window. */
  PermissionResize: 'permission:resize',
  /** Settings -> main: read the recent audit-log tail. */
  AuditLogGet: 'audit:get',
  /** main -> chat renderer: dim progress line shown while a tool runs. */
  ChatToolActivity: 'chat:tool-activity',

  // ─── ComfyUI / image generation (Phase 10) ─────────────────────────
  ComfyUiPrefsGet: 'comfyui:prefs-get',
  ComfyUiPrefsSet: 'comfyui:prefs-set',
  ComfyUiTestConnection: 'comfyui:test-connection',
  ImageOverlayShow: 'image-overlay:show',
  ImageOverlayDismiss: 'image-overlay:dismiss',
  ImageOverlayResize: 'image-overlay:resize',
  ImageOverlayCopy: 'image-overlay:copy',
  ImageOverlayOpen: 'image-overlay:open',
  ImageOverlayReveal: 'image-overlay:reveal',

  // ─── Mobile pairing (Phase M-1) ────────────────────────────────────
  /** Settings -> main: mint a fresh token + return QR payload for the phone to scan. */
  PairingIssueQr: 'pairing:issue-qr',
  /** Settings -> main: list paired device ids (for display only; tokens stay secret). */
  PairingListDevices: 'pairing:list-devices',
} as const;

// ─── Renderer-facing API contracts (window.*Api) ─────────────────────
//
// Defined here so renderer projects can import them without pulling
// in preload sources. The preload scripts implement these against the
// `IpcChannels.*` constants above; the underlying brain behind the
// channels lives in `desktop/src/server/`.

export interface AvatarApi {
  requestAssets(): Promise<AssetManifest>;
  onSetTalking(handler: (payload: AvatarTalkingPayload) => void): () => void;
  onSetIdle(handler: () => void): () => void;
  sendGesture(event: GestureEvent): void;
  /** Reposition the avatar frameless window (used with Alt+pointer drag). */
  moveWindowBy(dx: number, dy: number): void;
  /** Main pushes a fresh GesturePrefs snapshot whenever the user toggles in Settings. */
  onSetGesturePrefs(handler: (prefs: GesturePrefs) => void): () => void;
  /** Bootstrap read so the renderer starts with the persisted prefs. */
  getGesturePrefs(): Promise<GesturePrefs>;
  /** Toggle the avatar window's click-through state (true = pass clicks through). */
  setMouseIgnore(ignore: boolean): void;
  /**
   * Mio swapped clothes. Renderer reloads the VRM from
   * `payload.vrmPath` and rebinds animations/gestures. Mobile
   * builds that haven't wired the wardrobe yet may omit this — the
   * renderer treats the handler as optional via `?.`.
   */
  onSetOutfit(handler: (payload: AvatarOutfitPayload) => void): () => void;
}

export interface ChatApi {
  sendMessage(text: string, options?: ChatSendOptions): Promise<void>;
  cancelStream(): void;
  onStreamEvent(handler: (event: ChatStreamEvent) => void): () => void;
  onToggleInput(handler: () => void): () => void;
  onPlayUtterance(handler: (payload: UtterancePayload) => void): () => void;
  onReplyCaption(handler: (payload: ReplyCaptionPayload) => void): () => void;
  onReplyChunk(handler: (payload: ReplyChunkPayload) => void): () => void;
  onShowWarning(handler: (message: string) => void): () => void;
  onToolActivity(handler: (payload: ChatToolActivityPayload) => void): () => void;
  getHistory(): Promise<ChatMessage[]>;
  clearHistory(): Promise<void>;
  dismiss(): void;
  openSettings(): void;
  /** Toggle the chat window's click-through state (true = pass clicks through). */
  setMouseIgnore(ignore: boolean): void;
  apiKey: {
    status(): Promise<ApiKeyStatus>;
  };
}

export interface MenuApi {
  onState(handler: (state: TrayMenuState) => void): () => void;
  toggleAvatar(): void;
  openSettings(): void;
  togglePauseAgent(): void;
  quit(): void;
  close(): void;
}

export interface SettingsApi {
  apiKey: {
    status(): Promise<ApiKeyStatus>;
    set(key: string): Promise<{ ok: boolean; error?: string }>;
    clear(): Promise<{ ok: boolean }>;
  };
  geminiKey: {
    status(): Promise<ApiKeyStatus>;
    set(key: string): Promise<{ ok: boolean; error?: string }>;
    clear(): Promise<{ ok: boolean }>;
  };
  comfyCloudKey: {
    status(): Promise<ApiKeyStatus>;
    set(key: string): Promise<{ ok: boolean; error?: string }>;
    clear(): Promise<{ ok: boolean }>;
  };
  userDisplayName: {
    get(): Promise<string>;
    set(name: string): Promise<void>;
  };
  gesturePrefs: {
    get(): Promise<GesturePrefs>;
    set(prefs: GesturePrefs): Promise<void>;
  };
  sessions: {
    list(): Promise<ChatSession[]>;
    getActive(): Promise<string | null>;
    create(): Promise<ChatSession>;
    activate(id: string): Promise<void>;
    rename(id: string, title: string): Promise<{ ok: boolean; error?: string }>;
    remove(id: string): Promise<void>;
    clearAll(): Promise<void>;
  };
  greeting: {
    get(): Promise<{ effective: string; override: string }>;
    setOverride(text: string): Promise<void>;
    getPlayOnLaunch(): Promise<boolean>;
    setPlayOnLaunch(value: boolean): Promise<void>;
    trigger(): Promise<void>;
  };
  agent: {
    prefsGet(): Promise<AgentPrefs>;
    prefsSet(prefs: AgentPrefs): Promise<AgentPrefs>;
    statusGet(): Promise<AgentStatus>;
    runNow(): Promise<void>;
    pauseToggle(): Promise<AgentStatus>;
    onStatus(handler: (status: AgentStatus) => void): () => void;
    contextStats(): Promise<MemoryContextStats>;
  };
  permission: {
    prefsGet(): Promise<PermissionPrefs>;
    prefsSet(prefs: PermissionPrefs): Promise<PermissionPrefs>;
    pickWorkspace(): Promise<string | null>;
    auditGet(): Promise<AuditEntry[]>;
  };
  comfyui: {
    prefsGet(): Promise<ComfyUiPrefs>;
    prefsSet(prefs: ComfyUiPrefs): Promise<ComfyUiPrefs>;
    testConnection(): Promise<{ ok: boolean; detail: string }>;
  };
  pairing: {
    issueQr(): Promise<MobilePairingPayload>;
    listDevices(): Promise<string[]>;
  };
  close(): void;
}

/**
 * Phase M-1 pairing payload. The desktop mints a fresh token, embeds
 * the LAN coordinates, and renders this as a QR code in Settings. The
 * phone scans it once, stores `token` in Android Keystore under
 * `deviceId`, and reconnects directly to `ws://host:port/ws` with the
 * same `deviceId` in `auth.hello`. The `qrPngDataUri` is for inline
 * <img src> use in the Settings UI.
 */
export interface MobilePairingPayload {
  /** LAN host (best-guess primary IPv4). Hostname can also be used for mDNS. */
  host: string;
  /** Bound HTTP/WS port. */
  port: number;
  /** Fresh 32-byte token, base64url. Plain. Never persisted in plain text. */
  token: string;
  /** Pre-allocated device id the phone should send in `auth.hello`. */
  deviceId: string;
  /** Encoded payload string the QR renders. Same as the URI form below. */
  payload: string;
  /** `data:image/png;base64,…` for an <img> tag. */
  qrPngDataUri: string;
  /** Wall-clock issue time. Hint for "rotate every N min" UX. */
  issuedAt: number;
}

export interface PermissionApi {
  onRequest(handler: (req: PermissionRequest) => void): () => void;
  onStatus(handler: (status: ComputerUseStatus) => void): () => void;
  respond(response: PermissionResponse): void;
  stop(): void;
  resize(height: number): void;
}

export interface ImageOverlayApi {
  onShow(handler: (payload: ImageOverlayPayload) => void): () => void;
  dismiss(): void;
  copy(absPath: string): void;
  open(absPath: string): void;
  reveal(absPath: string): void;
  resize(width: number, height: number): void;
}
