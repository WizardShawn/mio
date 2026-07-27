import fs from 'node:fs';
import path from 'node:path';

import type { ApiKeyStatus } from '@shared/protocol';

import { getHost } from './host';

// Mirror of `apiKey.ts` for the Google AI Studio / Gemini API key.

const KEY_FILE_NAME = 'gemini-api-key.enc';
const ENV_OVERRIDES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function keyFilePath(): string {
  return path.join(getHost().paths.userData, KEY_FILE_NAME);
}

function readEnv(): string | null {
  for (const name of ENV_OVERRIDES) {
    const v = process.env[name];
    if (v && v.trim().length > 0) return v.trim();
  }
  return null;
}

export function getGeminiKeyStatus(): ApiKeyStatus {
  const encryptionAvailable = getHost().secrets.isAvailable();
  const hasEnv = !!readEnv();
  const hasFile = fs.existsSync(keyFilePath());
  return {
    hasKey: hasEnv || hasFile,
    encryptionAvailable,
  };
}

export function loadGeminiKey(): string | null {
  const env = readEnv();
  if (env) return env;

  const file = keyFilePath();
  if (!fs.existsSync(file)) return null;
  const secrets = getHost().secrets;
  if (!secrets.isAvailable()) {
    console.warn(
      '[geminiKey] safeStorage unavailable; cannot decrypt stored key. Set GEMINI_API_KEY env var.',
    );
    return null;
  }
  try {
    const buf = fs.readFileSync(file);
    return secrets.decrypt(buf);
  } catch (err) {
    console.error('[geminiKey] failed to decrypt stored key', err);
    return null;
  }
}

export function saveGeminiKey(key: string): { ok: boolean; error?: string } {
  const trimmed = key.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Key is empty.' };
  const secrets = getHost().secrets;
  if (!secrets.isAvailable()) {
    return {
      ok: false,
      error:
        'OS encryption unavailable. Set GEMINI_API_KEY environment variable instead.',
    };
  }
  try {
    const buf = secrets.encrypt(trimmed);
    fs.writeFileSync(keyFilePath(), buf, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function clearGeminiKey(): void {
  const file = keyFilePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
