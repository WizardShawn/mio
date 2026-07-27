import { app, BrowserWindow, dialog, ipcMain, protocol, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';

import {
  IpcChannels,
  type AgentPrefs,
  type AssetManifest,
  type ChatMessage,
  type ChatSendOptions,
  type ChatSession,
  type ComfyUiPrefs,
  type GesturePrefs,
  type MobilePairingPayload,
  type PermissionPrefs,
  type PermissionResponse,
  type ServerEventName,
  type ServerEventPayload,
} from '@shared/ipc';

import { ttsCacheDir } from '@brain/geminiTts';
import { getResolvedAssets } from '@server/methods';
import type { MioServer } from '@server/index';
import { issueToken, listPairedDeviceIds } from '@server/transport/auth';

import {
  handleImageOverlayCopy,
  handleImageOverlayDismiss,
  handleImageOverlayOpen,
  handleImageOverlayResize,
  handleImageOverlayReveal,
  showImage,
} from './imageOverlay';
import {
  handlePermissionResize,
  initPermissionPrompt,
  maybeHidePermissionWindow,
  revealPermissionWindow,
} from './permissionPrompt';
import { closeSettingsWindow, openSettingsWindow } from './windows';

// Thin Electron-IPC ↔ server-method shim. Every IPC channel below
// delegates to a function in `server.methods.X`. Push-side server
// events are forwarded to the relevant renderers via the event bus
// subscription set up in `subscribeBusToRenderers`.
//
// Window-management concerns that genuinely require Electron (settings
// window open/close, tray menu actions, native dialog, image overlay
// UX) are handled directly here and DO NOT pass through the brain.

const PROTOCOL = 'cortana-asset';
const PROTOCOL_HOST_LOCAL = 'local';
const PROTOCOL_HOST_AUDIO = 'audio';

// Renderer pages load from http://localhost (dev) or file:// (prod), so
// every fetch() of a cortana-asset:// URL is cross-origin. Without an
// explicit CORS grant Chromium rejects the response as "Failed to fetch"
// before the body is read — so the scheme is registered corsEnabled and
// every response below carries this header.
const ASSET_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
};

function assetAbsToUrl(rootDir: string, abs: string): string {
  const rel = path.relative(rootDir, abs).split(path.sep).join('/');
  return `${PROTOCOL}://${PROTOCOL_HOST_LOCAL}/${encodeURI(rel)}`;
}

function manifestToUrls(rootDir: string, manifest: AssetManifest): AssetManifest {
  const toUrl = (abs: string): string => assetAbsToUrl(rootDir, abs);
  return {
    vrmPath: manifest.vrmPath ? toUrl(manifest.vrmPath) : null,
    idleAnimations: manifest.idleAnimations.map(toUrl),
    talkingAnimations: manifest.talkingAnimations.map(toUrl),
    extrasAnimations: manifest.extrasAnimations.map(toUrl),
    outfits: (manifest.outfits ?? []).map((o) => ({
      id: o.id,
      label: o.label,
      vrmPath: toUrl(o.vrmPath),
    })),
    activeOutfitId: manifest.activeOutfitId,
  };
}

export function registerAssetProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
  ]);
}

export function registerAssetProtocolHandler(session: Session): void {
  session.protocol.handle(PROTOCOL, (request) => {
    try {
      const url = new URL(request.url);
      const host = url.host || PROTOCOL_HOST_LOCAL;
      const rootDir =
        host === PROTOCOL_HOST_AUDIO ? ttsCacheDir() : getResolvedAssets().rootDir;
      if (host !== PROTOCOL_HOST_LOCAL && host !== PROTOCOL_HOST_AUDIO) {
        return new Response('Forbidden host', { status: 403, headers: ASSET_CORS });
      }
      const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const abs = path.normalize(path.join(rootDir, relPath));
      const safeRoot = path.normalize(rootDir + path.sep);
      if (!abs.startsWith(safeRoot)) {
        return new Response('Forbidden', { status: 403, headers: ASSET_CORS });
      }
      if (!fs.existsSync(abs)) {
        console.warn(`[asset-protocol] 404 ${request.url} -> ${abs}`);
        return new Response('Not found', { status: 404, headers: ASSET_CORS });
      }
      const data = fs.readFileSync(abs);
      const lower = abs.toLowerCase();
      let mime = 'application/octet-stream';
      if (lower.endsWith('.vrm') || lower.endsWith('.vrma')) mime = 'model/gltf-binary';
      else if (lower.endsWith('.wav')) mime = 'audio/wav';
      else if (lower.endsWith('.mp3')) mime = 'audio/mpeg';
      else if (lower.endsWith('.ogg')) mime = 'audio/ogg';
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
          ...ASSET_CORS,
        },
      });
    } catch (err) {
      console.error('[asset-protocol] error', err);
      return new Response('Internal error', { status: 500, headers: ASSET_CORS });
    }
  });
}

export interface IpcShimDeps {
  avatar: BrowserWindow;
  chat: BrowserWindow;
  menu: BrowserWindow;
  permission: BrowserWindow;
  imageOverlay: BrowserWindow;
  server: MioServer;
  /** Phase M-1: read at QR-pair time so the QR encodes the live LAN port. */
  getLanPort: () => number | null;
}

/**
 * Wire IPC handlers + brain-event subscriptions for the desktop
 * renderers. Call once after window creation; tears down implicitly
 * with the app lifetime.
 */
export function registerIpcShim(deps: IpcShimDeps): void {
  const { server } = deps;
  const m = server.methods;

  initPermissionPrompt(deps.permission);

  // ─── Avatar window control (genuine desktop concern) ───────────────
  ipcMain.on(
    IpcChannels.AvatarMoveWindowBy,
    (event, dx: number, dy: number) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      win.setPosition(Math.round(x + dx), Math.round(y + dy));
    },
  );

  ipcMain.handle(IpcChannels.AvatarRequestAssets, (): AssetManifest => {
    const { rootDir } = getResolvedAssets();
    return manifestToUrls(rootDir, m.avatarRequestAssets());
  });

  // Click-through toggle for the transparent overlay windows (avatar +
  // chat). The renderer flips this as the cursor moves on/off its
  // interactive areas; `forward: true` keeps mouse-move events flowing
  // so the renderer can keep hit-testing while the window is ignoring.
  ipcMain.on(IpcChannels.WindowSetMouseIgnore, (event, ignore: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  // ─── Chat ──────────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannels.ChatSendMessage,
    async (_event, text: string, options?: ChatSendOptions) => {
      await m.chatSend({ text, options });
    },
  );

  ipcMain.on(IpcChannels.ChatCancel, () => {
    m.chatCancel();
  });

  ipcMain.handle(IpcChannels.ChatGetHistory, (): ChatMessage[] => {
    return m.chatGetHistory();
  });

  ipcMain.handle(IpcChannels.ChatClearHistory, () => {
    m.chatClearHistory();
  });

  // Chat dismiss is purely a desktop window-focus concern.
  ipcMain.on(IpcChannels.ChatDismiss, () => {
    if (deps.chat.isDestroyed()) return;
    if (deps.chat.isFocused() && !deps.avatar.isDestroyed()) {
      deps.avatar.focus();
    }
  });

  ipcMain.on(IpcChannels.AvatarGesture, (_event, gesture: unknown) => {
    m.chatGesture({ event: gesture as never });
  });

  // ─── API keys ──────────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.ApiKeyGetStatus, () => m.apiKeyGetStatus());
  ipcMain.handle(IpcChannels.ApiKeySet, (_event, key: string) => m.apiKeySet({ key }));
  ipcMain.handle(IpcChannels.ApiKeyClear, () => m.apiKeyClear());

  ipcMain.handle(IpcChannels.GeminiKeyGetStatus, () => m.geminiKeyGetStatus());
  ipcMain.handle(IpcChannels.GeminiKeySet, (_event, key: string) => m.geminiKeySet({ key }));
  ipcMain.handle(IpcChannels.GeminiKeyClear, () => m.geminiKeyClear());

  ipcMain.handle(IpcChannels.ComfyCloudKeyGetStatus, () => m.comfyCloudKeyGetStatus());
  ipcMain.handle(IpcChannels.ComfyCloudKeySet, (_event, key: string) =>
    m.comfyCloudKeySet({ key }),
  );
  ipcMain.handle(IpcChannels.ComfyCloudKeyClear, () => m.comfyCloudKeyClear());

  ipcMain.handle(IpcChannels.UserPrefsGetDisplayName, () => m.userPrefsGetDisplayName());
  ipcMain.handle(IpcChannels.UserPrefsSetDisplayName, (_event, name: string) => {
    m.userPrefsSetDisplayName({ name });
  });

  ipcMain.handle(IpcChannels.GesturePrefsGet, () => m.gesturePrefsGet());
  ipcMain.handle(IpcChannels.GesturePrefsSet, (_event, prefs: GesturePrefs) => {
    m.gesturePrefsSet({ prefs });
  });

  // ─── Chat sessions ─────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.SessionsList, (): ChatSession[] => m.sessionsList());
  ipcMain.handle(IpcChannels.SessionsGetActive, (): string | null => m.sessionsGetActive());
  ipcMain.handle(IpcChannels.SessionsCreate, async (): Promise<ChatSession> => {
    return m.sessionsCreate();
  });
  ipcMain.handle(IpcChannels.SessionsActivate, (_event, id: string) => {
    m.sessionsActivate({ id });
  });
  ipcMain.handle(
    IpcChannels.SessionsRename,
    (_event, id: string, title: string) => m.sessionsRename({ id, title }),
  );

  // Sessions delete: native confirmation BEFORE invoking the brain.
  ipcMain.handle(IpcChannels.SessionsDelete, async (_event, id: string) => {
    const sessions = m.sessionsList();
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete session',
      message: `Delete "${target.title}"?`,
      detail: 'This permanently removes its messages from disk.',
    });
    if (result.response !== 1) return;
    m.sessionsDelete({ id });
  });

  ipcMain.handle(IpcChannels.SessionsClearAll, async () => {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Clear everything'],
      defaultId: 0,
      cancelId: 0,
      title: 'Clear all sessions',
      message: 'Delete ALL chat sessions?',
      detail: 'This wipes every conversation from disk. Cannot be undone.',
    });
    if (result.response !== 1) return;
    m.sessionsClearAll();
  });

  // ─── Greeting ──────────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.GreetingGet, () => m.greetingGet());
  ipcMain.handle(IpcChannels.GreetingSetOverride, (_event, text: string) => {
    m.greetingSetOverride({ text });
  });
  ipcMain.handle(IpcChannels.GreetingGetPlayOnLaunch, () => m.greetingGetPlayOnLaunch());
  ipcMain.handle(IpcChannels.GreetingSetPlayOnLaunch, (_event, value: boolean) => {
    m.greetingSetPlayOnLaunch({ value });
  });
  ipcMain.handle(IpcChannels.GreetingTrigger, async () => {
    await m.greetingTrigger();
  });

  // ─── Agent loop ────────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.AgentPrefsGet, () => m.agentPrefsGet());
  ipcMain.handle(IpcChannels.AgentPrefsSet, (_event, prefs: AgentPrefs) => {
    return m.agentPrefsSet({ prefs });
  });
  ipcMain.handle(IpcChannels.AgentStatusGet, () => m.agentStatusGet());
  ipcMain.handle(IpcChannels.AgentRunNow, async () => {
    await m.agentRunNow();
  });
  ipcMain.handle(IpcChannels.AgentPauseToggle, () => m.agentPauseToggle());
  ipcMain.handle(IpcChannels.AgentContextStatsGet, () => m.agentContextStatsGet());

  // ─── Agent tools + permissions ─────────────────────────────────────
  ipcMain.handle(IpcChannels.PermissionPrefsGet, () => m.permissionPrefsGet());
  ipcMain.handle(
    IpcChannels.PermissionPrefsSet,
    (_event, prefs: PermissionPrefs) => m.permissionPrefsSet({ prefs }),
  );
  ipcMain.handle(
    IpcChannels.PermissionPickWorkspace,
    async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        title: "Choose Mio's workspace folder",
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );
  ipcMain.handle(IpcChannels.AuditLogGet, () => m.permissionAuditGet());

  ipcMain.on(
    IpcChannels.PermissionRespond,
    (_event, response: PermissionResponse) => {
      m.permissionRespond({ response });
      maybeHidePermissionWindow();
    },
  );
  ipcMain.on(IpcChannels.PermissionStop, () => m.permissionStop());
  ipcMain.on(IpcChannels.PermissionResize, (_event, height: number) => {
    if (typeof height === 'number') handlePermissionResize(height);
  });

  // ─── ComfyUI ───────────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.ComfyUiPrefsGet, () => m.comfyuiPrefsGet());
  ipcMain.handle(
    IpcChannels.ComfyUiPrefsSet,
    (_event, prefs: ComfyUiPrefs) => m.comfyuiPrefsSet({ prefs }),
  );
  ipcMain.handle(IpcChannels.ComfyUiTestConnection, async () => {
    return m.comfyuiTestConnection();
  });

  // Image overlay popup — desktop window concern.
  ipcMain.on(IpcChannels.ImageOverlayDismiss, () => handleImageOverlayDismiss());
  ipcMain.on(
    IpcChannels.ImageOverlayResize,
    (_event, width: number, height: number) => {
      if (typeof width === 'number' && typeof height === 'number') {
        handleImageOverlayResize(width, height);
      }
    },
  );
  ipcMain.on(IpcChannels.ImageOverlayCopy, (_event, absPath: string) => {
    if (typeof absPath === 'string') handleImageOverlayCopy(absPath);
  });
  ipcMain.on(IpcChannels.ImageOverlayOpen, (_event, absPath: string) => {
    if (typeof absPath === 'string') handleImageOverlayOpen(absPath);
  });
  ipcMain.on(IpcChannels.ImageOverlayReveal, (_event, absPath: string) => {
    if (typeof absPath === 'string') handleImageOverlayReveal(absPath);
  });

  // ─── Window control ────────────────────────────────────────────────
  ipcMain.on(IpcChannels.SettingsOpen, () => openSettingsWindow());
  ipcMain.on(IpcChannels.SettingsClose, () => closeSettingsWindow());

  // ─── Tray menu (custom HTML popup) ─────────────────────────────────
  const hideMenu = (): void => {
    if (!deps.menu.isDestroyed() && deps.menu.isVisible()) deps.menu.hide();
  };

  ipcMain.on(IpcChannels.TrayMenuToggleAvatar, () => {
    if (!deps.avatar.isDestroyed()) {
      if (deps.avatar.isVisible()) deps.avatar.hide();
      else deps.avatar.show();
    }
    hideMenu();
  });

  ipcMain.on(IpcChannels.TrayMenuOpenSettings, () => {
    openSettingsWindow();
    hideMenu();
  });

  ipcMain.on(IpcChannels.TrayMenuTogglePauseAgent, () => {
    m.agentPauseToggle();
    hideMenu();
  });

  ipcMain.on(IpcChannels.TrayMenuQuit, () => {
    hideMenu();
    app.quit();
  });

  ipcMain.on(IpcChannels.TrayMenuClose, () => {
    hideMenu();
  });

  // ─── Mobile pairing (Phase M-1) ──────────────────────────────────
  ipcMain.handle(
    IpcChannels.PairingIssueQr,
    async (): Promise<MobilePairingPayload> => {
      const port = deps.getLanPort();
      if (!port) {
        throw new Error(
          'LAN server not running yet — wait a moment after launch and retry.',
        );
      }
      const host = pickPrimaryLanIp() ?? '127.0.0.1';
      const deviceId = `mobile-${randomUUID().slice(0, 8)}`;
      const token = issueToken(deviceId);
      const payload = encodePairingUri({ host, port, token, deviceId });
      const qrPngDataUri = await QRCode.toDataURL(payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 8,
        color: {
          // Dark navy on cream so the QR is camera-friendly even on
          // desks with bias lighting; matches the app's accent palette.
          dark: '#12141bff',
          light: '#f5efe2ff',
        },
      });
      return {
        host,
        port,
        token,
        deviceId,
        payload,
        qrPngDataUri,
        issuedAt: Date.now(),
      };
    },
  );

  ipcMain.handle(
    IpcChannels.PairingListDevices,
    (): string[] => listPairedDeviceIds(),
  );

  subscribeBusToRenderers(deps);
}

/**
 * Pick a sensible LAN IPv4 to embed in the pairing QR. We avoid
 * loopback and link-local; if the host has multiple non-loopback
 * NICs (e.g. Wi-Fi + virtual switch), we prefer common private
 * ranges in this order: 192.168.x, 10.x, 172.16-31.x, then anything
 * else. Returns `null` if nothing usable is found — caller falls
 * back to `127.0.0.1` and the user can re-pair on the same device.
 */
function pickPrimaryLanIp(): string | null {
  const score = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 4;
    if (ip.startsWith('10.')) return 3;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
    return 1;
  };
  let best: { ip: string; score: number } | null = null;
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.internal) continue;
      if (info.family !== 'IPv4') continue;
      const s = score(info.address);
      if (!best || s > best.score) best = { ip: info.address, score: s };
    }
  }
  return best ? best.ip : null;
}

/**
 * Encode the pairing payload as a `mio://pair?…` URI. Compact, easy
 * to parse on Android (`Uri.parse`), and the scheme makes the QR
 * self-describing if a generic scanner reads it. The token is URL-
 * safe base64 (`base64url`) so no escaping needed.
 */
function encodePairingUri(args: {
  host: string;
  port: number;
  token: string;
  deviceId: string;
}): string {
  const params = new URLSearchParams({
    h: args.host,
    p: String(args.port),
    t: args.token,
    d: args.deviceId,
    v: '0',
  });
  return `mio://pair?${params.toString()}`;
}

/**
 * Forward every brain-emitted event to the relevant Electron renderer
 * over the legacy IpcChannels.* constants so the existing renderer
 * code (and its `contextBridge` preload) keeps working unchanged.
 */
function subscribeBusToRenderers(deps: IpcShimDeps): void {
  const { server } = deps;

  // Surface-routed chat events (stream / caption / chunk / tool
  // activity / talking animation) carry `meta.origin = 'mobile'` when
  // the turn was initiated from a paired phone. The desktop chat pill
  // should NOT mirror those — the user is holding the phone, not
  // looking at the desktop — so this helper drops mobile-origin
  // events before forwarding. Events with no `origin` (greeting,
  // agent loop cycles, gesture prefs push) still reach the desktop.
  const sendChat = <E extends ServerEventName>(channel: string) =>
    (payload: ServerEventPayload<E>, meta: { origin?: string }): void => {
      if (meta.origin === 'mobile') return;
      if (deps.chat.isDestroyed()) return;
      deps.chat.webContents.send(channel, payload);
    };

  const broadcast = <E extends ServerEventName>(channel: string) =>
    (payload: ServerEventPayload<E>): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    };

  // Chat-window events.
  server.eventBus.on('chat.stream', sendChat<'chat.stream'>(IpcChannels.ChatStreamEvent));
  server.eventBus.on('chat.replyCaption', sendChat<'chat.replyCaption'>(IpcChannels.ChatReplyCaption));
  server.eventBus.on('chat.replyChunk', sendChat<'chat.replyChunk'>(IpcChannels.ChatReplyChunk));
  server.eventBus.on('chat.toolActivity', sendChat<'chat.toolActivity'>(IpcChannels.ChatToolActivity));
  server.eventBus.on('chat.playUtterance', sendChat<'chat.playUtterance'>(IpcChannels.ChatPlayUtterance));
  server.eventBus.on('chat.showWarning', (payload) => {
    if (deps.chat.isDestroyed()) return;
    deps.chat.webContents.send(IpcChannels.ChatShowWarning, payload.message);
  });
  server.eventBus.on('chat.toggleInput', () => {
    if (deps.chat.isDestroyed()) return;
    deps.chat.webContents.send(IpcChannels.ChatToggleInput);
  });

  // Avatar-window events.
  server.eventBus.on('avatar.setTalking', (payload, meta) => {
    // Same routing rule as the chat pill: a mobile-driven turn animates
    // the phone's avatar but the desktop's avatar stays idle — there's
    // no audio or caption on the desktop side to match.
    if (meta.origin === 'mobile') return;
    if (deps.avatar.isDestroyed()) return;
    deps.avatar.webContents.send(IpcChannels.AvatarSetTalking, payload);
  });
  server.eventBus.on('avatar.setIdle', (_payload, meta) => {
    if (meta.origin === 'mobile') return;
    if (deps.avatar.isDestroyed()) return;
    deps.avatar.webContents.send(IpcChannels.AvatarSetIdle);
  });
  server.eventBus.on('avatar.setGesturePrefs', (payload) => {
    if (deps.avatar.isDestroyed()) return;
    deps.avatar.webContents.send(IpcChannels.AvatarSetGesturePrefs, payload);
  });
  // Outfit-swap pushes carry an absolute filesystem path from the
  // brain; rewrite it to `cortana-asset://` so the renderer can fetch
  // it through the privileged scheme (raw `file://` would be blocked
  // by the same CORS policy that makes plain renderer fetch fail).
  server.eventBus.on('avatar.setOutfit', (payload) => {
    if (deps.avatar.isDestroyed()) return;
    const { rootDir } = getResolvedAssets();
    deps.avatar.webContents.send(IpcChannels.AvatarSetOutfit, {
      outfitId: payload.outfitId,
      label: payload.label,
      vrmPath: assetAbsToUrl(rootDir, payload.vrmPath),
    });
  });

  // Agent status — broadcast to every window (Settings page + chat HUD).
  server.eventBus.on('agent.status', broadcast<'agent.status'>(IpcChannels.AgentStatusEvent));

  // Tray menu state.
  server.eventBus.on('trayMenu.state', (payload) => {
    if (deps.menu.isDestroyed()) return;
    deps.menu.webContents.send(IpcChannels.TrayMenuStateEvent, payload);
  });

  // Permission popup events go to the dedicated permission window.
  server.eventBus.on('permission.request', (payload) => {
    if (deps.permission.isDestroyed()) return;
    deps.permission.webContents.send(IpcChannels.PermissionRequestEvent, payload);
    revealPermissionWindow();
  });
  server.eventBus.on('permission.status', (payload) => {
    if (deps.permission.isDestroyed()) return;
    deps.permission.webContents.send(IpcChannels.PermissionStatusEvent, payload);
    if (payload.active) revealPermissionWindow();
    else maybeHidePermissionWindow();
  });

  // Image overlay — call into the desktop-owned overlay manager.
  server.eventBus.on('imageOverlay.show', (payload) => {
    showImage(payload);
  });
}
