import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadGeminiKey } from './geminiKey';
import { getHost } from './host';

// Phase 6.5 — embeddings bridge for semantic recall.

export const EMBED_MODEL = 'gemini-embedding-001';
export const EMBED_DIM = 768;
const TASK_TYPE = 'SEMANTIC_SIMILARITY';
const CACHE_DIR_NAME = 'embed-cache';
const MAX_EMBED_INPUT_CHARS = 6000;

function embedCacheDir(): string {
  const dir = path.join(getHost().paths.userData, CACHE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKey(text: string): string {
  return createHash('sha256')
    .update(`${EMBED_MODEL}\n${EMBED_DIM}\n${TASK_TYPE}\n${text}`)
    .digest('hex')
    .slice(0, 24);
}

function cacheFilePath(text: string): string {
  return path.join(embedCacheDir(), `emb-${cacheKey(text)}.bin`);
}

function readCached(text: string): Float32Array | null {
  const file = cacheFilePath(text);
  if (!fs.existsSync(file)) return null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.byteLength !== EMBED_DIM * 4) return null;
    return bufferToFloat32(buf);
  } catch {
    return null;
  }
}

function writeCached(text: string, vec: Float32Array): void {
  try {
    fs.writeFileSync(cacheFilePath(text), float32ToBuffer(vec), {
      mode: 0o600,
    });
  } catch (err) {
    console.warn('[geminiEmbed] failed to write cache', err);
  }
}

/** Pack a Float32Array into a Buffer (4 bytes per dim, host byte order). */
export function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Read a Buffer as a Float32Array. Caller is responsible for length checks. */
export function bufferToFloat32(buf: Buffer): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / 4,
  );
}

/** L2-normalize in place. No-op for zero vectors (returns as-is). */
function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) {
    sum += vec[i]! * vec[i]!;
  }
  if (sum <= 0) return vec;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] = vec[i]! / norm;
  }
  return vec;
}

interface EmbedContentResponse {
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
}

async function postEmbedContent(
  apiKey: string,
  text: string,
): Promise<Float32Array> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const body = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
    taskType: TASK_TYPE,
    outputDimensionality: EMBED_DIM,
  };

  const res = await getHost().net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Gemini embed HTTP ${res.status}: ${errText.slice(0, 400)}`,
    );
  }

  const json = (await res.json()) as EmbedContentResponse;
  if (json.error?.message) {
    throw new Error(`Gemini embed: ${json.error.message}`);
  }

  const values =
    json.embedding?.values ??
    (json.embeddings && json.embeddings[0]?.values) ??
    null;
  if (!values || values.length === 0) {
    throw new Error('Gemini embed returned empty vector.');
  }
  if (values.length !== EMBED_DIM) {
    console.warn(
      `[geminiEmbed] returned dim=${values.length}, expected ${EMBED_DIM} — coercing`,
    );
  }
  const out = new Float32Array(EMBED_DIM);
  const copyN = Math.min(values.length, EMBED_DIM);
  for (let i = 0; i < copyN; i += 1) out[i] = values[i]!;
  return l2Normalize(out);
}

/**
 * Embed `text` via Gemini and return a unit-length Float32Array of
 * length `EMBED_DIM`. Returns null on any failure — missing key, empty
 * input, network blip, malformed response — so the caller can degrade
 * to "no semantic recall on this turn" without crashing the chat path.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const sourceForCache =
    trimmed.length > MAX_EMBED_INPUT_CHARS
      ? trimmed.slice(0, MAX_EMBED_INPUT_CHARS)
      : trimmed;

  const cached = readCached(sourceForCache);
  if (cached !== null) return cached;

  const apiKey = loadGeminiKey();
  if (!apiKey) {
    console.warn(
      '[geminiEmbed] no Gemini API key configured — skipping embedding',
    );
    return null;
  }

  const startedAt = Date.now();
  try {
    const vec = await postEmbedContent(apiKey, sourceForCache);
    console.log(
      `[geminiEmbed] embedded ${sourceForCache.length} chars in ${Date.now() - startedAt}ms (dim=${EMBED_DIM})`,
    );
    writeCached(sourceForCache, vec);
    return vec;
  } catch (err) {
    console.error('[geminiEmbed] embed failed', err);
    return null;
  }
}
