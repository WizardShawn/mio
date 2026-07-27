import type { PermissionChoice, PermissionRequest } from '@shared/protocol';

import { eventBus } from '../eventBus';
import { setPromptHandler } from './permissions/gate';

// Brain-side bridge between the permission gate (which decides it
// needs the operator) and whichever client surface owns the approval
// popup (the desktop permission window today; mobile UI tomorrow).
//
// On install, the brain's gate gets a prompt handler that:
//   1. Emits `permission.request` on the bus; every subscribed
//      transport forwards the request to its connected client(s).
//   2. Awaits the operator's decision, which arrives back through
//      the `permission.respond` server method calling
//      `handlePermissionResponse` here.
//
// Callers are sequential (the chat tool loop awaits each tool, the
// computer-use loop awaits each action), so there is at most one
// prompt in flight — but a queue is kept anyway so a late request can
// never be dropped.

interface PendingPrompt {
  id: string;
  req: PermissionRequest;
  resolve: (choice: PermissionChoice) => void;
}

let pending: PendingPrompt | null = null;
const queue: Array<{ req: PermissionRequest; resolve: (c: PermissionChoice) => void }> = [];

function pump(): void {
  if (pending) return;
  const next = queue.shift();
  if (!next) return;
  pending = { id: next.req.id, req: next.req, resolve: next.resolve };
  eventBus.emit('permission.request', next.req);
}

function showPrompt(req: PermissionRequest): Promise<PermissionChoice> {
  return new Promise<PermissionChoice>((resolve) => {
    queue.push({ req, resolve });
    pump();
  });
}

/** Wire the prompt handler into the gate. Call once at server boot. */
export function installPermissionPromptBridge(): void {
  setPromptHandler(showPrompt);
}

/** Tear down on shutdown — fails every pending request closed. */
export function shutdownPermissionPromptBridge(): void {
  setPromptHandler(null);
  if (pending) {
    pending.resolve('deny');
    pending = null;
  }
  for (const q of queue.splice(0)) q.resolve('deny');
}

/** Server-method entry: a transport forwarded the operator's decision. */
export function handlePermissionResponse(id: string, choice: PermissionChoice): void {
  if (!pending) {
    console.warn(
      `[permission-bridge] dropped response ${id}/${choice} — no pending request.`,
    );
    return;
  }
  if (pending.id !== id) {
    console.warn(
      `[permission-bridge] dropped response ${id}/${choice} — pending is ${pending.id}.`,
    );
    return;
  }
  const { resolve } = pending;
  pending = null;
  resolve(choice);
  pump();
}

/**
 * The IPC shim re-broadcasts the live prompt to a renderer that just
 * finished loading (Vite dev reload, late `permissionApi.onRequest`
 * subscription, etc.). Returns the pending request, or null if none.
 */
export function getPendingPermissionRequest(): PermissionRequest | null {
  return pending?.req ?? null;
}
