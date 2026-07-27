import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadGeminiKey } from './geminiKey';
import { getHost } from './host';

// JA → 台灣繁體 translation bridge for the chat caption.

const MODEL = 'gemini-3.1-flash-lite';
const PROMPT_VERSION = 'v1';
const CACHE_DIR_NAME = 'translate-cache';

const MAX_TRANSLATE_INPUT_CHARS = 8000;

function ttsTranslateCacheDir(): string {
  const dir = path.join(getHost().paths.userData, CACHE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKey(text: string): string {
  return createHash('sha256')
    .update(`${MODEL}\n${PROMPT_VERSION}\n${text}`)
    .digest('hex')
    .slice(0, 24);
}

function cacheFilePath(text: string): string {
  return path.join(ttsTranslateCacheDir(), `tr-${cacheKey(text)}.txt`);
}

function readCached(text: string): string | null {
  const file = cacheFilePath(text);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeCached(text: string, translation: string): void {
  try {
    fs.writeFileSync(cacheFilePath(text), translation, { mode: 0o600 });
  } catch (err) {
    console.warn('[geminiTranslate] failed to write cache', err);
  }
}

function buildPrompt(ja: string): string {
  return [
    'Translate the following Japanese into natural 台灣繁體中文 the way a',
    'Taiwanese friend would phrase it. Preserve tone, particles like ね/よ',
    'at the end of clauses when they feel natural in Chinese, and keep',
    'code blocks, file paths, URLs, and identifiers in their original',
    'form. Output ONLY the translation — no quotes, no labels, no',
    'preamble, no explanation.',
    '',
    '<source>',
    ja,
    '</source>',
  ].join('\n');
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
}

async function postGenerateContent(
  apiKey: string,
  ja: string,
): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(ja) }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'text/plain',
    },
  };

  const res = await getHost().net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Gemini translate HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }

  const json = (await res.json()) as GenerateContentResponse;
  if (json.error?.message) {
    throw new Error(`Gemini translate: ${json.error.message}`);
  }

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const joined = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!joined) throw new Error('Gemini translate returned empty text.');
  return joined;
}

/**
 * Translate `ja` into 台灣繁體中文. Returns null on any failure
 * (missing key, network, malformed response) so callers can degrade
 * gracefully — the caption pipeline falls back to showing the source
 * Japanese in that case.
 */
export async function translateJaToZhHant(ja: string): Promise<string | null> {
  const trimmed = ja.trim();
  if (!trimmed) return null;
  const sourceForCache =
    trimmed.length > MAX_TRANSLATE_INPUT_CHARS
      ? trimmed.slice(0, MAX_TRANSLATE_INPUT_CHARS)
      : trimmed;

  const cached = readCached(sourceForCache);
  if (cached !== null) return cached;

  const apiKey = loadGeminiKey();
  if (!apiKey) {
    console.warn(
      '[geminiTranslate] no Gemini API key configured — skipping translation',
    );
    return null;
  }

  const startedAt = Date.now();
  try {
    console.log(
      `[geminiTranslate] translating (${sourceForCache.length} chars, model=${MODEL})`,
    );
    const translation = await postGenerateContent(apiKey, sourceForCache);
    console.log(
      `[geminiTranslate] translated in ${Date.now() - startedAt}ms (${translation.length} chars)`,
    );
    writeCached(sourceForCache, translation);
    return translation;
  } catch (err) {
    console.error('[geminiTranslate] translation failed', err);
    return null;
  }
}
