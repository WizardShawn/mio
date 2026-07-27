'use strict';

// Installs the exact Chromium build Playwright needs into a project-local
// `pw-browsers/` folder. electron-builder bundles that folder as an
// extraResource, and the packaged app points PLAYWRIGHT_BROWSERS_PATH at
// it (see src/main/tools/browserTool.ts). Without this, a packaged build
// ships a browser tool with no browser to drive.
//
// `--no-shell` skips the ~270 MB headless-shell build — the tool always
// launches headed Chromium (headless: false). The install is idempotent:
// Playwright skips the download when the INSTALLATION_COMPLETE marker is
// already present, so re-running `npm run dist` is cheap.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const browsersDir = path.join(root, 'pw-browsers');
// `playwright/cli.js` is not an exported subpath, so resolve the package's
// main entry and reach `cli.js` next to it.
const cli = path.join(path.dirname(require.resolve('playwright')), 'cli.js');

console.log(`[pw:install] ensuring Chromium is present in ${browsersDir}`);
execFileSync(process.execPath, [cli, 'install', '--no-shell', 'chromium'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir },
});
console.log('[pw:install] done.');
