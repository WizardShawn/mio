import type {
  AttachedImage,
  ChatApi,
  ChatStreamEvent,
  ChatToolActivityPayload,
  ReplyCaptionPayload,
  ReplyChunkPayload,
  UtterancePayload,
} from '@shared/ipc';

import { SegmentedCaptionController } from './segmentedCaption';

declare global {
  interface Window {
    chatApi: ChatApi;
  }
}

const captionEl = document.getElementById('caption') as HTMLDivElement;
const captionTextEl = document.getElementById('caption-text') as HTMLSpanElement;
const captionCursorEl = captionEl.querySelector('.cursor') as HTMLSpanElement;

// Single-line YouTube-subtitle controller. Rotates through sentence-
// sized segments with a soft crossfade between them so multi-sentence
// replies don't get truncated on the one-line bar.
const captionController = new SegmentedCaptionController({
  textEl: captionTextEl,
  cursorEl: captionCursorEl,
});
const composerEl = document.getElementById('composer') as HTMLDivElement;
const inputEl = document.getElementById('input') as HTMLInputElement;
const apiWarningEl = document.getElementById('api-warning') as HTMLDivElement;
const openSettingsBtn = document.getElementById(
  'open-settings',
) as HTMLButtonElement;

const attachmentEl = document.getElementById('attachment') as HTMLDivElement;
const attachmentThumbEl = document.getElementById(
  'attachment-thumb',
) as HTMLImageElement;
const attachmentRemoveBtn = document.getElementById(
  'attachment-remove',
) as HTMLButtonElement;

// How long caption + composer stay visible after the assistant stops
// speaking before they fade out together. Generous on purpose — long
// enough to comfortably read her reply and start typing a follow-up
// before the surface goes quiet. Any keystroke in the input pill (see
// the `inputEl` keydown handler) resets this timer so the surface
// doesn't yank itself away mid-thought.
const AMBIENT_HOLD_MS = 20000;

/** Must match `.pill.fading-out { animation: pill-out … }` in style.css */
const PILL_FADE_OUT_MS = 420;

// Anthropic image-block media types we accept on paste. Anything else
// (e.g. SVG, BMP, TIFF) is rejected with a quiet console warning rather
// than silently re-encoded — we'd rather the user notice an unsupported
// format than burn a request on a frame Claude won't read.
const SUPPORTED_PASTE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

let streaming = false;
let ambientHideTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAttachment: AttachedImage | null = null;
let pendingAttachmentBlobUrl: string | null = null;

function showPill(el: HTMLElement): void {
  el.classList.remove('fading-out');
  el.hidden = false;
}

function fadeOutPill(el: HTMLElement, durationMs = PILL_FADE_OUT_MS): void {
  if (el.hidden) return;
  el.classList.add('fading-out');
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove('fading-out');
  }, durationMs);
}

function fadeOutAmbientPills(): void {
  fadeOutPill(captionEl);
  fadeOutPill(composerEl);
  // Drop any pasted attachment when the surface goes quiet — the chip
  // is composer state, not assistant state, so it should never linger
  // across an ambient fade.
  clearAttachment();
}

function clearAmbientHideTimer(): void {
  if (ambientHideTimer !== null) {
    clearTimeout(ambientHideTimer);
    ambientHideTimer = null;
  }
}

function scheduleAmbientHide(): void {
  clearAmbientHideTimer();
  ambientHideTimer = setTimeout(
    () => fadeOutAmbientPills(),
    AMBIENT_HOLD_MS,
  );
}

function resetCaption(): void {
  captionController.reset();
}

/**
 * Show the caption pill in "thinking" state — empty bar with the
 * blinking cursor visible. We do NOT type the streaming Japanese into
 * the pill any more (the operator reads 繁中 only — see §5 Output
 * language in the dev plan). The pill stays in this state from
 * stream-start until the post-reply ZH translation lands via
 * `ChatReplyCaption`, at which point the audio-synced playback rolls
 * sentences through the bar as Mio speaks them.
 */
function startCaption(): void {
  clearAmbientHideTimer();
  // Tear down any prior reply state (typewriter mid-flight, audio
  // playing, segmented stream from an earlier turn, and the pending
  // ChatReplyCaption/Audio buffers for the previous turn) so the
  // cursor we show now isn't sitting on top of stale text and a late
  // IPC from the previous turn can't bleed into this one.
  stopActiveUtterance();
  resetPendingReply();
  captionController.reset();
  captionController.beginStreaming();
  // Drop any leftover red warning tint / tool-activity dim from a prior turn.
  captionTextEl.classList.remove('alert');
  captionTextEl.classList.remove('tool-activity');
  showPill(captionEl);
}

function finishStreamingPhase(): void {
  // The Anthropic stream has ended. The caption pill stays in
  // "thinking" state (cursor visible, no text) until `ChatReplyCaption`
  // ships the translation; do NOT fade the bar yet, and do NOT
  // schedule the ambient-hide timer — that timer is owned by the
  // post-reply path (`playReplyCaption` / audio.ended) so it only
  // starts counting after the operator has had a chance to read the
  // translation. If both translation and TTS fail (no Gemini key,
  // total outage) the safety-net timer below catches it.
  scheduleStreamEndSafetyNet();
}

// If neither ChatReplyCaption nor any ChatReplyChunk lands within this
// window after stream end, fade the pill so we don't leave a dangling
// "thinking" cursor on screen forever. Generous on purpose — covers
// realistic Gemini TTS + translation latency on a cold cache.
const POST_STREAM_SAFETY_NET_MS = 30000;
let postStreamSafetyTimer: ReturnType<typeof setTimeout> | null = null;

function clearStreamEndSafetyNet(): void {
  if (postStreamSafetyTimer !== null) {
    clearTimeout(postStreamSafetyTimer);
    postStreamSafetyTimer = null;
  }
}

function scheduleStreamEndSafetyNet(): void {
  clearStreamEndSafetyNet();
  postStreamSafetyTimer = setTimeout(() => {
    postStreamSafetyTimer = null;
    // If the post-reply path has already taken over (typewriter or
    // audio active, or the bar shows real text), do nothing. Otherwise
    // the surface has been "thinking" with no follow-through — fade.
    if (activeUtterance !== null) return;
    if (captionController.hasContent) {
      scheduleAmbientHide();
    } else {
      fadeOutAmbientPills();
    }
  }, POST_STREAM_SAFETY_NET_MS);
}

function showInput(): void {
  showPill(composerEl);
  // Microtask so focus actually lands after the pill becomes visible —
  // hidden elements can't receive focus on Chromium.
  setTimeout(() => inputEl.focus(), 0);
}

function hideInput(): void {
  inputEl.value = '';
  clearAttachment();
  fadeOutPill(composerEl);
}

function clearAttachment(): void {
  pendingAttachment = null;
  if (pendingAttachmentBlobUrl) {
    URL.revokeObjectURL(pendingAttachmentBlobUrl);
    pendingAttachmentBlobUrl = null;
  }
  attachmentThumbEl.removeAttribute('src');
  attachmentEl.hidden = true;
  attachmentEl.classList.remove('fading-out');
}

function setAttachment(image: AttachedImage, previewBlob: Blob): void {
  // Replace any existing attachment — only one image per turn in v1, to
  // keep the chip slot and the API payload simple.
  clearAttachment();
  pendingAttachment = image;
  pendingAttachmentBlobUrl = URL.createObjectURL(previewBlob);
  attachmentThumbEl.src = pendingAttachmentBlobUrl;
  showPill(attachmentEl);
}

async function refreshApiKeyStatus(): Promise<void> {
  const status = await window.chatApi.apiKey.status();
  if (!status.hasKey) {
    apiWarningEl.hidden = false;
  } else {
    apiWarningEl.hidden = true;
  }
}

async function handleSend(): Promise<void> {
  if (streaming) return;
  const text = inputEl.value.trim();
  if (!text && !pendingAttachment) return;

  const attachment = pendingAttachment;

  inputEl.value = '';
  streaming = true;
  // Pin the typing bar in place under her reply for the duration of the
  // stream — explicitly re-asserting the visible state in case any prior
  // ambient-fade animation was mid-flight. The composer must not fade
  // while she's speaking; both pills only fade together after the reply
  // finishes (see `scheduleAmbientHide`).
  showPill(composerEl);
  // Hide the chip immediately on send. The image itself has already
  // been captured into `attachment` above, so the chip's job is done
  // — leaving it visible would confusingly suggest a NEW attachment
  // is sitting in the composer for the next turn.
  clearAttachment();
  startCaption();

  try {
    await window.chatApi.sendMessage(
      text,
      attachment ? { manualImage: attachment } : undefined,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to send message.';
    // Errors get surfaced via the caption typewriter so the operator
    // sees them in the pill instead of a silent fail. Same path the
    // post-reply translation uses.
    void captionController.typewriteText(`[error] ${msg}`).then(() => {
      scheduleAmbientHide();
    });
    streaming = false;
  }
}

// Cached pre-recorded greeting (or any future TTS-backed utterance).
// Lives outside the Claude stream — main fires `play-utterance` whenever
// it wants the chat surface to speak without spending API tokens.
let activeUtterance: HTMLAudioElement | null = null;

function stopActiveUtterance(): void {
  captionController.cancelAudioMode();
  if (activeUtterance) {
    activeUtterance.pause();
    activeUtterance.src = '';
    activeUtterance = null;
  }
}

function playUtterance(payload: UtterancePayload): void {
  if (streaming) return;
  stopActiveUtterance();
  captionTextEl.classList.remove('alert');

  if (payload.audioOnly) {
    // Post-reply TTS + translation: the Japanese caption was just
    // typed live during the stream; this payload carries the 繁中
    // translation (the caption we WANT to land on) and — when Gemini
    // TTS succeeded — the matching Japanese audio. We crossfade the
    // streamed Japanese off and karaoke-sync the translated subtitle
    // to audio time.
    const fullText = payload.text.trim();
    if (!fullText) return;
    clearAmbientHideTimer();
    showPill(captionEl);
    captionCursorEl.hidden = true;

    if (!payload.audioUrl) {
      // Translation arrived but TTS failed (no Gemini key, network blip,
      // quota): still swap the bar to the translated caption so the
      // operator sees the 繁中 version they expect, just without audio.
      captionController.swapCaptionTo(fullText);
      scheduleAmbientHide();
      return;
    }

    try {
      const audio = new Audio(payload.audioUrl);
      activeUtterance = audio;
      void captionController.playWithAudio({
        fullText,
        audio,
        clearBeforeAudio: true,
      }).then(() => {
        if (activeUtterance === audio) activeUtterance = null;
        scheduleAmbientHide();
      });
      void audio.play().catch((err) => {
        console.warn('[chat] utterance play() rejected', err);
        captionController.cancelAudioMode();
        if (activeUtterance === audio) activeUtterance = null;
        captionTextEl.textContent = fullText;
        scheduleAmbientHide();
      });
    } catch (err) {
      console.warn('[chat] utterance setup failed', err);
      scheduleAmbientHide();
    }
    return;
  }

  // Greeting / standalone utterance with both text and audio.
  if (!payload.text) return;
  const fullText = payload.text.trim();
  clearAmbientHideTimer();
  showPill(captionEl);
  captionCursorEl.hidden = true;
  captionController.reset();

  if (payload.audioUrl) {
    try {
      const audio = new Audio(payload.audioUrl);
      activeUtterance = audio;
      void captionController.playWithAudio({
        fullText,
        audio,
        clearBeforeAudio: false,
      }).then(() => {
        if (activeUtterance === audio) activeUtterance = null;
        scheduleAmbientHide();
      });
      void audio.play().catch((err) => {
        console.warn('[chat] utterance play() rejected', err);
        captionController.cancelAudioMode();
        if (activeUtterance === audio) activeUtterance = null;
        captionTextEl.textContent = fullText;
        scheduleAmbientHide();
      });
    } catch (err) {
      console.warn('[chat] utterance setup failed', err);
      captionTextEl.textContent = fullText;
      scheduleAmbientHide();
    }
  } else {
    // No audio (e.g. no Gemini key configured) — just show the caption
    // and let the ambient timer reclaim the surface.
    captionTextEl.textContent = fullText;
    scheduleAmbientHide();
  }
}

window.chatApi.onPlayUtterance(playUtterance);

// ---------- Post-reply chunked-TTS coordinator ----------
//
// Main splits Mio's full Japanese reply into sentence-sized chunks,
// fires Gemini TTS for each chunk in parallel, and ships chunks
// independently the moment each one's WAV resolves. Two arrival
// streams hit the renderer:
//
//   • `ChatReplyCaption` — fires once when the full Gemini JA→ZH
//     translation lands (~1–2 s after stream end). Drives the
//     "starting to speak" preview that types segment 0 of the full
//     translation while the chunks finish synthesizing.
//
//   • `ChatReplyChunk` — fires N times, once per JA sentence chunk,
//     in whatever order their TTS calls resolve. Carries that chunk's
//     ZH-text slice + WAV URL (or `audioUrl: null` if Gemini TTS
//     failed for that chunk). The renderer queues chunks by index,
//     plays them sequentially, and drives the caption pill's segment
//     progression off the chunk's OWN `audio.currentTime` — so
//     crossfades happen at REAL speech boundaries, not character-
//     proportional estimates of a monolithic 30 s WAV.
//
// Failure modes:
//   • One chunk's TTS fails → that chunk types out at the calm reply
//     pace, then we continue to the next chunk (no retry, no freeze).
//   • All chunks fail / never arrive → the no-chunk fallback timer
//     trips and we typewriter the full ZH translation end-to-end.
//   • Translation never arrives but chunks do → renderer plays each
//     chunk against the JA fallback main slipped into `zhText`.

interface ChunkData {
  zhText: string;
  audioUrl: string | null;
  /**
   * WAV duration (ms) main computed from the on-disk header. Used as
   * a fallback in `playWithAudio` when `HTMLAudioElement.duration`
   * reports `Infinity` for the custom-protocol stream — without it,
   * the karaoke pass stays blank until `durationchange` fires, which
   * on the affected chunks can be ~halfway through audio playback.
   */
  audioDurationMs?: number;
}

interface PendingReply {
  /** Full ZH translation from `ChatReplyCaption` — drives the preview only. */
  fullText: string | null;
  /** Total chunks main is producing (set on first chunk arrival). */
  totalChunks: number | null;
  /** Buffered chunks indexed by `chunkIndex`. */
  chunks: Map<number, ChunkData>;
  /** Resolvers for the playback loop's "wait for chunk i" awaits. */
  chunkWaiters: Map<number, () => void>;
  /** True once the sequential playback loop has been spawned. */
  playing: boolean;
  /** Aborts the playback loop on a fresh turn / pre-empt. */
  abort: AbortController | null;
  /** Trips when no chunks have arrived in time — falls back to whole-text typewriter. */
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

function makePendingReply(): PendingReply {
  return {
    fullText: null,
    totalChunks: null,
    chunks: new Map(),
    chunkWaiters: new Map(),
    playing: false,
    abort: null,
    fallbackTimer: null,
  };
}

let pendingReply: PendingReply = makePendingReply();

/**
 * If translation lands but no chunk arrives within this window, the
 * chunked path has effectively died — give up and typewriter the
 * full ZH text so the operator still reads the reply. Generous on
 * purpose: a long reply with all chunks running in parallel still
 * caps near the longest single-chunk synthesis, ~10 s in observed
 * traces.
 */
const NO_CHUNK_FALLBACK_MS = 30000;

function resetPendingReply(): void {
  if (pendingReply.fallbackTimer !== null) {
    clearTimeout(pendingReply.fallbackTimer);
  }
  pendingReply.abort?.abort();
  // Resolve any in-flight waiter so the playback loop's await unblocks
  // and exits via its abort check.
  for (const resolve of pendingReply.chunkWaiters.values()) resolve();
  pendingReply = makePendingReply();
}

/**
 * `ChatReplyCaption` — main shipped the full ZH translation. Drives
 * the segment-0 "starting to speak" preview while audio chunks are
 * still synthesizing. Once chunks start arriving the preview is
 * cancelled by the playback loop and per-chunk audio takes over.
 */
function playReplyCaption(payload: ReplyCaptionPayload): void {
  clearStreamEndSafetyNet();
  const text = payload.text.trim();
  if (!text) return;
  pendingReply.fullText = text;
  clearAmbientHideTimer();
  showPill(captionEl);

  // If chunks haven't started arriving yet, type out segment 0 as a
  // preview. Idempotent if `playReplyCaption` somehow re-fires.
  if (!pendingReply.playing && pendingReply.chunks.size === 0) {
    void captionController.previewFirstSegment(text);
    if (pendingReply.fallbackTimer === null) {
      pendingReply.fallbackTimer = setTimeout(() => {
        pendingReply.fallbackTimer = null;
        if (pendingReply.playing) return;
        if (!pendingReply.fullText) return;
        // No chunks ever arrived — main's chunked path is dead. Roll
        // the whole translation forward at the calm reply pace so the
        // operator still gets to read it.
        pendingReply.playing = true;
        const abort = new AbortController();
        pendingReply.abort = abort;
        void captionController
          .typewriteSegments(pendingReply.fullText)
          .then(() => {
            if (activeUtterance === null) scheduleAmbientHide();
          });
      }, NO_CHUNK_FALLBACK_MS);
    }
  }
}

/**
 * `ChatReplyChunk` — main shipped one audio chunk in the chunked-TTS
 * pipeline. Buffer it by index; if this is the first chunk to land,
 * spawn the sequential playback loop (which will await out-of-order
 * chunks via `chunkWaiters`).
 */
function playReplyChunk(payload: ReplyChunkPayload): void {
  clearStreamEndSafetyNet();
  pendingReply.totalChunks = payload.totalChunks;
  pendingReply.chunks.set(payload.chunkIndex, {
    zhText: payload.zhText,
    audioUrl: payload.audioUrl,
    audioDurationMs: payload.audioDurationMs,
  });

  // Wake the loop if it was waiting on this specific index.
  const waiter = pendingReply.chunkWaiters.get(payload.chunkIndex);
  if (waiter) {
    pendingReply.chunkWaiters.delete(payload.chunkIndex);
    waiter();
  }

  if (pendingReply.playing) return;
  pendingReply.playing = true;
  if (pendingReply.fallbackTimer !== null) {
    clearTimeout(pendingReply.fallbackTimer);
    pendingReply.fallbackTimer = null;
  }

  const abort = new AbortController();
  pendingReply.abort = abort;
  showPill(captionEl);
  void playChunksSequentially(abort.signal);
}

async function playChunksSequentially(abort: AbortSignal): Promise<void> {
  // Tear down any preview / streaming / typewriter state so the
  // chunk audio takes over the bar cleanly.
  captionController.cancelReplyPlayback();
  captionController.cancelTypewriter();

  for (let i = 0; ; i += 1) {
    if (abort.aborted) return;
    if (
      pendingReply.totalChunks !== null &&
      i >= pendingReply.totalChunks
    ) {
      break;
    }

    let chunk = pendingReply.chunks.get(i);
    if (!chunk) {
      // Chunk i hasn't arrived yet — wait for `playReplyChunk` to
      // wake us. `resetPendingReply` resolves all pending waiters on
      // a fresh turn, and the abort check below catches that path.
      await new Promise<void>((resolve) => {
        pendingReply.chunkWaiters.set(i, resolve);
        const onAbort = (): void => {
          pendingReply.chunkWaiters.delete(i);
          resolve();
        };
        if (abort.aborted) {
          onAbort();
          return;
        }
        abort.addEventListener('abort', onAbort, { once: true });
      });
      if (abort.aborted) return;
      chunk = pendingReply.chunks.get(i);
      if (!chunk) return;
    }

    if (chunk.audioUrl === null) {
      // TTS failed for THIS chunk only — typewriter the chunk's text
      // at the calm pace, then continue with the next chunk's audio.
      await captionController.typewriteSegments(chunk.zhText);
      if (abort.aborted) return;
      continue;
    }

    try {
      const audio = new Audio(chunk.audioUrl);
      activeUtterance = audio;
      const playbackPromise = captionController.playWithAudio({
        fullText: chunk.zhText,
        audio,
        // Crossfade between chunks: fade out the previous chunk's
        // tail (or the preview) before revealing this chunk's
        // segment 0 from audio.currentTime=0.
        clearBeforeAudio: true,
        // Fallback duration from main's WAV-header read. Keeps the
        // karaoke pass alive on chunks where Chromium would otherwise
        // sit on `audio.duration = Infinity` until `durationchange`
        // lands mid-playback.
        knownDurationSec:
          chunk.audioDurationMs !== undefined
            ? chunk.audioDurationMs / 1000
            : undefined,
      });
      void audio.play().catch((err) => {
        console.warn('[chat] chunk audio play() rejected', err);
        captionController.cancelAudioMode();
      });
      await playbackPromise;
      if (activeUtterance === audio) activeUtterance = null;
      if (abort.aborted) return;
    } catch (err) {
      console.warn('[chat] chunk audio setup failed', err);
      // Audio element couldn't even instantiate — degrade to typing
      // this chunk so the caption progression still moves forward.
      await captionController.typewriteSegments(chunk.zhText);
      if (abort.aborted) return;
    }
  }

  if (!abort.aborted) scheduleAmbientHide();
}

window.chatApi.onReplyCaption(playReplyCaption);
window.chatApi.onReplyChunk(playReplyChunk);

// ---------- Critical agent-loop alert ----------
//
// Main fires this when the autonomous cycle stops on a cap or pauses
// after consecutive errors. We reuse the existing caption pill — no new
// UI surface — and tint the text red via the `.alert` class so a dead
// loop can't fail silently during a long soak. Any in-flight reply
// state is torn down first so a late chunk can't repaint over it.
function showAgentWarning(message: string): void {
  clearStreamEndSafetyNet();
  stopActiveUtterance();
  resetPendingReply();
  clearAmbientHideTimer();
  showPill(captionEl);
  captionTextEl.classList.add('alert');
  void captionController.typewriteText(message).then(() => {
    scheduleAmbientHide();
  });
}

window.chatApi.onShowWarning(showAgentWarning);

// ---------- Tool-activity indicator ----------
//
// During a tool-using turn, main pushes a short 繁中 progress label
// ("搜尋網路中…") for each tool round. The caption bar is otherwise just
// a blinking cursor in this phase, so we show the label dim in place.
// `text: null` clears it; the final-reply path then takes the bar over.
function showToolActivity(payload: ChatToolActivityPayload): void {
  if (!streaming) return;
  if (payload.text) {
    clearAmbientHideTimer();
    showPill(captionEl);
    captionTextEl.classList.add('tool-activity');
    captionTextEl.textContent = payload.text;
  } else if (captionTextEl.classList.contains('tool-activity')) {
    captionTextEl.classList.remove('tool-activity');
    captionTextEl.textContent = '';
  }
}

window.chatApi.onToolActivity(showToolActivity);

window.chatApi.onStreamEvent((event: ChatStreamEvent) => {
  switch (event.type) {
    case 'start':
      streaming = true;
      startCaption();
      break;
    case 'text':
      // Intentionally a no-op. The streamed Japanese is no longer
      // surfaced in the caption — the operator reads 繁中 only,
      // typewritered from the post-reply translation via
      // `ChatReplyCaption`. Main keeps emitting `text` deltas so
      // future debug overlays or transcripts can still tap into the
      // raw stream, but the pill stays in "thinking" state until the
      // translation lands.
      break;
    case 'error':
      // Errors get their own caption — type them in place of whatever
      // the post-reply path would have shown.
      void captionController.typewriteText(`[error] ${event.message}`).then(() => {
        scheduleAmbientHide();
      });
      streaming = false;
      clearStreamEndSafetyNet();
      break;
    case 'end':
      finishStreamingPhase();
      streaming = false;
      if (event.stopReason === 'no_api_key') void refreshApiKeyStatus();
      break;
  }
});

// Ctrl+Enter — main fires this on every hotkey press, regardless of
// whether the chat window already has OS focus. Toggles the input pill:
// first press summons it, second press dismisses it. The caption pill
// keeps its own lifecycle (driven by stream events / ambient fade) so the
// hotkey only ever moves the typing bar in and out.
window.chatApi.onToggleInput(() => {
  void refreshApiKeyStatus();
  const isComposerVisible =
    !composerEl.hidden && !composerEl.classList.contains('fading-out');
  if (isComposerVisible) {
    hideInput();
    window.chatApi.dismiss();
  } else {
    clearAmbientHideTimer();
    showInput();
  }
});

inputEl.addEventListener('keydown', (e) => {
  // Any keystroke (Enter, Esc, or a regular character) counts as active
  // engagement — cancel any pending ambient fade so the surface doesn't
  // disappear while the user is composing a follow-up message.
  clearAmbientHideTimer();

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void handleSend();
  } else if (e.key === 'Escape') {
    hideInput();
    // Drop focus back to the avatar so the chat surface returns to its
    // ambient (caption-only) state and the next Ctrl+Enter is a clean
    // re-summon rather than a no-op on an already-focused window.
    window.chatApi.dismiss();
  }
});

// Paste-to-attach: Ctrl+V over the input pill with an image on the
// clipboard (e.g. fresh from PrintScreen → Snipping Tool) attaches it
// to the next send. Manually-pasted images are persisted in chat
// history (unlike the auto-screenshot that the main process attaches
// transiently on every turn). We pick the FIRST image item — multi-
// image clipboards are rare and a single chip slot keeps the UI tidy.
inputEl.addEventListener('paste', (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== 'file') continue;
    if (!SUPPORTED_PASTE_TYPES.has(item.type)) continue;
    const file = item.getAsFile();
    if (!file) continue;
    event.preventDefault();
    void ingestPastedImage(file);
    return;
  }
});

async function ingestPastedImage(file: File): Promise<void> {
  try {
    const buf = await file.arrayBuffer();
    const base64 = bufferToBase64(buf);
    const mediaType = file.type as AttachedImage['mediaType'];
    setAttachment({ mediaType, data: base64 }, file);
  } catch (err) {
    console.error('[chat] failed to ingest pasted image', err);
  }
}

function bufferToBase64(buffer: ArrayBuffer): string {
  // btoa cannot handle the raw byte view — convert through a binary
  // string in 32 KB chunks so we don't blow the call stack on a 5 MB
  // screenshot via `String.fromCharCode(...new Uint8Array(buffer))`.
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

attachmentRemoveBtn.addEventListener('click', () => {
  clearAttachment();
  inputEl.focus();
});

openSettingsBtn.addEventListener('click', () => {
  window.chatApi.openSettings();
});

// Intentionally no `blur` auto-fade. With the Ctrl+Enter toggle the
// input pill's visibility is entirely user-controlled (Ctrl+Enter to
// dismiss, Esc to dismiss, or the ambient-fade timer once the reply has
// been on-screen long enough). Auto-fading on focus loss would yank the
// typing bar away the moment the user clicked any other window to,
// e.g., copy a snippet of code into the chat.

// ---------- Click-through management ----------
//
// The chat window starts click-through (see windows.ts) so the
// transparent gaps around the pills never block the desktop
// underneath. We flip it to "capturing" only while the cursor is over
// a visible pill (caption / composer / warning / attachment).
let chatMouseIgnored = true; // matches the window's initial state

function applyChatMouseIgnore(interactive: boolean): void {
  const wantIgnore = !interactive;
  if (wantIgnore === chatMouseIgnored) return;
  chatMouseIgnored = wantIgnore;
  window.chatApi.setMouseIgnore(wantIgnore);
}

window.addEventListener('mousemove', (e: MouseEvent) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  applyChatMouseIgnore(!!(el && el.closest('.pill')));
});

// When the cursor leaves the window entirely, revert to click-through
// so a stale "capturing" state can't linger after the pointer exits.
document.documentElement.addEventListener('mouseleave', () => {
  applyChatMouseIgnore(false);
});

async function boot(): Promise<void> {
  resetCaption();
  clearAttachment();
  await refreshApiKeyStatus();
  // Composer stays hidden on first paint — the user reveals it with
  // Ctrl+Enter. This keeps the desktop quiet by default.
}

void boot();
