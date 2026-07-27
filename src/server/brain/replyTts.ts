import fs from 'node:fs';

import type {
  ChatOrigin,
  ReplyCaptionPayload,
  ReplyChunkPayload,
} from '@shared/protocol';

import { eventBus, type EventMeta } from '../eventBus';
import { synthesizeSpeech } from './geminiTts';
import { translateJaToZhHant } from './geminiTranslate';
import type { SlotHandle } from './replyCoordinator';

const PROTOCOL = 'cortana-asset';
const PROTOCOL_HOST_AUDIO = 'audio';

/** Gemini payload size guard — keeps one request bounded. */
const MAX_REPLY_TTS_CHARS = 6000;

// Gemini-TTS returns 24 kHz mono 16-bit PCM, then we wrap it in a 44-byte WAV header.
const TTS_SAMPLE_RATE_HZ = 24000;
const TTS_CHANNELS = 1;
const TTS_SAMPLE_WIDTH_BYTES = 2;
const TTS_WAV_HEADER_BYTES = 44;

const RENDERER_CAPTION_CHARS_PER_SEC = 18;
const SLOT_HOLD_GRACE_MS = 600;

// ---------- JA chunking ----------

const SENTENCE_END_CHARS = new Set([
  '。', '！', '？', '．', '!', '?', '\n',
]);
const CLAUSE_BREAK_CHARS = new Set(['、', '，', '；', '：', ',', ';']);
const CHUNK_SOFT_MIN_CHARS = 60;
const CHUNK_HARD_MAX_CHARS = 140;

function splitJaIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let buf = '';
  const flush = (): void => {
    const trimmed = buf.trim();
    if (trimmed) chunks.push(trimmed);
    buf = '';
  };
  for (const ch of text) {
    buf += ch;
    if (SENTENCE_END_CHARS.has(ch)) {
      flush();
      continue;
    }
    if (CLAUSE_BREAK_CHARS.has(ch) && buf.length >= CHUNK_SOFT_MIN_CHARS) {
      flush();
      continue;
    }
    if (buf.length >= CHUNK_HARD_MAX_CHARS) {
      flush();
    }
  }
  flush();
  return chunks;
}

function alignZhToChunks(jaChunks: string[], fullZh: string): string[] {
  if (jaChunks.length === 0) return [];
  if (jaChunks.length === 1) return [fullZh.trim()];

  const zhSegs = splitZhIntoSegments(fullZh);
  if (zhSegs.length === jaChunks.length) {
    return zhSegs.map((s) => s.trim());
  }

  const totalJa = jaChunks.reduce((s, c) => s + c.length, 0) || 1;
  const out: string[] = [];
  let cursor = 0;
  let cumPct = 0;
  for (let i = 0; i < jaChunks.length; i += 1) {
    cumPct += jaChunks[i]!.length / totalJa;
    const end =
      i === jaChunks.length - 1
        ? fullZh.length
        : Math.min(fullZh.length, Math.round(cumPct * fullZh.length));
    out.push(fullZh.slice(cursor, end).trim());
    cursor = end;
  }
  return out;
}

function splitZhIntoSegments(text: string): string[] {
  const segs: string[] = [];
  let buf = '';
  const flush = (): void => {
    const trimmed = buf.trim();
    if (trimmed) segs.push(trimmed);
    buf = '';
  };
  for (const ch of text) {
    buf += ch;
    if (SENTENCE_END_CHARS.has(ch)) flush();
  }
  flush();
  return segs;
}

function audioUrlFor(fileName: string): string {
  return `${PROTOCOL}://${PROTOCOL_HOST_AUDIO}/${encodeURIComponent(fileName)}`;
}

function wavDurationMs(filePath: string): number {
  try {
    const size = fs.statSync(filePath).size;
    if (!Number.isFinite(size) || size <= TTS_WAV_HEADER_BYTES) return 0;
    const pcmBytes = size - TTS_WAV_HEADER_BYTES;
    const bytesPerSec = TTS_SAMPLE_RATE_HZ * TTS_CHANNELS * TTS_SAMPLE_WIDTH_BYTES;
    return Math.ceil((pcmBytes / bytesPerSec) * 1000);
  } catch (err) {
    console.warn('[reply-tts] failed to stat WAV for duration', err);
    return 0;
  }
}

function typewriterDurationMs(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / RENDERER_CAPTION_CHARS_PER_SEC) * 1000);
}

/**
 * Post-reply orchestration (chunked-TTS pipeline). Emits caption +
 * per-chunk events through the event bus; every transport that is
 * subscribed forwards them to its connected client(s). The promise
 * resolves only after the longer of (sum of all chunk audio durations,
 * full caption typewriter estimate) plus a small grace, so the
 * coordinator slot is held long enough for actual playback.
 */
export async function dispatchAssistantReply(
  jaText: string,
  slot: SlotHandle,
  origin?: ChatOrigin,
): Promise<void> {
  let ja = jaText.trim();
  if (!ja) return;
  if (ja.length > MAX_REPLY_TTS_CHARS) {
    ja = ja.slice(0, MAX_REPLY_TTS_CHARS);
  }

  const jaChunks = splitJaIntoChunks(ja);
  if (jaChunks.length === 0) return;

  const meta: EventMeta = origin ? { origin } : {};

  const translationPromise = (async () => {
    const zh = await translateJaToZhHant(ja);
    const usingZh = !!zh && zh.trim().length > 0;
    const fullText = usingZh ? zh!.trim() : ja;
    return {
      fullText,
      language: usingZh ? ('zh-Hant' as const) : ('ja' as const),
    };
  })();

  const captionTask = (async () => {
    const trans = await translationPromise;
    if (slot.aborted) return;
    const payload: ReplyCaptionPayload = {
      text: trans.fullText,
      language: trans.language,
    };
    eventBus.emit('chat.replyCaption', payload, meta);
  })();

  const chunkTasks = jaChunks.map((chunk, i) =>
    (async (): Promise<number> => {
      const audioPromise = synthesizeSpeech(chunk);
      const [audio, trans] = await Promise.all([
        audioPromise,
        translationPromise,
      ]);
      if (slot.aborted) return 0;

      const zhChunks = alignZhToChunks(jaChunks, trans.fullText);
      const zhText = (zhChunks[i] ?? '').length > 0 ? zhChunks[i]! : chunk;

      let audioUrl: string | null = null;
      let chunkAudioMs = 0;
      if (audio) {
        audioUrl = audioUrlFor(audio.fileName);
        chunkAudioMs = wavDurationMs(audio.filePath);
      }

      const payload: ReplyChunkPayload = {
        chunkIndex: i,
        totalChunks: jaChunks.length,
        zhText,
        audioUrl,
        audioDurationMs: audioUrl && chunkAudioMs > 0 ? chunkAudioMs : undefined,
      };
      eventBus.emit('chat.replyChunk', payload, meta);
      return chunkAudioMs;
    })(),
  );

  const settled = await Promise.allSettled([captionTask, ...chunkTasks]);
  if (slot.aborted) return;

  let totalAudioMs = 0;
  for (let i = 1; i < settled.length; i += 1) {
    const r = settled[i]!;
    if (r.status === 'fulfilled' && typeof r.value === 'number') {
      totalAudioMs += r.value;
    }
  }
  const trans = await translationPromise.catch(() => null);
  const captionMs = typewriterDurationMs(trans?.fullText ?? '');
  const holdMs = Math.max(totalAudioMs, captionMs) + SLOT_HOLD_GRACE_MS;
  if (holdMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      slot.signal.removeEventListener('abort', onAbort);
      resolve();
    }, holdMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    slot.signal.addEventListener('abort', onAbort, { once: true });
  });
}
