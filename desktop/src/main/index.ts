import { app, BrowserWindow, session } from 'electron';

import { agentLoop } from '@brain/agent';
import { ensureUserAssetDirs } from '@brain/assets';
import { chatService } from '@brain/chatService';
import {
  createSession,
  getSession,
  listSessions,
} from '@brain/chatStore';
import { closeBrowser } from '@brain/tools/browserTool';
import {
  getActiveSessionId,
  setActiveSessionId,
} from '@brain/userPreferences';
import { welcomeOnLaunch } from '@brain/welcomeBack';
import { createServer, type MioServer } from '@server/index';
import { startHttpTransport } from '@server/transport/http';
import { startMdnsAnnounce, stopMdnsAnnounce } from '@server/transport/mdns';
import { startWsTransport } from '@server/transport/ws';

import { registerHotkeys } from './hotkey';
import { buildElectronHostAdapter } from './hostAdapter';
import { initImageOverlay } from './imageOverlay';
import {
  registerAssetProtocolHandler,
  registerAssetProtocolScheme,
  registerIpcShim,
} from './ipcShim';
import { createTray, type TrayController } from './tray';
import {
  createAvatarWindow,
  createChatWindow,
  createImageOverlayWindow,
  createMenuWindow,
  createPermissionWindow,
  refreshAssistantZOrder,
  refreshRegisteredAssistantZOrder,
  wireAssistantGlobalTop,
} from './windows';

// Single-instance lock so a second launch focuses the existing assistant
// instead of spinning up a duplicate.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

registerAssetProtocolScheme();

let avatarWin: BrowserWindow | null = null;
let chatWin: BrowserWindow | null = null;
let menuWin: BrowserWindow | null = null;
let permissionWin: BrowserWindow | null = null;
let imageOverlayWin: BrowserWindow | null = null;
let tray: TrayController | null = null;
let server: MioServer | null = null;
let wsHandle: { close(): Promise<void> } | null = null;
let httpHandle: { close(): Promise<void>; port: number } | null = null;
let lanPort: number | null = null;

function ensureBootSession(): void {
  const storedId = getActiveSessionId();
  if (storedId && getSession(storedId)) return;
  const sessions = listSessions();
  if (sessions.length > 0 && sessions[0]) {
    setActiveSessionId(sessions[0].id);
    return;
  }
  const fresh = createSession();
  setActiveSessionId(fresh.id);
}

function syncTrayWithAgent(): void {
  if (!tray) return;
  const status = agentLoop.getStatus();
  if (status.state === 'error' || status.state === 'capped') {
    tray.setState('error');
    return;
  }
  if (status.state === 'paused' || status.state === 'disabled') {
    tray.setState('paused');
    return;
  }
  if (status.state === 'running') {
    tray.setState('busy');
    return;
  }
  tray.setState('idle');
}

async function bootstrap(): Promise<void> {
  // Brain comes up FIRST so any subsequent module call (chatService,
  // userPreferences, etc.) finds an installed host adapter.
  server = createServer({ host: buildElectronHostAdapter() });
  server.eventBus.on('agent.status', () => syncTrayWithAgent());

  ensureUserAssetDirs();
  ensureBootSession();

  registerAssetProtocolHandler(session.defaultSession);

  avatarWin = createAvatarWindow();
  chatWin = createChatWindow(avatarWin);
  menuWin = createMenuWindow();
  permissionWin = createPermissionWindow();
  imageOverlayWin = createImageOverlayWindow();

  wireAssistantGlobalTop({
    avatar: avatarWin,
    chat: chatWin,
    permission: permissionWin,
    menu: menuWin,
    imageOverlay: imageOverlayWin,
  });
  refreshAssistantZOrder({
    avatar: avatarWin,
    chat: chatWin,
    permission: permissionWin,
    menu: menuWin,
    imageOverlay: imageOverlayWin,
  });

  initImageOverlay({ overlay: imageOverlayWin, avatar: avatarWin });

  registerIpcShim({
    avatar: avatarWin,
    chat: chatWin,
    menu: menuWin,
    permission: permissionWin,
    imageOverlay: imageOverlayWin,
    server,
    getLanPort: () => lanPort,
  });

  registerHotkeys({ avatar: avatarWin, chat: chatWin });

  // Hydrate the chat service against the active session so the first
  // turn doesn't pay for a re-load.
  chatService.ensureSession();

  tray = createTray({
    avatar: avatarWin,
    chat: chatWin,
    menu: menuWin,
    isAgentPaused: () => agentLoop.isPaused(),
  });
  syncTrayWithAgent();

  // ─── LAN transports ──────────────────────────────────────────────
  try {
    const http = await startHttpTransport({ port: 0 });
    httpHandle = http;
    lanPort = http.port;
    wsHandle = startWsTransport({ server, httpServer: http.server });
    await startMdnsAnnounce({ port: http.port, version: app.getVersion() });
    console.log(`[main] LAN server bound on port ${http.port}`);
  } catch (err) {
    console.error('[main] failed to start LAN transport', err);
  }

  chatWin.webContents.once('did-finish-load', () => {
    void welcomeOnLaunch();
  });
}

app.on('second-instance', () => {
  if (avatarWin && !avatarWin.isDestroyed()) {
    if (!avatarWin.isVisible()) avatarWin.show();
    avatarWin.focus();
    refreshRegisteredAssistantZOrder();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootstrap();
  }
});

app.on('window-all-closed', () => {
  // no-op — the assistant lives in the tray and the agent loop keeps running.
});

app.on('before-quit', () => {
  void (async () => {
    try {
      await wsHandle?.close();
      await httpHandle?.close();
      await stopMdnsAnnounce();
    } catch (err) {
      console.warn('[main] transport shutdown failed', err);
    }
    server?.shutdown();
    void closeBrowser();
  })();
});

app.whenReady().then(bootstrap).catch((err) => {
  console.error('[main] bootstrap failed', err);
  app.quit();
});
