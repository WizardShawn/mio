// Host adapter — the brain's view of "the machine it's running on."
//
// Everything in `src/server/brain/**` is forbidden to import
// from `electron` (verified by grep in CI). Instead, we centralise
// every platform-specific capability behind this `HostAdapter` shape
// and let the main process supply the Electron-backed implementation
// at boot. A headless / cross-platform server would just supply a
// different `HostAdapter` (e.g. Node-only `fetch`, in-memory secrets,
// no-op sensors) without touching brain code.
//
// Adapter scope is deliberately small: paths, secret storage, sensors,
// notification, network. User-facing dialogs (folder picker, confirm
// boxes) are NOT here — those are owned by the IPC shim layer because
// they need to know which BrowserWindow to attach to, and they aren't
// brain logic anyway (the brain receives the result of the dialog as
// a method argument).

export interface HostPaths {
  /** Per-user mutable state. Hosts our SQLite DB, TTS audio cache, tokens, audit log. */
  userData: string;
  /** Read-only application root; in dev this is the project root, in prod it's inside the asar. */
  appPath: string;
  /** Bundled `extraResources` (persona, VRM, animations, pw-browsers); only meaningful in packaged builds. */
  resourcesPath: string;
  /** Per-user OS temp dir for transient artefacts (e.g. Playwright user data). */
  tempPath: string;
  /** OS Documents folder; used as the default workspace path for the agent's file tools. */
  documents: string;
  /** True when running inside a packaged Electron build (resourcesPath is meaningful). */
  isPackaged: boolean;
}

export interface SecretStorage {
  /** True when the OS keychain (DPAPI on Windows) is reachable. */
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(blob: Buffer): string;
}

/** A frame ready to drop into a Claude `image` block. */
export interface CapturedImage {
  mediaType: 'image/jpeg';
  data: string;
  width: number;
  height: number;
  displayId: number;
}

export interface SensorAdapter {
  capturePrimaryScreen(): Promise<CapturedImage | null>;
  captureAllScreens(): Promise<CapturedImage[]>;
  /** Windows-only foreground-window title; null on other platforms. */
  getActiveWindowTitle(): Promise<string | null>;
}

export interface HostNotifier {
  /** Best-effort native toast. Silently drops if unsupported. */
  notify(opts: { title: string; body: string }): void;
}

/**
 * HTTP client used by the brain's outbound calls (Gemini, ComfyUI).
 * The Electron implementation wraps `net.fetch` so requests honour
 * the system proxy + cert store; a headless implementation can pass
 * `globalThis.fetch` straight through.
 */
export interface HostNet {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** Primary-display metadata needed by `computerUse/`. */
export interface PrimaryDisplayInfo {
  /** Logical pixel size as the OS reports it. */
  width: number;
  height: number;
  /** Physical/logical ratio (1.5 on a 150% scaled HiDPI laptop). */
  scaleFactor: number;
}

export interface ComputerHost {
  getPrimaryDisplayInfo(): PrimaryDisplayInfo;
}

export interface HostAdapter {
  paths: HostPaths;
  secrets: SecretStorage;
  sensors: SensorAdapter;
  notifier: HostNotifier;
  net: HostNet;
  computer: ComputerHost;
}

// ─── Process-wide singleton ─────────────────────────────────────────
//
// The brain modules don't take `HostAdapter` as a constructor arg
// (most of them are top-level singletons exported by-name today —
// `chatService`, `agentLoop`, `recall`, etc.). Rather than thread
// the adapter through every function signature, we make it a one-
// shot global wired at server boot.

let installed: HostAdapter | null = null;

export function installHost(adapter: HostAdapter): void {
  if (installed) {
    throw new Error('HostAdapter already installed; call installHost exactly once at boot.');
  }
  installed = adapter;
}

export function getHost(): HostAdapter {
  if (!installed) {
    throw new Error(
      'HostAdapter not installed. Call installHost(adapter) in server/index.ts before importing any brain module.',
    );
  }
  return installed;
}

/** Test-only escape hatch; never call from app code. */
export function __resetHostForTests(): void {
  installed = null;
}
