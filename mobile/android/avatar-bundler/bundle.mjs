// Bundles `desktop/src/renderer/avatar/main.ts` into a single IIFE script
// that the Android WebView can load via `file:///android_asset/avatar/main.bundle.js`.
//
// Why a separate bundler instead of reusing electron-vite?
//   - electron-vite is tied to the Electron process model and bakes in
//     paths / scheme assumptions (`cortana-asset://`) that don't apply
//     in a WebView loading from `file://`.
//   - The mobile WebView never needs the Electron preload bridge — it
//     talks to Kotlin via `WebMessageListener` (see M-2.2). All the JS
//     needs is a single self-contained script.
//
// Why IIFE not ESM?
//   - `file://` ES modules are blocked in many Android WebView versions
//     (CORS rules apply to `file:` origins). An IIFE bundle sidesteps
//     it entirely and runs everywhere.
//
// Where the desktop's `@shared/ipc` import resolves:
//   - The desktop `tsconfig.web.json` aliases `@shared/*` → `src/shared/*`.
//   - Mirrored here as an esbuild alias against absolute repo paths.
//
// Defines:
//   - `__MIO_PLATFORM__` = `'android'`. The Android-targeted patches in
//     `main.ts` / `gestures.ts` (added in M-2.5) gate on this so the
//     desktop and mobile bundles share the same source. Falsy on the
//     desktop's electron-vite build.

import { build } from 'esbuild';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo layout: mobile/android/avatar-bundler/ → ../../../
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AVATAR_SRC = path.join(REPO_ROOT, 'desktop', 'src', 'renderer', 'avatar');
const SHARED_SRC = path.join(REPO_ROOT, 'desktop', 'src', 'shared');
const ENTRY = path.join(AVATAR_SRC, 'main.ts');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'main.bundle.js');

function assertSourceExists(p) {
  if (!existsSync(p)) {
    console.error(`[avatar-bundler] missing source: ${p}`);
    process.exit(2);
  }
  if (!statSync(p).isFile() && !statSync(p).isDirectory()) {
    console.error(`[avatar-bundler] not a file or dir: ${p}`);
    process.exit(2);
  }
}

assertSourceExists(ENTRY);
assertSourceExists(path.join(AVATAR_SRC, 'gestures.ts'));
assertSourceExists(path.join(SHARED_SRC, 'ipc.ts'));
assertSourceExists(path.join(SHARED_SRC, 'protocol.ts'));

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const minify = process.env.MIO_BUNDLER_MINIFY !== '0';
// Inline sourcemaps balloon the APK (~3× the bundle size). Default to
// external `.map` files so the APK ships only the minified runtime;
// devs who want stepping inside Chrome devtools can opt in.
const sourcemap = process.env.MIO_BUNDLER_INLINE_SOURCEMAP === '1'
  ? 'inline'
  : process.env.MIO_BUNDLER_NO_SOURCEMAP === '1'
    ? false
    : true;

await build({
  entryPoints: [ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify,
  sourcemap,
  legalComments: 'none',
  // `@shared/ipc` (and any `@shared/protocol`) resolves to the desktop's
  // shared folder. Keep the alias narrow so we don't accidentally pull
  // in `@shared/anything-electron-specific`.
  alias: {
    '@shared/ipc': path.join(SHARED_SRC, 'ipc.ts'),
    '@shared/protocol': path.join(SHARED_SRC, 'protocol.ts'),
  },
  define: {
    __MIO_PLATFORM__: JSON.stringify('android'),
  },
  // Single-file bundle: every external dependency (three, three-vrm, …)
  // gets inlined. The Android WebView fetches `main.bundle.js` once.
  external: [],
  loader: {
    '.ts': 'ts',
  },
  banner: {
    js: '/* Mio avatar bundle — built by mobile/android/avatar-bundler/bundle.mjs. Do not edit by hand. */',
  },
  logLevel: 'info',
});

const built = statSync(OUT_FILE);
console.log(
  `[avatar-bundler] wrote ${path.relative(REPO_ROOT, OUT_FILE)} (${Math.round(built.size / 1024)} KB, minify=${minify}, sourcemap=${sourcemap})`,
);
