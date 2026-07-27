// YouTube-style one-line subtitle controller for Mio's chat caption.
//
// Goal: show one sentence at a time on the single-line bar. While
// Claude is streaming text, the current sentence types out live
// (typewriter feel — no restart). When its terminating punctuation
// lands the sentence enters a brief HOLD; once the NEXT character of
// the next sentence arrives, the bar crossfades and starts revealing
// the new sentence. Same model applies to greeting / reply audio
// playback, just driven by audio.currentTime instead of stream
// deltas.
//
// Two driving modes:
//   • Streaming  — feedStreamingDelta(delta) for live deltas, endStreaming() on stop.
//   • Audio      — playWithAudio({fullText, audio}) splits the text
//                  into segments mapped to audio time.
//
// HTML expected (see chat/index.html + chat/style.css):
//   <div id="caption" class="pill caption">
//     <span id="caption-text"></span><span class="cursor"></span>
//   </div>
//
// The `swapping` class on #caption-text drives the opacity transition.

const SEGMENT_END_CHARS = new Set([
  '。', '！', '？', '．', '!', '?', '\n',
]);

/**
 * Clause-level soft break. Only used when the running buffer is
 * already long enough that the bar would clip it — short clauses stay
 * grouped with their main sentence.
 */
const SOFT_BREAK_CHARS = new Set(['，', '、', '；', '：', ',', ';']);

/**
 * Approx. single-line capacity of `.caption` in CJK full-width glyphs.
 *
 * The pill is 392 px (chat window) − 24 px (#surface padding) − 28 px
 * (pill padding) − ~10 px (blinking cursor + flex gap) ≈ 330 px of
 * content. At `font-size: 13.5px` with the OS CJK fallback (Microsoft
 * YaHei on Windows ≈ 14 px / glyph), that fits ~23 full-width
 * characters before `text-overflow: ellipsis` starts eating the
 * right edge. We round up by one to let the splitter pack the bar
 * fully — the ellipsis is the safety net for the rare run-on that
 * has no clause break to cut at.
 */
const PILL_FIT_CHARS = 24;

/**
 * Don't register a clause-break char as a back-flush candidate until
 * the buffer has at least this many chars. Below this, splitting at
 * `、` produces a postage-stamp head segment ("彩苗醬，") that
 * flashes by before the operator can read it — better to keep the
 * sentence whole and let the back-flush algorithm handle the tail.
 */
const SOFT_BREAK_MIN_LEAD = 14;

/**
 * Streaming-mode soft-break threshold (legacy live-JA typewriter,
 * §5 Output language retired this from the active chat path — the
 * pill stays cursor-only during the stream now). Kept around so
 * `feedStreamingDelta` still produces sensible segments for any
 * future debug overlay that taps the raw stream.
 */
const SOFT_BREAK_MIN_LEN = 22;

const FADE_MS = 220;
const MIN_SEGMENT_HOLD_MS = 480;

/**
 * Pacing for the post-reply caption typewriter (`typewriteText`).
 * Calm, readable reveal speed for Chinese — fast enough to keep up with
 * a short Japanese audio clip on the happy path, slow enough that the
 * operator can actually follow per-character. Kept in sync with
 * `RENDERER_CAPTION_CHARS_PER_SEC` in main's `replyTts.ts` so the
 * coordinator's slot-hold window matches the on-screen timing.
 */
const REPLY_TYPEWRITER_CHARS_PER_SEC = 18;
const REPLY_TYPEWRITER_TICK_MS = Math.max(
  1,
  Math.round(1000 / REPLY_TYPEWRITER_CHARS_PER_SEC),
);

/**
 * Split a known-complete text into rolling-subtitle segments.
 *
 * Two-pass algorithm:
 *
 *   1. Sentence-bounded splitter with **back-flush at clause breaks**:
 *      hard sentence terminators (。！？) always flush; clause breaks
 *      (、，；：) are remembered as CANDIDATE break points and only
 *      committed when the buffer would otherwise overflow the pill.
 *      Net effect: a sentence with a comma 22 chars in but ending 5
 *      chars later stays whole instead of fracturing into a 22-char
 *      head and a 5-char flash-by tail.
 *
 *   2. Adjacent-short-sentence **merge** pass: consecutive segments
 *      whose concatenated length still fits the one-line pill are
 *      coalesced. Three brief replies like "嗯。" + "對呀。" +
 *      "我們去吧。" share the bar as a single static caption instead
 *      of strobing through three near-empty segments.
 *
 * Both passes respect `PILL_FIT_CHARS` (≈ the bar's real one-line
 * capacity) so the result fills the bar without leaning on the
 * `text-overflow: ellipsis` safety net.
 */
export function splitIntoSegments(text: string): string[] {
  const raw: string[] = [];
  let buf = '';
  // Length of `buf` (in UTF-16 code units, matching `buf.length`) at
  // the most recent clause-break char we'd be willing to split on.
  // 0 means "no candidate yet". Reset on every flush.
  let lastSoftBreakLen = 0;
  const flushBuf = (): void => {
    const trimmed = buf.trim();
    if (trimmed) raw.push(trimmed);
    buf = '';
    lastSoftBreakLen = 0;
  };
  for (const ch of text) {
    buf += ch;
    if (SEGMENT_END_CHARS.has(ch)) {
      flushBuf();
      continue;
    }
    if (SOFT_BREAK_CHARS.has(ch)) {
      // Already past the pill's one-line fit — this clause break is
      // exactly where we want to split. Commit immediately so we
      // don't keep growing into ellipsis territory.
      if (buf.length >= PILL_FIT_CHARS) {
        flushBuf();
      } else if (buf.length >= SOFT_BREAK_MIN_LEAD) {
        // Defer the decision — remember this as a candidate so we
        // can back-flush here later if the sentence overshoots.
        lastSoftBreakLen = buf.length;
      }
      // Below SOFT_BREAK_MIN_LEAD: ignore. Splitting at a "今天，..."
      // style comma 3 chars in would just shed a tiny head segment.
      continue;
    }
    // Non-break char. If we've sailed past PILL_FIT_CHARS AND we
    // banked a candidate clause break earlier in this sentence,
    // retroactively split at that candidate so the trailing tail
    // gets its own line instead of overflowing the pill.
    if (lastSoftBreakLen > 0 && buf.length >= PILL_FIT_CHARS) {
      const head = buf.slice(0, lastSoftBreakLen).trim();
      if (head) raw.push(head);
      buf = buf.slice(lastSoftBreakLen);
      lastSoftBreakLen = 0;
    }
  }
  const tail = buf.trim();
  if (tail) raw.push(tail);

  // Pass 2: merge adjacent short sentences that would still fit on
  // one line. Keeps the bar full instead of strobing through three
  // half-empty segments for a "嗯。對。是的。" reply.
  const merged: string[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + seg.length <= PILL_FIT_CHARS) {
      merged[merged.length - 1] = last + seg;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function isSegmentEnd(ch: string): boolean {
  return SEGMENT_END_CHARS.has(ch);
}

function isSoftBreak(ch: string): boolean {
  return SOFT_BREAK_CHARS.has(ch);
}

interface ControllerDeps {
  textEl: HTMLElement;
  cursorEl: HTMLElement;
}

/**
 * Streaming display states:
 *   • idle      — empty bar, nothing in flight.
 *   • typing    — currently revealing chars of `live`; new chars
 *                 append immediately (typewriter via the stream itself).
 *   • holding   — `live` finished with a terminator; sit on it until
 *                 either MIN_SEGMENT_HOLD_MS elapses AND the next
 *                 segment has at least one character available.
 *   • swapping  — fading out the bar to reveal the next segment.
 */
type StreamState = 'idle' | 'typing' | 'holding' | 'swapping';

export class SegmentedCaptionController {
  private readonly textEl: HTMLElement;
  private readonly cursorEl: HTMLElement;

  // Streaming-mode state.
  private streamingActive = false;
  private state: StreamState = 'idle';
  /** Text of the segment currently shown on the bar (drives the typewriter). */
  private live = '';
  /** Whether `live` has already received its terminating punctuation. */
  private liveTerminated = false;
  /** Earliest time we may crossfade off `live` (ms epoch). */
  private earliestSwapAt = 0;
  /** Chars buffered for the NEXT segment while we hold/swap. */
  private nextBuf = '';
  /** Completed-but-not-yet-shown segments. Drained FIFO. */
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private streamDrainResolvers: Array<() => void> = [];

  // Audio-mode state.
  private audioCleanup: (() => void) | null = null;

  // Reply-typewriter state (used by `typewriteText`).
  private typewriterTimer: ReturnType<typeof setInterval> | null = null;
  private typewriterResolve: (() => void) | null = null;

  // Abort handle for the multi-segment reply playback (preview +
  // typewriteSegments fallback). A fresh `reset()` aborts any in-flight
  // segment loop so a new turn doesn't race the previous reply's tail.
  private replyAbort: AbortController | null = null;

  constructor(deps: ControllerDeps) {
    this.textEl = deps.textEl;
    this.cursorEl = deps.cursorEl;
  }

  /** Has anything been displayed since the last reset? */
  get hasContent(): boolean {
    return (
      this.live.length > 0 ||
      this.nextBuf.length > 0 ||
      this.pending.length > 0 ||
      this.textEl.textContent !== ''
    );
  }

  reset(): void {
    this.cancelAudioMode();
    this.cancelStreamingMode();
    this.cancelTypewriter();
    this.cancelReplyPlayback();
    this.textEl.classList.remove('swapping');
    this.textEl.textContent = '';
    this.cursorEl.hidden = true;
  }

  beginStreaming(): void {
    this.reset();
    this.streamingActive = true;
    this.state = 'idle';
    this.live = '';
    this.liveTerminated = false;
    this.nextBuf = '';
    this.pending = [];
    this.cursorEl.hidden = false;
  }

  feedStreamingDelta(delta: string): void {
    if (!this.streamingActive) this.beginStreaming();
    if (!delta) return;

    for (const ch of delta) {
      if (this.state === 'idle' || this.state === 'typing') {
        // Append to the current segment; the bar updates live.
        this.live += ch;
        this.state = 'typing';
        this.liveTerminated = false;
        this.textEl.textContent = this.live;

        if (isSegmentEnd(ch)) {
          this.markLiveTerminated();
        } else if (
          isSoftBreak(ch) &&
          this.live.length >= SOFT_BREAK_MIN_LEN
        ) {
          this.markLiveTerminated();
        }
        continue;
      }

      // state ∈ { 'holding', 'swapping' } — `live` is sealed; route
      // incoming chars to `nextBuf` until we can swap.
      this.nextBuf += ch;
      if (isSegmentEnd(ch)) {
        this.flushNextBufToPending();
      } else if (isSoftBreak(ch) && this.nextBuf.length >= SOFT_BREAK_MIN_LEN) {
        this.flushNextBufToPending();
      }
    }

    this.pump();
  }

  /**
   * Stream end. Drains any in-flight buffers, then resolves when the
   * caption has caught up to the final state on screen.
   */
  endStreaming(): Promise<void> {
    if (!this.streamingActive) return Promise.resolve();
    // Any tail buffers that didn't hit a terminator become final segments.
    if (this.state === 'typing' && !this.liveTerminated && this.live.length > 0) {
      this.liveTerminated = true;
      this.state = 'holding';
      this.earliestSwapAt = Date.now() + MIN_SEGMENT_HOLD_MS;
    }
    if (this.nextBuf.length > 0) {
      this.flushNextBufToPending();
    }
    this.pump();

    if (this.isDrained()) {
      return this.finishStreaming();
    }
    return new Promise((resolve) => {
      this.streamDrainResolvers.push(() => {
        void this.finishStreaming().then(resolve);
      });
    });
  }

  /**
   * Drive the caption from an audio clip's timeline. Splits `fullText`
   * into segments and assigns each a slice of the audio duration
   * proportional to its character count; crossfades the bar at each
   * boundary. Returns a Promise that resolves on 'ended' / 'error'.
   *
   * `clearBeforeAudio: true` is the chunked-TTS path — the bar is
   * already showing either the segment-0 preview (chunk 0) or the
   * previous chunk's tail text (chunk N+1). We want to crossfade off
   * that and start a fresh karaoke pass anchored at `audio.currentTime`
   * for THIS chunk. The fade kicks off **synchronously at function
   * entry** so it overlaps with the audio element's own load / buffer
   * window — by the time the first `timeupdate` fires (~250 ms after
   * `audio.play()`) the fade is already done and apply() can paint
   * partial chars in lockstep with audio time. The old behavior
   * deferred the fade to the first apply() call, so the bar visibly
   * sat on the previous chunk's text for ~250 ms before the fade
   * even started — for short chunks (~1–1.5 s WAVs) that meant the
   * operator watched the previous sentence's caption straight through
   * the first quarter of the new sentence's audio.
   */
  playWithAudio(args: {
    fullText: string;
    audio: HTMLAudioElement;
    /**
     * When true, the bar crossfades off whatever it's currently
     * showing right when this call starts (eagerly, in parallel with
     * the audio element's load), then starts karaoke from char 0 of
     * the new text — synced to `audio.currentTime` as it advances.
     */
    clearBeforeAudio: boolean;
    /**
     * Fallback playback duration in seconds. Used by `apply()` when
     * `HTMLAudioElement.duration` reports `NaN` / `Infinity` — Chromium
     * does this intermittently for our custom-protocol stream until it
     * has consumed enough of the body to commit to a finite value
     * (`durationchange` can land arbitrarily late, sometimes mid-chunk).
     * Without this fallback the karaoke pass stays blank for the
     * first half of the audio on the affected chunks, then snaps to
     * the audio's current position when `durationchange` finally fires.
     *
     * Main derives this from the WAV's RIFF header on disk and passes
     * it through {@link ReplyChunkPayload.audioDurationMs}.
     */
    knownDurationSec?: number;
  }): Promise<void> {
    // Tear down EVERY other write path before taking over the bar.
    // In particular, the post-reply pipeline ships translation first
    // (~1–2 s) and audio later (~10–30 s); the renderer typewriters
    // segment 0 via `previewFirstSegment` while waiting for the WAV.
    // That preview installs a setInterval that writes into textContent
    // every ~55 ms — if we don't abort it here, when audio finally
    // lands the preview keeps ticking AND `apply()` only writes on the
    // browser's slower `timeupdate` cadence, so the preview wins the
    // race and the bar looks frozen on segment 0 while audio plays
    // past it. Same hazard for any in-flight `typewriteText` /
    // `typewriteSegments` left over from a prior turn.
    this.cancelAudioMode();
    this.cancelStreamingMode();
    this.cancelTypewriter();
    this.cancelReplyPlayback();
    this.cursorEl.hidden = true;

    const segments = splitIntoSegments(args.fullText);
    if (segments.length === 0) {
      this.textEl.classList.remove('swapping');
      this.textEl.textContent = args.fullText;
      return Promise.resolve();
    }

    const totalChars = segments.reduce((s, seg) => s + seg.length, 0) || 1;
    const segmentStarts: number[] = [];
    {
      let cum = 0;
      for (const seg of segments) {
        segmentStarts.push(cum / totalChars);
        cum += seg.length;
      }
      segmentStarts.push(1);
    }

    // `currentIdx` starts negative so the very first apply() always
    // takes the "first segment" branch, regardless of whether the
    // pill was already showing the streamed copy of segment 0.
    let currentIdx = -1;
    let lastRevealed = -1;
    let swapPending = false;
    let alive = true;
    let eagerFadeTimer: ReturnType<typeof setTimeout> | null = null;
    let midSegmentSwapTimer: ReturnType<typeof setTimeout> | null = null;

    const showFull = (idx: number): void => {
      currentIdx = idx;
      this.textEl.classList.remove('swapping');
      this.textEl.textContent = segments[idx]!;
      lastRevealed = segments[idx]!.length;
    };

    const showPartial = (idx: number, chars: number): void => {
      if (idx !== currentIdx) {
        currentIdx = idx;
        lastRevealed = -1;
      }
      const seg = segments[idx]!;
      const n = Math.max(0, Math.min(seg.length, chars));
      if (n !== lastRevealed) {
        this.textEl.textContent = seg.slice(0, n);
        lastRevealed = n;
      }
    };

    // Mid-audio segment crossfade. Used only for multi-segment chunks
    // when audio.currentTime crosses a segment boundary inside a single
    // WAV — fades the previous segment off, then snaps the next
    // segment in at the karaoke position. The initial pendingClear
    // crossfade is handled eagerly below, not here.
    const swapIntoAudio = (idx: number, targetChars: number): void => {
      swapPending = true;
      this.textEl.classList.add('swapping');
      midSegmentSwapTimer = setTimeout(() => {
        midSegmentSwapTimer = null;
        if (!alive) return;
        this.textEl.textContent = '';
        this.textEl.classList.remove('swapping');
        currentIdx = idx;
        lastRevealed = -1;
        showPartial(idx, targetChars);
        swapPending = false;
      }, FADE_MS);
    };

    const apply = (): void => {
      if (swapPending) return;
      let d = args.audio.duration;
      if (!Number.isFinite(d) || d <= 0) {
        // Browser hasn't committed a finite duration yet (Chromium's
        // streaming-audio quirk on the cortana-asset protocol). Fall
        // back to the WAV-header-derived value main passed alongside
        // the URL so the karaoke pass can start anyway — otherwise the
        // bar sits blank until `durationchange` finally fires, which
        // can be well into the chunk's playback.
        if (args.knownDurationSec && args.knownDurationSec > 0) {
          d = args.knownDurationSec;
        } else {
          return;
        }
      }
      const t = Math.min(1, Math.max(0, args.audio.currentTime / d));

      let idx = segments.length - 1;
      for (let i = 0; i < segments.length; i += 1) {
        if (t < segmentStarts[i + 1]!) {
          idx = i;
          break;
        }
      }
      const segStart = segmentStarts[idx]!;
      const segEnd = segmentStarts[idx + 1]!;
      const segSpan = Math.max(1e-6, segEnd - segStart);
      const localT = Math.min(1, Math.max(0, (t - segStart) / segSpan));
      const seg = segments[idx]!;
      const targetChars = Math.min(seg.length, Math.ceil(localT * seg.length));

      if (idx !== currentIdx && currentIdx >= 0) {
        // Segment boundary mid-audio: crossfade out, then snap in.
        swapIntoAudio(idx, targetChars);
        return;
      }
      if (idx !== currentIdx && currentIdx < 0) {
        currentIdx = idx;
        lastRevealed = -1;
      }
      showPartial(idx, targetChars);
    };

    // Eager initial crossfade. Runs in parallel with the audio
    // element's own load/buffer window (since `audio.play()` is called
    // synchronously by the caller right after this function returns),
    // so by the time the first `timeupdate` fires the bar is already
    // empty and apply() can start the karaoke pass anchored at the
    // real audio.currentTime. Without this, apply() used to wait
    // ~250 ms for the first timeupdate before even kicking off the
    // 220 ms fade-out, leaving the previous chunk's caption visible
    // through the first ~470 ms of the new chunk's audio — i.e. the
    // "audio plays first, text catches up later" symptom on short
    // chunks.
    if (args.clearBeforeAudio) {
      swapPending = true;
      this.textEl.classList.add('swapping');
      eagerFadeTimer = setTimeout(() => {
        eagerFadeTimer = null;
        if (!alive) return;
        this.textEl.textContent = '';
        this.textEl.classList.remove('swapping');
        swapPending = false;
        // Audio may have already started playing during the fade —
        // run apply() now so the karaoke pass doesn't have to wait
        // for the next timeupdate to paint segment 0's first char.
        apply();
      }, FADE_MS);
    }

    const onTimeUpdate = (): void => apply();
    const onPlaying = (): void => apply();
    const onLoaded = (): void => apply();
    // `durationchange` fires when Chromium commits (or revises) the
    // duration value. Important for the custom-protocol path where
    // `loadedmetadata` can land with `duration = Infinity` and the
    // real finite value only shows up on a later `durationchange`.
    const onDurationChange = (): void => apply();

    return new Promise<void>((resolve) => {
      const cleanup = (): void => {
        alive = false;
        if (eagerFadeTimer !== null) {
          clearTimeout(eagerFadeTimer);
          eagerFadeTimer = null;
        }
        if (midSegmentSwapTimer !== null) {
          clearTimeout(midSegmentSwapTimer);
          midSegmentSwapTimer = null;
        }
        args.audio.removeEventListener('timeupdate', onTimeUpdate);
        args.audio.removeEventListener('playing', onPlaying);
        args.audio.removeEventListener('loadedmetadata', onLoaded);
        args.audio.removeEventListener('durationchange', onDurationChange);
        args.audio.removeEventListener('ended', onEnded);
        args.audio.removeEventListener('error', onError);
        this.audioCleanup = null;
      };
      const onEnded = (): void => {
        showFull(segments.length - 1);
        cleanup();
        resolve();
      };
      const onError = (): void => {
        showFull(segments.length - 1);
        cleanup();
        resolve();
      };
      this.audioCleanup = cleanup;
      args.audio.addEventListener('timeupdate', onTimeUpdate);
      args.audio.addEventListener('playing', onPlaying);
      args.audio.addEventListener('loadedmetadata', onLoaded);
      args.audio.addEventListener('durationchange', onDurationChange);
      args.audio.addEventListener('ended', onEnded);
      args.audio.addEventListener('error', onError);
    });
  }

  cancelAudioMode(): void {
    this.audioCleanup?.();
    this.audioCleanup = null;
  }

  /**
   * Reveal `text` one character at a time at a fixed natural pace
   * (`REPLY_TYPEWRITER_CHARS_PER_SEC`). Tears down any streaming /
   * audio-karaoke / prior typewriter state first, then types into
   * the bar with the cursor visible. Resolves when the last char
   * has landed.
   *
   * Used for one-shot non-chunked typewriter passes — e.g. error
   * messages painted into the caption pill. The chunked-TTS reply
   * path uses `playWithAudio` per chunk for the karaoke sync, and
   * `typewriteSegments` for per-chunk and whole-reply typewriter
   * fallbacks; this single-segment helper stays around for the
   * surfaces that just want a quick monolithic line.
   */
  typewriteText(text: string): Promise<void> {
    this.cancelAudioMode();
    this.cancelStreamingMode();
    this.cancelTypewriter();
    this.textEl.classList.remove('swapping');
    this.textEl.textContent = '';
    if (!text) {
      this.cursorEl.hidden = true;
      return Promise.resolve();
    }
    // The character iteration uses Array.from so combining surrogate
    // pairs (rare in 繁中 captions but possible for emoji fallbacks)
    // advance one user-perceived glyph per tick instead of one UTF-16
    // code unit.
    const chars = Array.from(text);
    let i = 0;
    this.cursorEl.hidden = false;
    return new Promise<void>((resolve) => {
      this.typewriterResolve = resolve;
      this.typewriterTimer = setInterval(() => {
        if (i >= chars.length) {
          this.finishTypewriter();
          return;
        }
        i += 1;
        this.textEl.textContent = chars.slice(0, i).join('');
      }, REPLY_TYPEWRITER_TICK_MS);
    });
  }

  cancelTypewriter(): void {
    if (this.typewriterTimer !== null) {
      clearInterval(this.typewriterTimer);
      this.typewriterTimer = null;
    }
    if (this.typewriterResolve) {
      const resolve = this.typewriterResolve;
      this.typewriterResolve = null;
      resolve();
    }
  }

  private finishTypewriter(): void {
    if (this.typewriterTimer !== null) {
      clearInterval(this.typewriterTimer);
      this.typewriterTimer = null;
    }
    this.cursorEl.hidden = true;
    if (this.typewriterResolve) {
      const resolve = this.typewriterResolve;
      this.typewriterResolve = null;
      resolve();
    }
  }

  /**
   * Replace whatever is on the bar with `text` using the same fade-out
   * → fade-in transition as the segment swap. Used when post-reply TTS
   * is unavailable but a fresh translation still wants to take over
   * the bar (Japanese typewriter on screen → translated 繁中 caption).
   *
   * Tears down any streaming / audio modes first so the new text isn't
   * immediately overwritten by a late delta or audio timeupdate.
   */
  swapCaptionTo(text: string): void {
    this.cancelAudioMode();
    this.cancelStreamingMode();
    this.cancelTypewriter();
    this.cursorEl.hidden = true;
    this.textEl.classList.add('swapping');
    setTimeout(() => {
      this.textEl.classList.remove('swapping');
      this.textEl.textContent = text;
    }, FADE_MS);
  }

  /**
   * Show the FIRST sentence of `text` while we wait for the matching
   * TTS audio to land. Typewriters segment 0 at the calm reply pace
   * and leaves the cursor visible after the last char — the operator
   * reads "she's started speaking, more is coming" instead of staring
   * at an empty bar for the ~10–30 s Gemini TTS synthesis takes.
   *
   * Caller is expected to follow up with `playWithAudio` once the WAV
   * arrives (which crossfades segment 0 → audio-synced karaoke through
   * the rest), or `typewriteSegments` if audio never lands.
   */
  previewFirstSegment(text: string): Promise<void> {
    this.cancelAudioMode();
    this.cancelStreamingMode();
    this.cancelTypewriter();
    this.cancelReplyPlayback();
    this.textEl.classList.remove('swapping');
    const segments = splitIntoSegments(text);
    const first = segments[0] ?? text;
    if (!first) {
      this.textEl.textContent = '';
      this.cursorEl.hidden = true;
      return Promise.resolve();
    }
    const abort = new AbortController();
    this.replyAbort = abort;
    return this.typewriteSegmentChars(first, abort.signal, {
      hideCursorAtEnd: false,
    }).finally(() => {
      if (this.replyAbort === abort) this.replyAbort = null;
    });
  }

  /**
   * Fallback for when post-reply TTS never lands (no Gemini key, quota
   * blip, total outage). Types each sentence-sized segment of `text`
   * out one at a time at the calm reply pace, holding briefly between
   * segments and crossfading via the same `.swapping` opacity hook the
   * streaming path uses. Same rhythm `playWithAudio` would produce —
   * just driven by a wall-clock estimate instead of `audio.currentTime`.
   *
   * Resolves once the final segment has been revealed (or the
   * controller is reset / pre-empted, whichever happens first).
   */
  async typewriteSegments(text: string): Promise<void> {
    this.cancelAudioMode();
    this.cancelStreamingMode();
    this.cancelTypewriter();
    this.cancelReplyPlayback();
    this.textEl.classList.remove('swapping');
    const segments = splitIntoSegments(text);
    if (segments.length === 0) {
      this.textEl.textContent = '';
      this.cursorEl.hidden = true;
      return;
    }
    const abort = new AbortController();
    this.replyAbort = abort;
    const HOLD_BETWEEN_SEGMENTS_MS = 600;
    try {
      for (let i = 0; i < segments.length; i += 1) {
        if (abort.signal.aborted) return;
        const seg = segments[i]!;
        if (i > 0) {
          this.textEl.classList.add('swapping');
          await this.sleep(FADE_MS, abort.signal);
          if (abort.signal.aborted) return;
          this.textEl.textContent = '';
          this.textEl.classList.remove('swapping');
        }
        await this.typewriteSegmentChars(seg, abort.signal, {
          hideCursorAtEnd: i === segments.length - 1,
        });
        if (abort.signal.aborted) return;
        if (i < segments.length - 1) {
          this.cursorEl.hidden = false;
          await this.sleep(HOLD_BETWEEN_SEGMENTS_MS, abort.signal);
        }
      }
    } finally {
      if (this.replyAbort === abort) this.replyAbort = null;
    }
  }

  /** Aborts any in-flight `previewFirstSegment` / `typewriteSegments` loop. */
  cancelReplyPlayback(): void {
    if (this.replyAbort) {
      this.replyAbort.abort();
      this.replyAbort = null;
    }
  }

  private typewriteSegmentChars(
    seg: string,
    signal: AbortSignal,
    opts: { hideCursorAtEnd: boolean },
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const chars = Array.from(seg);
      let i = 0;
      this.cursorEl.hidden = false;
      this.textEl.textContent = '';
      const timer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (i >= chars.length) {
          clearInterval(timer);
          if (opts.hideCursorAtEnd) this.cursorEl.hidden = true;
          resolve();
          return;
        }
        i += 1;
        this.textEl.textContent = chars.slice(0, i).join('');
      }, REPLY_TYPEWRITER_TICK_MS);
      signal.addEventListener(
        'abort',
        () => {
          clearInterval(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  // -------------------- streaming internals --------------------

  private markLiveTerminated(): void {
    this.liveTerminated = true;
    this.state = 'holding';
    this.earliestSwapAt = Date.now() + MIN_SEGMENT_HOLD_MS;
    this.scheduleHoldTimer();
  }

  private scheduleHoldTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const wait = Math.max(0, this.earliestSwapAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, wait);
  }

  private flushNextBufToPending(): void {
    const trimmed = this.nextBuf.trim();
    if (trimmed) this.pending.push(trimmed);
    this.nextBuf = '';
  }

  /**
   * Make forward progress: if we're holding `live` and there's now a
   * "next" segment available (either fully buffered in `pending` or
   * partially in `nextBuf`), and the hold time has elapsed, crossfade.
   */
  private pump(): void {
    if (this.state === 'swapping') return;
    if (this.state === 'idle' || this.state === 'typing') {
      this.maybeResolveDrains();
      return;
    }

    // state === 'holding'
    const now = Date.now();
    if (now < this.earliestSwapAt) {
      this.scheduleHoldTimer();
      return;
    }

    const next = this.consumeNextSegmentForSwap();
    if (next === null) {
      // No next segment buffered yet — park here. Future deltas will
      // trigger pump() again once the next sentence starts.
      this.maybeResolveDrains();
      return;
    }
    this.swapTo(next);
  }

  /**
   * If a queued segment exists, pop it. Otherwise if `nextBuf` has any
   * content, lift it (even if not terminated) so the typewriter can
   * continue inside the swapped-in segment.
   */
  private consumeNextSegmentForSwap(): string | null {
    if (this.pending.length > 0) {
      return this.pending.shift()!;
    }
    if (this.nextBuf.length > 0) {
      const seg = this.nextBuf;
      this.nextBuf = '';
      return seg;
    }
    return null;
  }

  private swapTo(nextSegment: string): void {
    this.state = 'swapping';
    this.textEl.classList.add('swapping');
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.textEl.textContent = '';
      this.textEl.classList.remove('swapping');
      // Promote nextSegment to `live`. It may still grow (if the
      // model is still streaming into it via nextBuf in a prior turn,
      // we'd have already taken nextBuf above — so any future chars
      // arrive fresh into `live` again via the typing branch).
      this.live = nextSegment;
      this.textEl.textContent = this.live;
      // Was the popped segment already terminated? Heuristic: if it
      // ended with a known terminator, treat it as already-complete
      // and immediately hold (waiting for the *next* nextBuf). If
      // not, resume typing — additional deltas will keep extending.
      const last = nextSegment[nextSegment.length - 1];
      if (last !== undefined && isSegmentEnd(last)) {
        this.liveTerminated = true;
        this.state = 'holding';
        this.earliestSwapAt = Date.now() + MIN_SEGMENT_HOLD_MS;
        this.scheduleHoldTimer();
      } else {
        this.liveTerminated = false;
        this.state = 'typing';
      }
      // After a swap, the queue / nextBuf may already have more
      // content waiting. Re-pump.
      this.pump();
    }, FADE_MS);
  }

  private isDrained(): boolean {
    return (
      this.pending.length === 0 &&
      this.nextBuf.length === 0 &&
      (this.state === 'idle' || this.state === 'holding' || this.state === 'typing')
    );
  }

  private maybeResolveDrains(): void {
    if (!this.isDrained()) return;
    const resolvers = this.streamDrainResolvers;
    this.streamDrainResolvers = [];
    for (const r of resolvers) r();
  }

  private async finishStreaming(): Promise<void> {
    this.streamingActive = false;
    this.cursorEl.hidden = true;
  }

  private cancelStreamingMode(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.streamingActive = false;
    this.state = 'idle';
    this.live = '';
    this.liveTerminated = false;
    this.nextBuf = '';
    this.pending = [];
    const resolvers = this.streamDrainResolvers;
    this.streamDrainResolvers = [];
    for (const r of resolvers) r();
  }
}
