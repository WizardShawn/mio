import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadGeminiKey } from './geminiKey';
import { getHost } from './host';

// Gemini-TTS bridge. Synthesis is cached to PCM-as-WAV under userData;
// cache hits avoid the network entirely.

const MODEL = 'gemini-3.1-flash-tts-preview';
const VOICE = 'Leda';
const LANGUAGE_CODE = 'ja-JP';
const CACHE_DIR_NAME = 'tts-cache';

const SAMPLE_RATE_HZ = 24000;
const CHANNELS = 1;
const SAMPLE_WIDTH_BYTES = 2;

interface CachedAudio {
  filePath: string;
  fileName: string;
}

export function ttsCacheDir(): string {
  const dir = path.join(getHost().paths.userData, CACHE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKey(text: string): string {
  return createHash('sha256')
    .update(`${MODEL}\n${VOICE}\n${LANGUAGE_CODE}\n${text}`)
    .digest('hex')
    .slice(0, 24);
}

function cacheFilePath(text: string): { filePath: string; fileName: string } {
  const dir = ttsCacheDir();
  const fileName = `tts-${cacheKey(text)}.wav`;
  return { filePath: path.join(dir, fileName), fileName };
}

function findCached(text: string): CachedAudio | null {
  const { filePath, fileName } = cacheFilePath(text);
  if (fs.existsSync(filePath)) return { filePath, fileName };
  return null;
}

function wavHeader(pcmByteLength: number): Buffer {
  const byteRate = SAMPLE_RATE_HZ * CHANNELS * SAMPLE_WIDTH_BYTES;
  const blockAlign = CHANNELS * SAMPLE_WIDTH_BYTES;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmByteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(SAMPLE_WIDTH_BYTES * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmByteLength, 40);
  return header;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

async function postGenerateContent(
  apiKey: string,
  text: string,
): Promise<Buffer> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        languageCode: LANGUAGE_CODE,
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: VOICE },
        },
      },
    },
  };

  // Use the HostAdapter's net (Electron `net.fetch` on desktop) so DNS,
  // proxies, and certificate roots match the rest of the app — node's
  // `fetch` would ignore the user's system proxy on Windows.
  const res = await getHost().net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini TTS HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as GenerateContentResponse;
  if (json.error?.message) throw new Error(`Gemini TTS: ${json.error.message}`);

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data) return Buffer.from(inline.data, 'base64');
  }
  throw new Error('Gemini TTS returned no audio data.');
}

/**
 * Returns the on-disk path of a WAV file containing the spoken `text`.
 * Cache hit: zero network. Cache miss: one POST to Gemini, then write.
 * Returns null on any failure (missing API key, network down, malformed
 * response) so callers can degrade gracefully.
 */
export async function synthesizeSpeech(text: string): Promise<CachedAudio | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const cached = findCached(trimmed);
  if (cached) return cached;

  const apiKey = loadGeminiKey();
  if (!apiKey) {
    console.warn('[geminiTts] no Gemini API key configured — skipping speech synthesis');
    return null;
  }

  const startedAt = Date.now();
  try {
    console.log(
      `[geminiTts] synthesizing (${trimmed.length} chars, ${LANGUAGE_CODE}, voice=${VOICE})`,
    );
    const pcm = await postGenerateContent(apiKey, trimmed);
    const header = wavHeader(pcm.byteLength);
    const wav = Buffer.concat([header, pcm]);
    const { filePath, fileName } = cacheFilePath(trimmed);
    fs.writeFileSync(filePath, wav, { mode: 0o600 });
    console.log(
      `[geminiTts] synthesized ${pcm.byteLength} PCM bytes in ${Date.now() - startedAt}ms`,
    );
    return { filePath, fileName };
  } catch (err) {
    console.error('[geminiTts] synthesis failed', err);
    return null;
  }
}

/** @deprecated Use {@link synthesizeSpeech}. */
export const synthesizeGreeting = synthesizeSpeech;
