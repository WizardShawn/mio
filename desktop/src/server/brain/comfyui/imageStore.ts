import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getHost } from '../host';

// Phase 10 — the on-disk landing zone for every PNG Mio renders via
// `generate_image`.

const DIR_NAME = 'generated';

/** Lazily ensure-and-return the `<userData>/generated/` directory. */
export function generatedDir(): string {
  const dir = path.join(getHost().paths.userData, DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface CacheKeyParts {
  workflow: unknown;
  prompt: string;
  seed: number;
}

export function cacheKey(parts: CacheKeyParts): string {
  return createHash('sha256')
    .update(JSON.stringify(parts.workflow))
    .update('\n')
    .update(parts.prompt)
    .update('\n')
    .update(String(parts.seed))
    .digest('hex')
    .slice(0, 24);
}

export interface SavedImage {
  absPath: string;
  dataUrl: string;
  sha256: string;
  cached: boolean;
}

function tsStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function slugify(text: string, maxLen = 32): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) return 'image';
  return slug.length > maxLen ? slug.slice(0, maxLen).replace(/-+$/, '') : slug;
}

function findCached(key: string): string | null {
  const dir = generatedDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = `-${key}.png`;
  for (const name of entries) {
    if (name.endsWith(suffix)) return path.join(dir, name);
  }
  return null;
}

function readAsDataUrl(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

export function save(args: {
  bytes: Buffer;
  prompt: string;
  key: string;
  now?: Date;
}): SavedImage {
  const { bytes, prompt, key } = args;
  const existing = findCached(key);
  if (existing) {
    return {
      absPath: existing,
      dataUrl: readAsDataUrl(existing),
      sha256: key,
      cached: true,
    };
  }
  const dir = generatedDir();
  const fileName = `${tsStamp(args.now)}-${slugify(prompt)}-${key}.png`;
  const absPath = path.join(dir, fileName);
  fs.writeFileSync(absPath, bytes, { mode: 0o600 });
  return {
    absPath,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    sha256: key,
    cached: false,
  };
}

export function findByKey(key: string): SavedImage | null {
  const existing = findCached(key);
  if (!existing) return null;
  return {
    absPath: existing,
    dataUrl: readAsDataUrl(existing),
    sha256: key,
    cached: true,
  };
}
