import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentPrefs,
  ComfyUiPrefs,
  GesturePrefs,
  PermissionMode,
  PermissionPrefs,
} from '@shared/protocol';

import { getHost } from './host';

/** Plain JSON in userData — not sensitive; only how the assistant addresses the user. */
const PREF_FILE_NAME = 'user-preferences.json';

interface UserPreferences {
  userDisplayName: string;
  gesturePrefs: GesturePrefs;
  /** Active chat session id; null until first session is created. */
  activeSessionId: string | null;
  /**
   * Optional override for the startup greeting. Empty string means use
   * the line parsed out of `persona.md` (`## On startup` quoted text).
   */
  greetingOverride: string;
  /** Play the cached greeting on app launch (in addition to "new session"). */
  greetOnLaunch: boolean;
  agentPrefs: AgentPrefs;
  /** Phase 9 — agent tool layer + permission gate configuration. */
  permissionPrefs: PermissionPrefs;
  /** Phase 10 — ComfyUI server URL + image-cap knobs. */
  comfyuiPrefs: ComfyUiPrefs;
  /**
   * Wardrobe — id of the outfit Mio is currently wearing. `null`
   * means "no choice persisted yet"; the asset resolver picks the
   * first outfit alphabetically in that case. Survives restarts so
   * a kimono-night doesn't snap back to the white skirt on relaunch.
   */
  currentOutfitId: string | null;
}

const DEFAULT_GESTURE_PREFS: GesturePrefs = {
  gesturesEnabled: true,
};

const DEFAULT_AGENT_PREFS: AgentPrefs = {
  enabled: false,
  intervalMinutes: 10,
  dailyCostCapUsd: 5,
  hourlyCycleCap: 12,
  hourlyNotifyCap: 4,
  notableCheckInChat: false,
  // Phase-5 cost-saver — the M-3 default was `'both'` (capture the
  // desktop screen AND a phone back-cam frame on every implicit
  // tick). That ships two ~`2k-token` images on every chat turn and
  // every cycle, which roughly doubles per-call vision cost and the
  // payload re-bills on every tool round. The new default ships only
  // the desktop screenshot — operators who want the room-view leg
  // can opt into `'mobile-priority'` or `'both'` from Settings.
  perceptionMode: 'desktop-only',
};

const DEFAULT_SENSITIVE_APPS: string[] = [
  'bank',
  'paypal',
  'wallet',
  'password',
  'keepass',
  'bitwarden',
  '1password',
  'wechat',
  'whatsapp',
  'telegram',
  'outlook',
  'gmail',
  'cmd.exe',
  'powershell',
  'terminal',
  'registry editor',
  'control panel',
];

function defaultWorkspacePath(): string {
  const host = getHost();
  try {
    return path.join(host.paths.documents, 'Mio');
  } catch {
    return path.join(host.paths.userData, 'workspace');
  }
}

function defaultPermissionPrefs(): PermissionPrefs {
  return {
    toolsEnabled: true,
    mode: 'guarded',
    workspacePath: defaultWorkspacePath(),
    sensitiveApps: [...DEFAULT_SENSITIVE_APPS],
    allowlist: [],
    denylistExtras: [],
  };
}

const DEFAULT_COMFYUI_PREFS: ComfyUiPrefs = {
  enabled: false,
  serverUrl: 'http://127.0.0.1:8000',
  dailyImageCap: 50,
  imageOverlayAutoDismissSec: 60,
};

function defaultPrefs(): UserPreferences {
  return {
    userDisplayName: '',
    gesturePrefs: { ...DEFAULT_GESTURE_PREFS },
    activeSessionId: null,
    greetingOverride: '',
    greetOnLaunch: true,
    agentPrefs: { ...DEFAULT_AGENT_PREFS },
    permissionPrefs: defaultPermissionPrefs(),
    comfyuiPrefs: { ...DEFAULT_COMFYUI_PREFS },
    currentOutfitId: null,
  };
}

function prefFilePath(): string {
  return path.join(getHost().paths.userData, PREF_FILE_NAME);
}

let cache: UserPreferences | null = null;

function coerceGesturePrefs(gp: Partial<GesturePrefs> | undefined): GesturePrefs {
  return {
    gesturesEnabled:
      typeof gp?.gesturesEnabled === 'boolean'
        ? gp.gesturesEnabled
        : DEFAULT_GESTURE_PREFS.gesturesEnabled,
  };
}

const PERCEPTION_MODES = new Set([
  'desktop-only',
  'mobile-priority',
  'mobile-only',
  'both',
]);

function coerceAgentPrefs(ap: Partial<AgentPrefs> | undefined): AgentPrefs {
  const safeNum = (val: unknown, fallback: number, min: number): number => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    return Math.max(min, val);
  };
  return {
    enabled: typeof ap?.enabled === 'boolean' ? ap.enabled : DEFAULT_AGENT_PREFS.enabled,
    intervalMinutes: safeNum(ap?.intervalMinutes, DEFAULT_AGENT_PREFS.intervalMinutes, 1),
    dailyCostCapUsd: safeNum(ap?.dailyCostCapUsd, DEFAULT_AGENT_PREFS.dailyCostCapUsd, 0),
    hourlyCycleCap: safeNum(ap?.hourlyCycleCap, DEFAULT_AGENT_PREFS.hourlyCycleCap, 1),
    hourlyNotifyCap: safeNum(ap?.hourlyNotifyCap, DEFAULT_AGENT_PREFS.hourlyNotifyCap, 0),
    notableCheckInChat:
      typeof ap?.notableCheckInChat === 'boolean'
        ? ap.notableCheckInChat
        : DEFAULT_AGENT_PREFS.notableCheckInChat,
    perceptionMode:
      typeof ap?.perceptionMode === 'string' && PERCEPTION_MODES.has(ap.perceptionMode)
        ? ap.perceptionMode
        : DEFAULT_AGENT_PREFS.perceptionMode,
  };
}

function coercePermissionPrefs(
  pp: Partial<PermissionPrefs> | undefined,
): PermissionPrefs {
  const def = defaultPermissionPrefs();
  const strArray = (val: unknown, fallback: string[]): string[] =>
    Array.isArray(val)
      ? val.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : fallback;
  const mode: PermissionMode =
    pp?.mode === 'autopilot' || pp?.mode === 'readonly' || pp?.mode === 'guarded'
      ? pp.mode
      : def.mode;
  return {
    toolsEnabled:
      typeof pp?.toolsEnabled === 'boolean' ? pp.toolsEnabled : def.toolsEnabled,
    mode,
    workspacePath:
      typeof pp?.workspacePath === 'string' && pp.workspacePath.trim().length > 0
        ? pp.workspacePath
        : def.workspacePath,
    sensitiveApps: strArray(pp?.sensitiveApps, def.sensitiveApps),
    allowlist: strArray(pp?.allowlist, def.allowlist),
    denylistExtras: strArray(pp?.denylistExtras, def.denylistExtras),
  };
}

function coerceComfyUiPrefs(
  cu: Partial<ComfyUiPrefs> | undefined,
): ComfyUiPrefs {
  const def = DEFAULT_COMFYUI_PREFS;
  const safeNum = (val: unknown, fallback: number, min: number): number => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    return Math.max(min, Math.floor(val));
  };
  let serverUrl =
    typeof cu?.serverUrl === 'string' && cu.serverUrl.trim().length > 0
      ? cu.serverUrl.trim()
      : def.serverUrl;
  serverUrl = serverUrl.replace(/\/+$/, '');
  return {
    enabled: typeof cu?.enabled === 'boolean' ? cu.enabled : def.enabled,
    serverUrl,
    dailyImageCap: safeNum(cu?.dailyImageCap, def.dailyImageCap, 0),
    imageOverlayAutoDismissSec: safeNum(
      cu?.imageOverlayAutoDismissSec,
      def.imageOverlayAutoDismissSec,
      5,
    ),
  };
}

function load(): UserPreferences {
  if (cache) return cache;
  const file = prefFilePath();
  if (!fs.existsSync(file)) {
    cache = defaultPrefs();
    return cache;
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    cache = {
      userDisplayName:
        typeof parsed.userDisplayName === 'string' ? parsed.userDisplayName : '',
      gesturePrefs: coerceGesturePrefs(parsed.gesturePrefs),
      activeSessionId:
        typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
      greetingOverride:
        typeof parsed.greetingOverride === 'string' ? parsed.greetingOverride : '',
      greetOnLaunch:
        typeof parsed.greetOnLaunch === 'boolean' ? parsed.greetOnLaunch : true,
      agentPrefs: coerceAgentPrefs(parsed.agentPrefs),
      permissionPrefs: coercePermissionPrefs(parsed.permissionPrefs),
      comfyuiPrefs: coerceComfyUiPrefs(parsed.comfyuiPrefs),
      currentOutfitId:
        typeof parsed.currentOutfitId === 'string' && parsed.currentOutfitId.length > 0
          ? parsed.currentOutfitId
          : null,
    };
  } catch {
    cache = defaultPrefs();
  }
  return cache;
}

function save(prefs: UserPreferences): void {
  cache = prefs;
  fs.writeFileSync(prefFilePath(), JSON.stringify(prefs, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Value as stored (trimmed on save). Empty string if unset. */
export function getUserDisplayName(): string {
  return load().userDisplayName;
}

export function setUserDisplayName(name: string): void {
  const trimmed = name.trim();
  const current = load();
  save({ ...current, userDisplayName: trimmed });
}

export function getGesturePrefs(): GesturePrefs {
  return { ...load().gesturePrefs };
}

/**
 * Persist a new gesture-prefs snapshot. Returns the normalised value
 * actually written (caller may have passed `unknown`-shaped data from
 * IPC; we coerce to the typed defaults).
 */
export function setGesturePrefs(prefs: GesturePrefs): GesturePrefs {
  const next = coerceGesturePrefs(prefs);
  const current = load();
  save({ ...current, gesturePrefs: next });
  return next;
}

export function getActiveSessionId(): string | null {
  return load().activeSessionId;
}

export function setActiveSessionId(id: string | null): void {
  const current = load();
  save({ ...current, activeSessionId: id });
}

export function getGreetingOverride(): string {
  return load().greetingOverride;
}

export function setGreetingOverride(value: string): void {
  const current = load();
  save({ ...current, greetingOverride: value });
}

export function getGreetOnLaunch(): boolean {
  return load().greetOnLaunch;
}

export function setGreetOnLaunch(value: boolean): void {
  const current = load();
  save({ ...current, greetOnLaunch: !!value });
}

export function getAgentPrefs(): AgentPrefs {
  return { ...load().agentPrefs };
}

export function setAgentPrefs(prefs: AgentPrefs): AgentPrefs {
  const next = coerceAgentPrefs(prefs);
  const current = load();
  save({ ...current, agentPrefs: next });
  return next;
}

export function getPermissionPrefs(): PermissionPrefs {
  return { ...load().permissionPrefs };
}

export function setPermissionPrefs(prefs: PermissionPrefs): PermissionPrefs {
  const next = coercePermissionPrefs(prefs);
  const current = load();
  save({ ...current, permissionPrefs: next });
  return next;
}

export function getComfyUiPrefs(): ComfyUiPrefs {
  return { ...load().comfyuiPrefs };
}

export function setComfyUiPrefs(prefs: ComfyUiPrefs): ComfyUiPrefs {
  const next = coerceComfyUiPrefs(prefs);
  const current = load();
  save({ ...current, comfyuiPrefs: next });
  return next;
}

/** Last outfit id Mio picked. `null` until `change_clothes` runs. */
export function getCurrentOutfitId(): string | null {
  return load().currentOutfitId;
}

export function setCurrentOutfitId(id: string | null): void {
  const current = load();
  const next = typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  save({ ...current, currentOutfitId: next });
}
