import { BrowserWindow, nativeImage, Tray } from 'electron';
import path from 'node:path';

import { IpcChannels, type TrayMenuState } from '@shared/ipc';

import { showChatNearAvatar, showMenuAt } from './windows';

// 16x16 PNG loaded from the build assets. Phase 1 placeholder; Phase 7
// swaps in a real branded tray icon. The color argument is kept for
// future per-state tinted variants.
function buildTrayImage(_hexColor: string): Electron.NativeImage {
  const iconPath = path.join(__dirname, '../../build/icon.png');
  return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
}

export type TrayState = 'idle' | 'busy' | 'paused' | 'error';

const STATE_COLORS: Record<TrayState, string> = {
  idle: '#3ddc97',
  busy: '#f0c419',
  paused: '#9aa0a6',
  error: '#e84545',
};

const STATE_LABELS: Record<TrayState, string> = {
  idle: 'Idle',
  busy: 'Thinking…',
  paused: 'Paused',
  error: 'Error',
};

export interface TrayController {
  setState(state: TrayState): void;
  destroy(): void;
}

interface CreateTrayDeps {
  avatar: BrowserWindow;
  chat: BrowserWindow;
  menu: BrowserWindow;
  isAgentPaused: () => boolean;
}

export function createTray(deps: CreateTrayDeps): TrayController {
  const tray = new Tray(buildTrayImage(STATE_COLORS.idle));
  tray.setToolTip('Mio — desktop assistant');

  let currentState: TrayState = 'idle';

  const pushMenuState = (): void => {
    if (deps.menu.isDestroyed()) return;
    const payload: TrayMenuState = {
      avatarVisible: deps.avatar.isVisible(),
      agentPaused: deps.isAgentPaused(),
      statusTone: currentState,
      statusLabel: STATE_LABELS[currentState],
    };
    deps.menu.webContents.send(IpcChannels.TrayMenuStateEvent, payload);
  };

  const openMenu = (): void => {
    pushMenuState();
    showMenuAt(deps.menu, tray.getBounds());
  };

  // Left-click is the muscle-memory "summon Mio" path; right-click
  // opens the custom HTML popup (replaces the OS native context menu).
  tray.on('click', () => showChatNearAvatar(deps.chat, deps.avatar));
  tray.on('right-click', () => openMenu());

  // Push the initial state once the renderer is ready so the very
  // first popup paints with correct toggle labels.
  if (deps.menu.webContents.isLoading()) {
    deps.menu.webContents.once('did-finish-load', pushMenuState);
  } else {
    pushMenuState();
  }

  return {
    setState(state: TrayState) {
      currentState = state;
      tray.setImage(buildTrayImage(STATE_COLORS[state]));
      tray.setToolTip(`Mio — ${state}`);
      // Keep the open popup in sync if state changes while it's visible.
      if (!deps.menu.isDestroyed() && deps.menu.isVisible()) {
        pushMenuState();
      }
    },
    destroy() {
      tray.destroy();
    },
  };
}
