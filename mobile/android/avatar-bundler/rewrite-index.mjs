// Sync helper — mirrors the rewrite logic in `build.gradle.kts`'s
// `bundleMioAssets` task so a dev can refresh the in-tree mirror
// without running a full gradle build. Safe to run any time;
// gradle preBuild re-runs the same logic so this is purely a
// convenience for repo-state hygiene.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexSrc = path.join(repoRoot, 'desktop/src/renderer/avatar/index.html');
const indexDst = path.join(repoRoot, 'mobile/android/app/src/main/assets/avatar/index.html');

const src = readFileSync(indexSrc, 'utf8');
const out = src
  .replace(/(\s*cortana-asset:)/g, '')
  .replace(
    '<script type="module" src="./main.ts"></script>',
    '<script src="./__mioAvatarBridge.js"></script>\n    <script src="./main.bundle.js"></script>',
  );
writeFileSync(indexDst, out, 'utf8');
console.log(`wrote ${out.length} bytes -> ${path.relative(repoRoot, indexDst)}`);
