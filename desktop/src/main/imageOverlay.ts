import { BrowserWindow, clipboard, nativeImage, screen, shell } from 'electron';
import fs from 'node:fs';

import { IpcChannels, type ImageOverlayPayload } from '@shared/ipc';

import { positionImageOverlayWindow, refreshRegisteredAssistantZOrder } from './windows';

// Phase 10 — bridge between the `generate_image` tool (which emits
// images) and the frameless glass overlay window (which paints them
// near the avatar). Owns the auto-dismiss timer + the renderer-asked
// resize/copy/open/reveal IPC handlers.
//
// The overlay window itself is created once at bootstrap (see
// `windows.ts > createImageOverlayWindow`) and stays hidden until we
// call `showImage`. We never tear it down — re-showing is just an
// IPC push, which keeps the first appearance snappy (no cold start).

let overlayWin: BrowserWindow | null = null;
let avatarWin: BrowserWindow | null = null;
let autoDismissTimer: NodeJS.Timeout | null = null;
let lastContentSize: { width: number; height: number } | null = null;
/** The PNG currently on screen — referenced by Copy / Open / Reveal IPC. */
let activePath: string | null = null;

export function initImageOverlay(args: {
  overlay: BrowserWindow;
  avatar: BrowserWindow;
}): void {
  overlayWin = args.overlay;
  avatarWin = args.avatar;
  args.overlay.on('closed', () => {
    overlayWin = null;
    activePath = null;
    clearTimer();
  });
}

function clearTimer(): void {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

function scheduleAutoDismiss(seconds: number): void {
  clearTimer();
  if (seconds <= 0) return;
  autoDismissTimer = setTimeout(() => {
    autoDismissTimer = null;
    dismissOverlay();
  }, seconds * 1000);
}

/**
 * Push a freshly generated image to the overlay window and reveal it.
 * Cancels any pending auto-dismiss for the previous image so the new
 * one gets the full timeout.
 */
export function showImage(payload: ImageOverlayPayload): void {
  if (!overlayWin || overlayWin.isDestroyed()) {
    console.warn('[image-overlay] window not ready; dropping payload');
    return;
  }
  activePath = payload.absPath;
  const reveal = (): void => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.webContents.send(IpcChannels.ImageOverlayShow, payload);
    repositionFromLast();
    if (!overlayWin.isVisible()) overlayWin.showInactive();
    refreshRegisteredAssistantZOrder();
    scheduleAutoDismiss(payload.autoDismissSec);
  };
  if (overlayWin.webContents.isLoading()) {
    overlayWin.webContents.once('did-finish-load', reveal);
  } else {
    reveal();
  }
}

function repositionFromLast(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !avatarWin || avatarWin.isDestroyed()) {
    return;
  }
  const size = lastContentSize ?? { width: 420, height: 360 };
  positionImageOverlayWindow(overlayWin, avatarWin, size.width, size.height);
}

/** Hide the overlay window without destroying it. */
export function dismissOverlay(): void {
  clearTimer();
  activePath = null;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayWin.isVisible()) overlayWin.hide();
}

/** IPC handler — renderer measured its card. Refit the frameless window. */
export function handleImageOverlayResize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (width <= 0 || height <= 0) return;
  lastContentSize = { width: Math.ceil(width), height: Math.ceil(height) };
  if (!overlayWin || overlayWin.isDestroyed() || !avatarWin || avatarWin.isDestroyed()) {
    return;
  }
  positionImageOverlayWindow(
    overlayWin,
    avatarWin,
    lastContentSize.width,
    lastContentSize.height,
  );
}

/** IPC handler — operator clicked Copy. */
export function handleImageOverlayCopy(absPath: string): void {
  const target = absPath || activePath;
  if (!target || !fs.existsSync(target)) return;
  try {
    const img = nativeImage.createFromPath(target);
    if (!img.isEmpty()) clipboard.writeImage(img);
  } catch (err) {
    console.warn('[image-overlay] copy failed', err);
  }
}

/** IPC handler — operator clicked Open in default viewer. */
export function handleImageOverlayOpen(absPath: string): void {
  const target = absPath || activePath;
  if (!target) return;
  void shell.openPath(target).catch((err) => {
    console.warn('[image-overlay] open failed', err);
  });
}

/** IPC handler — operator clicked Show in folder. */
export function handleImageOverlayReveal(absPath: string): void {
  const target = absPath || activePath;
  if (!target) return;
  try {
    shell.showItemInFolder(target);
  } catch (err) {
    console.warn('[image-overlay] reveal failed', err);
  }
}

/** IPC handler — overlay renderer-initiated dismiss (button, Esc, click-away). */
export function handleImageOverlayDismiss(): void {
  dismissOverlay();
}

/**
 * Phase 10 — handy for callers that need to know whether an overlay is
 * up (e.g. status HUD wanting to indicate "drawing visible"). Defined
 * for symmetry with the permission gate's `getPermissionWindowBounds`.
 */
export function isOverlayVisible(): boolean {
  return !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
}

// Quiet helper for future window-position rework — re-anchor the
// overlay if the operator drags the avatar around mid-display.
export function reanchorOverlay(): void {
  if (!isOverlayVisible()) return;
  repositionFromLast();
}

// screen import is part of the surface so consumers can compute a
// secondary-monitor fallback later; reference it once to keep TS happy
// even when nothing else in the module touches it directly today.
void screen;
