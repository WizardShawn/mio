// One-shot smoke test for the index.html rewrite logic in build.gradle.kts.
// Not part of the build — `node smoke-rewrite.mjs` from anywhere in the repo
// prints the rewritten index.html so a dev can eyeball the CSP + script tag
// changes before trusting Gradle to do the same.
//
// Safe to delete once an on-device run confirms the rewrite works.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexPath = path.join(repoRoot, 'desktop/src/renderer/avatar/index.html');

const src = readFileSync(indexPath, 'utf8');
const rewritten = src
  .replace(/(\s*cortana-asset:)/g, '')
  .replace(
    '<script type="module" src="./main.ts"></script>',
    '<script src="./__mioAvatarBridge.js"></script>\n    <script src="./main.bundle.js"></script>',
  );

console.log(rewritten);
