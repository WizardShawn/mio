// Cross-source reply arbitration.
//
// Three things can push a reply onto the chat surface:
//   • a user-typed turn          (kind = 'user',    priority 3)
//   • an avatar gesture batch    (kind = 'gesture', priority 2)
//   • the agent loop check-in    (kind = 'auto',    priority 1)
//
// They share one caption pill and one audio channel, so they must take
// turns. The coordinator enforces:
//   1. Strict priority — a higher-priority `acquire` PRE-EMPTS whatever
//      lower-priority reply is currently in flight (cancelling its
//      Anthropic stream + skipping its pending IPC sends via the
//      `signal` exposed on the slot). Equal or lower priority is
//      dropped on the floor.
//   2. Full-pipeline holds — the slot is held from `acquire` until the
//      caller calls `release()`. Callers MUST keep the slot until the
//      post-reply translation + TTS playback estimate has elapsed, not
//      just until the Anthropic stream ends.
//   3. Idle notifications — `onIdle` fires exactly once each time the
//      coordinator goes from "busy" to "idle".

export type ReplyKind = 'user' | 'gesture' | 'auto';

const PRIORITY: Record<ReplyKind, number> = {
  user: 3,
  gesture: 2,
  auto: 1,
};

type IdleListener = () => void;

interface ActiveSlot {
  kind: ReplyKind;
  controller: AbortController;
}

class ReplyCoordinator {
  private current: ActiveSlot | null = null;
  private readonly idleListeners = new Set<IdleListener>();

  isBusy(): boolean {
    return this.current !== null;
  }

  currentKind(): ReplyKind | null {
    return this.current?.kind ?? null;
  }

  acquire(kind: ReplyKind): SlotHandle | null {
    if (this.current) {
      if (PRIORITY[kind] <= PRIORITY[this.current.kind]) {
        return null;
      }
      try {
        this.current.controller.abort();
      } catch (err) {
        console.warn('[reply-coordinator] abort on pre-empt failed', err);
      }
      this.current = null;
    }
    const controller = new AbortController();
    const slot: ActiveSlot = { kind, controller };
    this.current = slot;
    return new SlotHandle(this, controller, kind);
  }

  releaseSlot(controller: AbortController): void {
    if (!this.current || this.current.controller !== controller) return;
    this.current = null;
    for (const fn of this.idleListeners) {
      try {
        fn();
      } catch (err) {
        console.warn('[reply-coordinator] idle listener threw', err);
      }
    }
  }

  onIdle(handler: IdleListener): () => void {
    this.idleListeners.add(handler);
    return () => this.idleListeners.delete(handler);
  }
}

export class SlotHandle {
  constructor(
    private readonly coordinator: ReplyCoordinator,
    private readonly controller: AbortController,
    readonly kind: ReplyKind,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  release(): void {
    this.coordinator.releaseSlot(this.controller);
  }
}

export const replyCoordinator = new ReplyCoordinator();
