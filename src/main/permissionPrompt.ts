import type { BrowserWindow } from 'electron';

import { IpcChannels } from '@shared/ipc';

import { setPermissionWindowBoundsProvider } from '@brain/computerUseStatus';
import { getPendingPermissionRequest } from '@brain/permissionResponses';

import { positionPermissionWindow, refreshRegisteredAssistantZOrder } from './windows';

// Desktop-side permission popup window manager.
//
// The brain decides WHEN to ask the operator (via the gate +
// `permission.request` bus event) and tracks the pending decision. This
// module owns the actual BrowserWindow: where to position it, when to
// show/hide it, the watchdog's "don't click your own Allow button"
// bounds provider, and the renderer-reported content-height resize.
//
// Event subscription itself lives in `ipcShim.ts`; this module just
// handles window lifecycle + the show/hide + bounds bookkeeping that
// the bus handler can't do on its own.

let win: BrowserWindow | null = null;
let lastContentHeight = 220;

export function initPermissionPrompt(window: BrowserWindow): void {
  win = window;
  setPermissionWindowBoundsProvider(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return null;
    return win.getBounds();
  });
  window.on('closed', () => {
    win = null;
    setPermissionWindowBoundsProvider(null);
  });
  // Re-broadcast the live prompt every time the page finishes loading
  // (Vite dev reload, late renderer subscription, etc.).
  window.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    const pending = getPendingPermissionRequest();
    if (pending) {
      win.webContents.send(IpcChannels.PermissionRequestEvent, pending);
      revealWindow();
    }
  });
}

/**
 * Call this from the IPC shim's `permission.request` bus subscription
 * AFTER forwarding the request payload so the popup window appears.
 */
export function revealPermissionWindow(): void {
  revealWindow();
}

function revealWindow(): void {
  if (!win || win.isDestroyed()) return;
  positionPermissionWindow(win, lastContentHeight);
  win.show();
  win.focus();
  refreshRegisteredAssistantZOrder();
}

/** Called when the operator answered and there's nothing else queued. */
export function maybeHidePermissionWindow(): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  win.hide();
}

/** IPC handler — the renderer reported its measured content height. */
export function handlePermissionResize(height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  lastContentHeight = height;
  if (win && !win.isDestroyed()) positionPermissionWindow(win, height);
}
