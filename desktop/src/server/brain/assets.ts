import fs from 'node:fs';
import path from 'node:path';

import type { AssetManifest, OutfitDescriptor } from '@shared/protocol';

import { getHost } from './host';

// Resolution order:
//   1. <userData>/assets       (production / user-supplied drop-in)
//   2. <repo-root>/assets      (dev / packaged extraResources)
// First directory that exists *and contains a .vrm* wins.

const SUPPORTED_VRM = new Set(['.vrm']);
const SUPPORTED_ANIM = new Set(['.vrma']);

/** Fallback outfit id used when the wardrobe is empty. */
const FALLBACK_OUTFIT_ID = 'default';

export interface ResolvedAssets {
  rootDir: string;
  manifest: AssetManifest;
}

function repoRootAssetsCandidate(): string {
  const host = getHost();
  if (host.paths.isPackaged) {
    return path.join(host.paths.resourcesPath, 'assets');
  }
  // Dev: __dirname = <repo>/out/main, so two levels up.
  return path.resolve(__dirname, '..', '..', 'assets');
}

function listByExt(dir: string, allowedExts: Set<string>): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => allowedExts.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(dir, name));
}

/**
 * Derive a stable, snake_case outfit id from a `.vrm` filename. We
 * strip the optional `Mio_` author prefix and the extension, then
 * lowercase + insert underscores at CamelCase boundaries.
 *
 *   "Mio_WhiteSkirt.vrm" → "white_skirt"
 *   "Mio_Kimono.vrm"     → "kimono"
 *   "澪.vrm"             → "default" (no ASCII core left → fallback)
 */
function outfitIdFromFilename(fileName: string): string {
  const base = path.basename(fileName, path.extname(fileName));
  const stripped = base.replace(/^Mio[_\-]/i, '');
  const slug = stripped
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return slug.length > 0 ? slug : FALLBACK_OUTFIT_ID;
}

/**
 * Pretty label for the operator-facing list. `kimono` → `Kimono`;
 * `white_skirt` → `White Skirt`. The label is also what Mio reads
 * back to the user when she switches ("Kimono に着替えるね").
 */
function outfitLabelFromId(id: string): string {
  if (id === FALLBACK_OUTFIT_ID) return 'Default';
  return id
    .split('_')
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function buildOutfits(vrmFiles: string[]): OutfitDescriptor[] {
  const usedIds = new Set<string>();
  const out: OutfitDescriptor[] = [];
  for (const vrmPath of vrmFiles) {
    let id = outfitIdFromFilename(vrmPath);
    // Two outfits collapsing to the same slug (e.g. `Mio_Kimono.vrm`
    // and a hypothetical `Kimono.vrm`) would otherwise overwrite
    // each other in the picker. Disambiguate with a numeric suffix
    // so both stay reachable from `change_clothes`.
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    usedIds.add(id);
    out.push({
      id,
      label: outfitLabelFromId(id),
      vrmPath,
    });
  }
  return out;
}

function buildManifest(rootDir: string): AssetManifest {
  const vrmFiles = listByExt(path.join(rootDir, 'vrm'), SUPPORTED_VRM);
  const idleAnimations = listByExt(
    path.join(rootDir, 'animations', 'idle'),
    SUPPORTED_ANIM,
  );
  const talkingAnimations = listByExt(
    path.join(rootDir, 'animations', 'talking'),
    SUPPORTED_ANIM,
  );
  const extrasAnimations = listByExt(
    path.join(rootDir, 'animations', 'extras'),
    SUPPORTED_ANIM,
  );

  const outfits = buildOutfits(vrmFiles);
  const active = outfits[0] ?? null;

  return {
    vrmPath: active?.vrmPath ?? null,
    idleAnimations,
    talkingAnimations,
    extrasAnimations,
    outfits,
    activeOutfitId: active?.id,
  };
}

export function resolveAssets(): ResolvedAssets {
  const host = getHost();
  const candidates = [
    path.join(host.paths.userData, 'assets'),
    repoRootAssetsCandidate(),
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) {
      console.log(`[assets] candidate missing: ${dir}`);
      continue;
    }
    const manifest = buildManifest(dir);
    const outfitCount = manifest.outfits?.length ?? 0;
    console.log(
      `[assets] candidate ${dir} — vrm=${manifest.vrmPath ?? 'none'} ` +
        `outfits=${outfitCount}`,
    );
    if (manifest.vrmPath) {
      console.log(`[assets] resolved assets root: ${dir}`);
      return { rootDir: dir, manifest };
    }
  }

  const fallbackRoot = candidates[candidates.length - 1]!;
  console.warn(
    `[assets] no VRM found in any candidate — falling back to ${fallbackRoot}`,
  );
  return { rootDir: fallbackRoot, manifest: buildManifest(fallbackRoot) };
}

// Ensures the userData/assets folder skeleton exists so the user has somewhere
// to drop their own files in production. Safe to call on every launch.
export function ensureUserAssetDirs(): void {
  const base = path.join(getHost().paths.userData, 'assets');
  for (const sub of ['vrm', 'animations/idle', 'animations/talking', 'animations/extras']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

/**
 * Look up an outfit by id against the freshly-resolved manifest. The
 * `change_clothes` tool uses this to validate the model's choice and
 * to get the absolute VRM path it needs to broadcast on the bus.
 */
export function findOutfitById(
  manifest: AssetManifest,
  outfitId: string,
): OutfitDescriptor | null {
  const list = manifest.outfits ?? [];
  return list.find((o) => o.id === outfitId) ?? null;
}

/**
 * Apply an "active outfit" override on top of a resolved manifest,
 * moving the chosen outfit into `vrmPath` and `activeOutfitId`. The
 * underlying file list is unchanged so subsequent reads stay stable.
 */
export function manifestWithActiveOutfit(
  manifest: AssetManifest,
  outfitId: string | null,
): AssetManifest {
  if (!outfitId) return manifest;
  const outfit = findOutfitById(manifest, outfitId);
  if (!outfit) return manifest;
  return {
    ...manifest,
    vrmPath: outfit.vrmPath,
    activeOutfitId: outfit.id,
  };
}
