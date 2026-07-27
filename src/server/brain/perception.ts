// Implicit perception collector (Phase M-3 polish).
//
// Mio's brain has three implicit-perception entry points — the agent
// loop's observation cycle, the chat-turn auto-snapshot inside
// `chatService.send`, and the gesture-turn auto-snapshot (which also
// flows through `chatService.send` via `chatTurn.ts`). Pre-M-3, all
// three captured a desktop primary-monitor screenshot. M-3 layered in
// mobile back-camera frames; the trick is making "what does the
// model see this turn?" consistent across the three pathways.
//
// This module is the single place that translates an
// [`AgentPerceptionMode`] into the actual image(s) we'll attach to
// the Anthropic call. By centralising it, we get four nice
// properties:
//
//   1. **Same fall-back behaviour everywhere.** A timed-out mobile
//      pull degrades to "no mobile, just desktop" identically for an
//      agent cycle and a chat turn.
//   2. **Same staleness contract everywhere.** PERCEPTION_PULL_TIMEOUT_MS
//      bounds the time the user spends staring at the typing cursor
//      while we wait for the phone, exactly like it bounds an agent
//      cycle's perception step.
//   3. **Easy to reason about persistence.** Every image returned
//      from here is documented as *transient* — the caller is
//      responsible for NOT inserting them into `chat_messages`,
//      `memory_entries`, or the recall vector store. The only way an
//      image enters those tables is via `ChatSendOptions.manualImage`
//      (the bottom-row camera button or future drag-drop), which is
//      handled by `chatService.send` *outside* this module.
//   4. **One place to add the next perception source.** Phase M-5
//      adds desktop MediaProjection mirrors and per-window captures;
//      they'll plug into the same Promise.all in `'both'` without
//      touching any caller.
//
// See `chatService.ts > send`, `agent.ts > collectPerception`, and
// the `'both'` discussion in `protocol.ts > AgentPerceptionMode`.

import type {
  AgentPerceptionMode,
  AttachedImage,
  ChatOrigin,
  PerceptionFrameKind,
} from '@shared/protocol';

import { eventBus } from '../eventBus';
import { getHost } from './host';
import { awaitFrameForRequest } from './mobileFrames';

/**
 * How long we'll wait for the mobile client to capture, encode, and
 * upload a frame before we declare the pull lost. 800 ms balances
 * "fast enough to not stall the cycle / typing cursor" against
 * typical phone capture latency (~200-500 ms for CameraX
 * `MINIMIZE_LATENCY` + base WS round-trip on a co-located LAN).
 */
const PERCEPTION_PULL_TIMEOUT_MS = 800;

/**
 * A mobile-originated chat turn pulls *two* phone frames (back camera +
 * phone screen). The phone serialises the two captures behind a single
 * hardware lock, so the second leg lands later than a lone back-cam
 * pull would. The user also explicitly sent this turn from their phone
 * and is already waiting on a reply, so a slightly longer budget is the
 * right trade — better to wait ~2 s and actually get both views than to
 * clip the slower leg at 800 ms and ship Mio a half-blind turn.
 */
const MOBILE_ORIGIN_PULL_TIMEOUT_MS = 2_000;

/**
 * Hint to the mobile client (passed through as `notLaterThan`) on
 * how stale a frame may be before it's no longer useful. Aligned
 * with `mobileFrames.DEFAULT_FRAME_TTL_MS` (30 s) so the buffer
 * never serves us something it's about to evict.
 */
const PERCEPTION_MAX_AGE_MS = 30_000;

/**
 * Metadata bundle for a freshly-pulled mobile camera frame. The
 * caller usually wants `image` directly for the Anthropic `image`
 * block, plus `width`/`height`/`ageMs` for the prompt-stuffing
 * intro line ("a 1280x720 frame from your back camera captured
 * 1 s ago is attached below").
 */
/**
 * Image-only subset of [AttachedImage]. Perception frames are always
 * JPEG/PNG/WebP — never PDF — so we expose the narrow type here so
 * downstream consumers (notably `agent.ts`'s perception block builder)
 * can pass the `mediaType` straight into Anthropic's `ImageBlockParam`
 * without a cast.
 */
export interface PerceptionAttachedImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}

export interface CapturedMobileFrame {
  image: PerceptionAttachedImage;
  width: number;
  height: number;
  /** Milliseconds since the mobile client wrote the frame to the buffer. */
  ageMs: number;
}

/**
 * Result of an implicit-perception pull. Every leg is nullable; the
 * caller must treat a `null` leg as "model gets no image from that
 * source this turn".
 *
 *  - `screen`       — the desktop primary-monitor screenshot.
 *  - `mobile`       — the phone's back camera (what the user sees).
 *  - `mobileScreen` — the phone's own screen (MediaProjection).
 *
 * `mobileScreen` is only ever populated for a `'mobile'`-origin turn;
 * the `AgentPerceptionMode`-driven desktop path never sets it.
 */
export interface ImplicitPerception {
  screen: PerceptionAttachedImage | null;
  mobile: CapturedMobileFrame | null;
  mobileScreen: CapturedMobileFrame | null;
}

/**
 * Decide what image(s) to attach for an implicit perception turn.
 *
 * `origin` is the decisive input. A `'mobile'`-origin turn means the
 * user is physically holding their phone — the desktop primary monitor
 * is unrelated context that would only confuse Mio, so we pull the
 * phone's back camera (her eyes on the user's world) and the phone's
 * own screen instead, and never touch the desktop screenshot. The
 * operator's `AgentPerceptionMode` is intentionally ignored in that
 * case; it governs the *desktop* surface and the autonomous agent
 * cycle, not "what the phone-bound user is looking at right now".
 *
 * A `'desktop'`-origin turn (or the agent cycle, which passes no
 * origin) keeps the pre-existing `AgentPerceptionMode` behaviour.
 *
 * `reason` is forwarded as the `perception.requestFrame.reason`
 * hint so a future mobile-side privacy UI can surface "this pull
 * was triggered by your chat message" vs. "by an agent cycle".
 * Returned images are transient — see the module-level comment.
 */
export async function collectImplicitPerception(
  mode: AgentPerceptionMode | undefined,
  reason: string,
  origin: ChatOrigin = 'desktop',
): Promise<ImplicitPerception> {
  if (origin === 'mobile') {
    // Mobile-origin turn: the phone is the user's surface. Pull both
    // phone frames in parallel — the desktop side races them
    // independently; the phone serialises the two captures behind its
    // own hardware lock. Either leg may resolve to null (no CAMERA
    // grant, no live MediaProjection, WS dropped); the model just
    // receives whatever arrived. The desktop screenshot is never
    // collected here.
    const [mobile, mobileScreen] = await Promise.all([
      pullMobileFrame(reason, 'back-cam', MOBILE_ORIGIN_PULL_TIMEOUT_MS),
      pullMobileFrame(reason, 'screen', MOBILE_ORIGIN_PULL_TIMEOUT_MS),
    ]);
    return { screen: null, mobile, mobileScreen };
  }

  // Phase-5 cost-saver — default aligned with the new
  // `userPreferences.ts > DEFAULT_AGENT_PREFS.perceptionMode`
  // (`'desktop-only'`). Pre-Phase-5 this fell through to `'both'`,
  // which auto-shipped two ~`2k-token` images on every implicit
  // perception tick — doubling vision cost relative to the
  // single-image desktop-only flow.
  const effective: AgentPerceptionMode = mode ?? 'desktop-only';
  switch (effective) {
    case 'desktop-only':
      return { screen: await captureDesktopScreen(), mobile: null, mobileScreen: null };
    case 'mobile-only': {
      const mobile = await pullMobileFrame(reason);
      return { screen: null, mobile, mobileScreen: null };
    }
    case 'mobile-priority': {
      const mobile = await pullMobileFrame(reason);
      if (mobile) return { screen: null, mobile, mobileScreen: null };
      return { screen: await captureDesktopScreen(), mobile: null, mobileScreen: null };
    }
    case 'both':
    default: {
      // Parallel pull — desktop screenshot and mobile pull race
      // independently. Either may resolve to null; the model just
      // receives whatever arrived. The 800-ms mobile timeout means
      // the chat turn never blocks on the phone for more than that.
      const [screen, mobile] = await Promise.all([
        captureDesktopScreen(),
        pullMobileFrame(reason),
      ]);
      return { screen, mobile, mobileScreen: null };
    }
  }
}

async function captureDesktopScreen(): Promise<PerceptionAttachedImage | null> {
  try {
    const shot = await getHost().sensors.capturePrimaryScreen();
    if (!shot) return null;
    return { mediaType: shot.mediaType, data: shot.data };
  } catch (err) {
    // Sensor failure is logged but never raised — perception is
    // best-effort, not load-bearing for the rest of the turn.
    console.warn('[perception] desktop screen capture failed:', err);
    return null;
  }
}

async function pullMobileFrame(
  reason: string,
  kind: PerceptionFrameKind = 'back-cam',
  timeoutMs: number = PERCEPTION_PULL_TIMEOUT_MS,
): Promise<CapturedMobileFrame | null> {
  const requestId = newRequestId();
  // Emit before await so the mobile client has the request in
  // hand by the time we start the timer. The WS transport fan-out
  // is synchronous so this is effectively zero-latency for paired
  // clients; unpaired sessions just drop the event.
  eventBus.emit('perception.requestFrame', {
    requestId,
    kind,
    reason,
    notLaterThan: Date.now() + PERCEPTION_MAX_AGE_MS,
  });
  try {
    const frame = await awaitFrameForRequest(requestId, timeoutMs);
    // Perception only ever ships JPEG/PNG/WebP — narrow the type back
    // down from `AttachedImage['mediaType']` (which now includes
    // `'application/pdf'` for the mobile attachment sheet) so callers
    // like `agent.ts` can still treat the result as image-only.
    const mediaType: 'image/jpeg' | 'image/png' | 'image/webp' =
      frame.mediaType === 'image/png'
        ? 'image/png'
        : frame.mediaType === 'image/webp'
          ? 'image/webp'
          : 'image/jpeg';
    return {
      image: {
        mediaType,
        data: frame.bytes.toString('base64'),
      },
      width: frame.width,
      height: frame.height,
      ageMs: Date.now() - frame.receivedAt,
    };
  } catch {
    // Timeout or rejection — most commonly the phone has no CAMERA
    // permission, no client is paired, or the WS dropped. The
    // caller treats `null` as "no mobile leg this turn".
    return null;
  }
}

function newRequestId(): string {
  const t = Date.now().toString(36);
  const s = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `pp_${t}_${s}`;
}
