import fs from 'node:fs';
import path from 'node:path';

import type { ApiKeyStatus } from '@shared/protocol';

import { getHost } from './host';

// We persist the Anthropic API key as an encrypted blob in userData
// using the OS keychain via the HostAdapter's SecretStorage (DPAPI on
// Windows). No plaintext on disk.

const KEY_FILE_NAME = 'anthropic-api-key.enc';
const ENV_OVERRIDE = 'ANTHROPIC_API_KEY';

function keyFilePath(): string {
  return path.join(getHost().paths.userData, KEY_FILE_NAME);
}

export function getApiKeyStatus(): ApiKeyStatus {
  const encryptionAvailable = getHost().secrets.isAvailable();
  const hasEnv = !!process.env[ENV_OVERRIDE];
  const hasFile = fs.existsSync(keyFilePath());
  return {
    hasKey: hasEnv || hasFile,
    encryptionAvailable,
  };
}

export function loadApiKey(): string | null {
  const envKey = process.env[ENV_OVERRIDE];
  if (envKey && envKey.trim().length > 0) return envKey.trim();

  const file = keyFilePath();
  if (!fs.existsSync(file)) return null;
  const secrets = getHost().secrets;
  if (!secrets.isAvailable()) {
    console.warn(
      '[apiKey] safeStorage unavailable; cannot decrypt stored key. Set ANTHROPIC_API_KEY env var.',
    );
    return null;
  }
  try {
    const buf = fs.readFileSync(file);
    return secrets.decrypt(buf);
  } catch (err) {
    console.error('[apiKey] failed to decrypt stored key', err);
    return null;
  }
}

export function saveApiKey(key: string): { ok: boolean; error?: string } {
  const trimmed = key.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Key is empty.' };
  const secrets = getHost().secrets;
  if (!secrets.isAvailable()) {
    return {
      ok: false,
      error:
        'OS encryption unavailable. Set ANTHROPIC_API_KEY environment variable instead.',
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

export function clearApiKey(): void {
  const file = keyFilePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
