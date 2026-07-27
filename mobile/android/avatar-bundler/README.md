# mio-avatar-bundler

esbuild project that produces `dist/main.bundle.js` — a self-contained
IIFE script the Android WebView loads via
`file:///android_asset/avatar/main.bundle.js`.

The source lives in `../../../desktop/src/renderer/avatar/` and is
shared verbatim with the Electron renderer. No Android-specific fork.
Platform-conditional branches (e.g. the touch-vs-hover caress dwell
in M-2.5) gate on the `__MIO_PLATFORM__` esbuild `define` (set to
`'android'` here, undefined / falsy on the desktop electron-vite build).

## Invocation

The bundler is normally invoked from the Gradle `bundleMioAssets`
task in `mobile/android/app/build.gradle.kts`, which runs:

```
npm --prefix mobile/android/avatar-bundler install --no-audit --no-fund
npm --prefix mobile/android/avatar-bundler run build
```

before copying everything into `app/src/main/assets/avatar/`.

Standalone invocation for debugging:

```
cd mobile/android/avatar-bundler
npm install
npm run build
# disable minify (readable output for breakpoint-debugging in chrome://inspect):
MIO_BUNDLER_MINIFY=0 npm run build
```

## What gets inlined

Everything `main.ts` and `gestures.ts` import:

- `three` (Three.js core)
- `three/examples/jsm/loaders/GLTFLoader.js`
- `@pixiv/three-vrm`
- `@pixiv/three-vrm-animation`
- `@shared/ipc` / `@shared/protocol` (type-only — erased at build time)

Total bundle size with minify on is ~1.0–1.5 MB. That's the cost of
shipping the same Three.js scene the desktop uses; the alternative
(rewriting the VRM renderer in Kotlin native + filament/Sceneform)
would be a multi-month detour and the desktop would still need its
own copy. Asset-drift is bigger than bundle-size risk.

## Why a separate `package.json` and not the desktop's?

- Lock the Android-side bundler's deps independently from the Electron
  app's, so a `desktop/package.json` bump that changes Vite / electron-vite
  version doesn't accidentally change WebView output.
- The Gradle task can install once and cache against this lockfile alone;
  it doesn't need `electron`, `better-sqlite3`, or any of the desktop's
  native modules.

Keep `three` and `@pixiv/three-vrm` versions in sync with the desktop's
`package.json` — drift here is the same animation-broken risk the
`checkAvatarSources` Gradle task mitigates for the asset copy. Nothing
enforces the version match automatically; it is a manual discipline.
