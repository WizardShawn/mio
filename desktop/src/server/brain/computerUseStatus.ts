import type { ComputerUseStatus } from '@shared/protocol';

import { eventBus } from '../eventBus';

// Brain-side facade for the computer-use status bar + Stop button.
//
// The brain decides when a session starts / steps / ends and emits the
// status as `permission.status` on the event bus. Transports (the IPC
// shim today; mobile tomorrow) subscribe and push to whichever UI
// surface owns the approval popup.
//
// The Stop button is the inverse — the operator presses it on some
// client surface; the IPC shim (or any other transport) calls
// `triggerComputerUseStop()`, which runs the brain-registered abort
// callback installed by the active session.
//
// Window bounds for the watchdog's "don't click your own Allow button"
// guard are provided by the host shell via a registered provider — the
// brain has no concept of windows.

let stopHandler: (() => void) | null = null;

/**
 * Phase 9 — register / clear the computer-use abort callback. Called
 * by `runComputerUseSession` on entry and on exit.
 */
export function setComputerUseStopHandler(fn: (() => void) | null): void {
  stopHandler = fn;
}

/** Invoked by a transport when the operator presses Stop. */
export function triggerComputerUseStop(): void {
  stopHandler?.();
}

/** Emit the current session status to every subscribed transport. */
export function setComputerUseStatus(status: ComputerUseStatus): void {
  eventBus.emit('permission.status', status);
}

// ─── Permission-window bounds provider (watchdog hard-block) ───────

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type BoundsProvider = () => ScreenRect | null;

let permissionWindowBoundsProvider: BoundsProvider | null = null;

/**
 * The shell (electron main today) registers a callback that returns
 * the current screen-pixel bounds of its approval popup, or null when
 * it is hidden. Used by the in-session watchdog to refuse any action
 * that would click on Mio's own Allow button.
 */
export function setPermissionWindowBoundsProvider(fn: BoundsProvider | null): void {
  permissionWindowBoundsProvider = fn;
}

export function getPermissionWindowBounds(): ScreenRect | null {
  return permissionWindowBoundsProvider ? permissionWindowBoundsProvider() : null;
}
