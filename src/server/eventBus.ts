// Typed in-process pub/sub used by the brain to signal both transports
// (Electron IPC and WebSocket) without knowing which clients are
// connected.
//
// The brain emits typed events; the IPC transport forwards each to
// the relevant `BrowserWindow.webContents.send`, and the WS transport
// JSON-frames each to every connected authenticated client. New
// transports just subscribe at boot.

import type {
  ChatOrigin,
  ServerEventName,
  ServerEventPayload,
} from '@shared/protocol';

/**
 * Per-emit metadata carried alongside the typed payload. Used by the
 * transports to route surface-bound events (chat stream, caption,
 * chunk, talking animation) only to the surface that originated the
 * turn — so a mobile-driven chat does NOT also stream onto the
 * desktop chat pill, and vice versa.
 *
 * Brain emissions that have NO single originating surface (agent loop
 * cycles, greetings, notable check-ins, gesture prefs broadcasts) omit
 * `origin`; transports treat that as "broadcast to everyone".
 */
export interface EventMeta {
  /** Originating surface of the turn that produced this event, when known. */
  origin?: ChatOrigin;
}

type Handler<E extends ServerEventName> = (
  payload: ServerEventPayload<E>,
  meta: EventMeta,
) => void;

type AnyHandler = (payload: unknown, meta: EventMeta) => void;

class EventBus {
  private readonly handlers = new Map<ServerEventName, Set<AnyHandler>>();

  on<E extends ServerEventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as AnyHandler);
    return () => {
      set!.delete(handler as AnyHandler);
    };
  }

  emit<E extends ServerEventName>(
    event: E,
    payload: ServerEventPayload<E>,
    meta: EventMeta = {},
  ): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload as unknown, meta);
      } catch (err) {
        console.warn(`[event-bus] listener for ${event} threw`, err);
      }
    }
  }
}

/**
 * Process-wide singleton. Pub/sub state has the same lifetime as the
 * server (i.e. the Electron main process), and we don't ever spin
 * up two brains in one process, so a singleton beats threading the
 * bus through every constructor.
 */
export const eventBus = new EventBus();

export type { EventBus };
