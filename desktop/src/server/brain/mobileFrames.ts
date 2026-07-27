// Mobile perception frame buffer (Phase M-3.3).
//
// Holds the bytes the mobile client ships via `perception.upload` so
// the brain's perception step (`agent.ts > collectPerception`) can pull
// from them later. Storage is in-memory only — frames are short-lived
// sensor data and never touch disk:
//
//   • LRU + TTL eviction keeps the buffer small (sub-MB JPEGs at
//     720p, ~10 entries max) even under bursty uploads.
//   • Each kind ("back-cam" / "front-cam" / "screen") has an
//     additional "latest" index so `getMostRecent(kind)` is O(1) and
//     doesn't have to scan the LRU.
//   • Pending-request resolvers (M-3.7) park on `awaitFrameForRequest`
//     until a frame whose `requestId` matches arrives, then resolve.
//
// Why in-memory and not, say, a tmpfs file? Two reasons:
//   1. Anything we *want* to keep about a perception frame ends up in
//      the brain's conversation/memory text. The bytes themselves are
//      transient — they only need to outlive the agent loop's request
//      → upload → consume cycle, which is sub-second.
//   2. Buffer-backed access keeps Sharp/IO cheap; the agent step
//      sometimes wants to base64-encode for Anthropic's image_url, and
//      doing that out of a Buffer avoids a disk round-trip.

import type {
  PerceptionFrameKind,
  PerceptionMediaType,
} from '@shared/protocol';

/** Default time-to-live before a buffered frame is evicted. */
const DEFAULT_FRAME_TTL_MS = 30_000;
/** Hard cap on simultaneously buffered frames. */
const DEFAULT_CAPACITY = 16;
/** How long an awaitFrameForRequest waiter sits before timing out. */
const DEFAULT_REQUEST_WAIT_MS = 8_000;

export interface StoredMobileFrame {
  frameId: string;
  kind: PerceptionFrameKind;
  mediaType: PerceptionMediaType;
  width: number;
  height: number;
  /** Mobile-side capture timestamp (epoch ms). */
  ts: number;
  /** Server-side receive timestamp (epoch ms), used for TTL. */
  receivedAt: number;
  /** Echo of the original `perception.requestFrame.requestId`, if any. */
  requestId: string | null;
  bytes: Buffer;
}

interface StoreFrameInput {
  kind: string;
  mediaType: string;
  width: number;
  height: number;
  ts: number;
  requestId: string | null;
  bytes: Buffer;
}

type Resolver = (frame: StoredMobileFrame) => void;
type Rejecter = (err: Error) => void;

interface PendingWaiter {
  resolve: Resolver;
  reject: Rejecter;
  expires: number;
  timer: NodeJS.Timeout;
}

interface BufferState {
  capacity: number;
  ttlMs: number;
  /** Insertion order, oldest first. */
  order: StoredMobileFrame[];
  byId: Map<string, StoredMobileFrame>;
  /** Latest frame per kind for O(1) "most recent" lookup. */
  latestByKind: Map<PerceptionFrameKind, StoredMobileFrame>;
  /** Pending `awaitFrameForRequest` resolvers, keyed by requestId. */
  pendingByRequestId: Map<string, PendingWaiter>;
  /** Monotonic counter component of frameId. */
  seq: number;
}

const state: BufferState = {
  capacity: DEFAULT_CAPACITY,
  ttlMs: DEFAULT_FRAME_TTL_MS,
  order: [],
  byId: new Map(),
  latestByKind: new Map(),
  pendingByRequestId: new Map(),
  seq: 0,
};

const KNOWN_KINDS: readonly PerceptionFrameKind[] = [
  'back-cam',
  'front-cam',
  'screen',
];

function normaliseKind(raw: string): PerceptionFrameKind {
  if ((KNOWN_KINDS as readonly string[]).includes(raw)) {
    return raw as PerceptionFrameKind;
  }
  throw new Error(`unknown perception kind: ${raw}`);
}

function normaliseMediaType(raw: string): PerceptionMediaType {
  if (raw === 'image/jpeg' || raw === 'image/png' || raw === 'image/webp') {
    return raw;
  }
  throw new Error(`unsupported mediaType: ${raw}`);
}

function generateFrameId(): string {
  state.seq = (state.seq + 1) % Number.MAX_SAFE_INTEGER;
  // 9-digit timestamp suffix + 4-digit monotonic suffix is plenty for
  // "no collisions within the buffer's lifetime" without a UUID dep.
  const t = Date.now().toString(36);
  const s = state.seq.toString(36).padStart(4, '0');
  return `mf_${t}_${s}`;
}

function evictExpired(now: number): void {
  // TTL cull from the front of `order` since insertion is monotonic in
  // `receivedAt`. Stop as soon as we see a non-expired entry.
  while (state.order.length > 0) {
    const head = state.order[0]!;
    if (now - head.receivedAt < state.ttlMs) break;
    state.order.shift();
    state.byId.delete(head.frameId);
    if (state.latestByKind.get(head.kind) === head) {
      state.latestByKind.delete(head.kind);
    }
  }
}

function evictOverCapacity(): void {
  while (state.order.length > state.capacity) {
    const dropped = state.order.shift();
    if (!dropped) break;
    state.byId.delete(dropped.frameId);
    if (state.latestByKind.get(dropped.kind) === dropped) {
      state.latestByKind.delete(dropped.kind);
    }
  }
}

function notifyWaiterFor(frame: StoredMobileFrame): void {
  if (!frame.requestId) return;
  const waiter = state.pendingByRequestId.get(frame.requestId);
  if (!waiter) return;
  state.pendingByRequestId.delete(frame.requestId);
  clearTimeout(waiter.timer);
  waiter.resolve(frame);
}

/**
 * Insert a freshly-uploaded mobile frame and return the assigned
 * `frameId`. Called by `methods.perceptionUpload` after the binary
 * frame arrives.
 */
export function storeMobileFrame(input: StoreFrameInput): string {
  const now = Date.now();
  evictExpired(now);

  const frame: StoredMobileFrame = {
    frameId: generateFrameId(),
    kind: normaliseKind(input.kind),
    mediaType: normaliseMediaType(input.mediaType),
    width: input.width,
    height: input.height,
    ts: input.ts,
    receivedAt: now,
    requestId: input.requestId,
    bytes: input.bytes,
  };

  state.order.push(frame);
  state.byId.set(frame.frameId, frame);
  state.latestByKind.set(frame.kind, frame);
  evictOverCapacity();
  notifyWaiterFor(frame);
  return frame.frameId;
}

/**
 * Look up a frame by ID. Returns `null` when the frame has been
 * evicted (TTL or capacity).
 */
export function getMobileFrame(frameId: string): StoredMobileFrame | null {
  const now = Date.now();
  evictExpired(now);
  return state.byId.get(frameId) ?? null;
}

/**
 * Most recent buffered frame for a given kind, or `null` when none
 * has arrived (or all have expired). Used by `agent.ts > perception`.
 */
export function getMostRecentFrame(
  kind: PerceptionFrameKind,
): StoredMobileFrame | null {
  const now = Date.now();
  evictExpired(now);
  return state.latestByKind.get(kind) ?? null;
}

/**
 * Await the next frame whose `requestId` matches. Resolves as soon as
 * `storeMobileFrame` lands a matching entry; rejects after
 * `timeoutMs` (default 8 s) so callers don't deadlock if the mobile
 * client never replies. Only one waiter per `requestId` is allowed —
 * if a second waiter registers it replaces the first.
 */
export function awaitFrameForRequest(
  requestId: string,
  timeoutMs: number = DEFAULT_REQUEST_WAIT_MS,
): Promise<StoredMobileFrame> {
  return new Promise<StoredMobileFrame>((resolve, reject) => {
    const existing = state.pendingByRequestId.get(requestId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error('superseded by newer waiter'));
    }

    const timer = setTimeout(() => {
      state.pendingByRequestId.delete(requestId);
      reject(new Error(`perception frame timeout for requestId=${requestId}`));
    }, timeoutMs);

    state.pendingByRequestId.set(requestId, {
      resolve,
      reject,
      expires: Date.now() + timeoutMs,
      timer,
    });
  });
}

/**
 * Best-effort eviction triggered by the host shutting down or the
 * perception pipeline being toggled off. Clears storage AND every
 * pending waiter (resolved as a rejection).
 */
export function clearMobileFrames(): void {
  state.order.length = 0;
  state.byId.clear();
  state.latestByKind.clear();
  for (const w of state.pendingByRequestId.values()) {
    clearTimeout(w.timer);
    w.reject(new Error('mobile frame buffer cleared'));
  }
  state.pendingByRequestId.clear();
}

/**
 * Test helper — adjust capacity / TTL without restarting the host.
 * Not called from production code; exported so the future Vitest
 * suite can exercise the eviction logic deterministically.
 */
export function reconfigureForTest(opts: {
  capacity?: number;
  ttlMs?: number;
}): void {
  if (typeof opts.capacity === 'number' && opts.capacity > 0) {
    state.capacity = opts.capacity;
  }
  if (typeof opts.ttlMs === 'number' && opts.ttlMs > 0) {
    state.ttlMs = opts.ttlMs;
  }
}

/** Diagnostic — current count after expiring stale entries. */
export function mobileFrameBufferSize(): number {
  evictExpired(Date.now());
  return state.order.length;
}
