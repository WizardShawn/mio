import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getHost } from '../brain/host';

// Bearer-token store for off-process clients. One 32-byte token per
// device id; tokens are stored encrypted at rest using the host's
// SecretStorage (DPAPI on Windows). The plaintext token is only
// returned at pair time — repeat reads return the same encrypted
// blob's plaintext via `verifyToken`.

const FILE_NAME = 'server-tokens.json';
const TOKEN_BYTES = 32;

interface StoredTokenEntry {
  /** Device id chosen by the client at first pair. */
  deviceId: string;
  /** Base64 of `safeStorage.encryptString(token)`. */
  encrypted: string;
  /** Wall-clock issued-at. */
  issuedAt: number;
}

interface StoredTokenFile {
  entries: StoredTokenEntry[];
}

function tokensFilePath(): string {
  return path.join(getHost().paths.userData, FILE_NAME);
}

function loadStore(): StoredTokenFile {
  try {
    const file = tokensFilePath();
    if (!fs.existsSync(file)) return { entries: [] };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as StoredTokenFile;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
  } catch (err) {
    console.warn('[auth] failed to load token store; starting empty', err);
    return { entries: [] };
  }
}

function saveStore(store: StoredTokenFile): void {
  try {
    fs.writeFileSync(tokensFilePath(), JSON.stringify(store, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err) {
    console.warn('[auth] failed to persist token store', err);
  }
}

function decryptEntry(entry: StoredTokenEntry): string | null {
  try {
    if (!getHost().secrets.isAvailable()) return null;
    const blob = Buffer.from(entry.encrypted, 'base64');
    return getHost().secrets.decrypt(blob);
  } catch (err) {
    console.warn('[auth] decrypt failed for device', entry.deviceId, err);
    return null;
  }
}

/**
 * Issue a fresh token for `deviceId`. Replaces any previous token for
 * the same device — re-pairing a phone with the same id rotates the
 * secret. Returns the plaintext token; the caller transmits it once
 * to the client and never sees it again.
 */
export function issueToken(deviceId: string): string {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  const store = loadStore();
  const filtered = store.entries.filter((e) => e.deviceId !== deviceId);
  let encrypted: string;
  try {
    if (!getHost().secrets.isAvailable()) {
      // Fall back to a dev-mode plaintext store so headless test
      // setups without DPAPI still work. Never reached on Windows.
      encrypted = Buffer.from(`PLAIN:${plaintext}`, 'utf8').toString('base64');
    } else {
      encrypted = getHost().secrets.encrypt(plaintext).toString('base64');
    }
  } catch (err) {
    console.error('[auth] failed to encrypt token', err);
    throw new Error('Failed to issue token: secret encryption unavailable.');
  }
  filtered.push({ deviceId, encrypted, issuedAt: Date.now() });
  saveStore({ entries: filtered });
  return plaintext;
}

/**
 * Verify a presented token against the encrypted store. Returns the
 * matched device id (used for logging / per-client subscriptions) on
 * success, or null on miss / decrypt error.
 */
export function verifyToken(presented: string): string | null {
  if (!presented) return null;
  const store = loadStore();
  for (const entry of store.entries) {
    const plain = decryptEntry(entry);
    if (!plain) continue;
    // Dev fallback shape from `issueToken` when DPAPI was unavailable.
    const actual = plain.startsWith('PLAIN:') ? plain.slice('PLAIN:'.length) : plain;
    if (actual === presented) return entry.deviceId;
  }
  return null;
}

/** Diagnostic helper — list registered device ids without leaking tokens. */
export function listPairedDeviceIds(): string[] {
  return loadStore().entries.map((e) => e.deviceId);
}
