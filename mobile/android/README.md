# Mio Mobile — Android

Side-loaded APK (no Play Store) that turns a phone into a perception
surface and viewer for the desktop's Mio. It holds no API keys, makes
no model calls, and stores no conversation state — only the pairing
token in the Android Keystore and a few local UI prefs. If the desktop
is asleep, the phone is inert.

What the app does today:

- **Chat.** `chat.send` up; `chat.stream` text deltas,
  `chat.replyCaption`, and `chat.replyChunk` TTS audio back.
  `ChunkPlayer` pre-downloads each WAV chunk to the cache dir as it
  lands on the WS so the playback pump only pays local decode setup —
  the naive prepare-on-demand loop stutters between sentences.
- **Avatar.** The desktop's Three.js + `@pixiv/three-vrm` scene,
  bundled verbatim into the APK by `avatar-bundler/` and run in a
  full-screen `WebView` over a virtual `https://appassets…` origin.
  The same gesture classifier the desktop uses runs there with
  touch-tuned thresholds; `MioAvatarBridge` is the JS↔Kotlin channel
  for gestures, talking/idle state, outfit changes, and haptic ticks.
- **Perception.** Camera stills (CameraX), screen frames
  (MediaProjection), continuous STT with pause-driven auto-send, and
  foreground-app package names (`AccessibilityService`) — all uploaded
  over `perception.upload`'s JSON-then-binary frame pair.
- **Always-on.** A `dataSync` foreground service owns the WS
  connection and the audio player across UI teardown; a Quick Settings
  tile and a home-screen widget mirror connection + talking state; a
  `SYSTEM_ALERT_WINDOW` bubble keeps chat reachable while another app
  is in front.
- **Agent remote.** `AgentScreen` pauses, triggers, and re-tunes the
  desktop's autonomous loop from the phone.

Phase-by-phase status (which of M-0 → M-8 shipped, and what is still
open) lives in [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md) §3.4.

## What's in here

```
mobile/android/
├── app/
│   ├── build.gradle.kts          ← module config + avatar bundling + flavors
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/io/mio/mobile/
│       │   ├── MioApp.kt                  ← Application
│       │   ├── MainActivity.kt            ← routes Pairing ↔ Chat ↔ overlays
│       │   ├── audio/ChunkPlayer.kt       ← prefetching ordered WAV pump
│       │   ├── avatar/
│       │   │   ├── AvatarWebView.kt       ← WebViewAssetLoader-hosted scene
│       │   │   ├── AvatarSurface.kt       ← Compose host + controller
│       │   │   ├── MioAvatarBridge.kt     ← JS ↔ Kotlin channel
│       │   │   ├── AvatarAssetCatalog.kt  ← wardrobe from bundled .vrm names
│       │   │   └── HapticTicker.kt        ← gesture-classified haptics
│       │   ├── camera/CameraSession.kt    ← CameraX single-frame capture
│       │   ├── stt/SpeechSession.kt       ← SpeechRecognizer voice mode
│       │   ├── screen/ScreenCaptureSession.kt ← MediaProjection → 1 JPEG
│       │   ├── overlay/ChatOverlay.kt     ← floating bubble + chat dock
│       │   ├── net/
│       │   │   ├── Discovery.kt           ← NsdManager (_mio._tcp.)
│       │   │   ├── MioClient.kt           ← OkHttp WS + reconnect
│       │   │   └── Protocol.kt            ← Kotlin twin of protocol.ts
│       │   ├── secure/
│       │   │   ├── PairingPayload.kt      ← mio:// URI parser
│       │   │   ├── TokenStore.kt          ← Android Keystore-backed
│       │   │   └── MobilePrefs.kt         ← phone-local UI prefs
│       │   ├── service/
│       │   │   ├── MioForegroundService.kt← sticky notif + WS + player owner
│       │   │   ├── MioAccessibilityService.kt ← foreground package name only
│       │   │   ├── ActiveAppRelay.kt      ← in-process channel between the two
│       │   │   ├── MioQuickSettingsTile.kt
│       │   │   └── MioStatusBroadcast.kt  ← state fan-out to tile + widget
│       │   ├── widget/MioStatusWidget.kt  ← home/lock-screen RemoteViews
│       │   └── ui/
│       │       ├── ChatScreen.kt
│       │       ├── PairingScreen.kt       ← QR scanner + manual paste
│       │       ├── SettingsScreen.kt
│       │       ├── AgentScreen.kt         ← remote for the desktop agent loop
│       │       ├── BatteryGuideScreen.kt  ← per-OEM battery whitelisting
│       │       ├── GestureGuideScreen.kt  ← "how to touch the avatar"
│       │       └── Theme.kt
│       └── res/                           ← icons, strings, themes, widget XML
├── avatar-bundler/                ← esbuild project; see its own README
├── build.gradle.kts
├── gradle/libs.versions.toml      ← single source of truth for deps
├── gradle.properties
└── settings.gradle.kts
```

## Build prerequisites

- Android Studio Ladybug (2024.2.1) or newer.
- JDK 17 on `JAVA_HOME`.
- Node.js + npm on `PATH` — the `bundleAvatarJs` Gradle task shells out
  to `npm` to esbuild the desktop avatar scene into the APK.
- A device or emulator running Android 8.0 (API 26) or newer, on the
  same LAN as the desktop running Mio.

### Avatar assets

The build snapshots the desktop's avatar sources into the APK, so it
reads out of `desktop/` in the same working tree. Those inputs come in
two tiers of strictness:

| Path | Required? | If missing |
|---|---|---|
| `desktop/src/renderer/avatar/{main,gestures}.ts`, `index.html`, `style.css` | **yes** | `checkAvatarSources` fails the build |
| `desktop/assets/vrm/` | **yes** | `checkAvatarSources` fails the build and points at `desktop/assets/README.md` |
| `desktop/assets/animations/{idle,talking,extras}/` | no | Warning logged, copy skipped, build continues |

A fresh clone has the VRM model but **not** the `.vrma` animations —
they are pixiv's and are not redistributed here (see
[`../../desktop/assets/README.md`](../../desktop/assets/README.md)).
So the out-of-the-box build succeeds and produces a working APK; the
avatar simply holds its rest pose instead of playing idle / talking
loops. Everything else — chat, TTS, perception, gestures, the agent
remote — is unaffected. Drop `.vrma` files into those folders and
rebuild to get animation.

## First-time setup

1. Open `mobile/android` in Android Studio. It will import the module
   and download Gradle 8.9 + AGP 8.5 + Kotlin 2.0 on first sync.
2. Check the avatar assets — see [Avatar assets](#avatar-assets) above.
   `preBuild` snapshots `desktop/src/renderer/avatar/**` and
   `desktop/assets/**` into the APK; missing scene sources or a missing
   `desktop/assets/vrm/` stop the build, while missing animations only
   log a warning.
3. From a terminal in `mobile/android/`, run:
   ```bash
   ./gradlew :app:assembleFullDebug
   ```
   The APK lands in `app/build/outputs/apk/full/debug/app-full-debug.apk`.
   (The `full`/`lite` split is described under Phase M-7 below; bare
   `assembleDebug` builds both flavors.)
4. Side-load:
   ```bash
   adb install -r app/build/outputs/apk/full/debug/app-full-debug.apk
   ```

## Pairing flow

1. Boot the desktop app (`npm --prefix desktop run dev`).
2. Open Mio Settings → **Mobile** → **Generate QR**. The QR encodes:
   ```
   mio://pair?h=<lan-ip>&p=<port>&t=<token>&d=<deviceId>&v=0
   ```
3. On the phone, launch Mio. Grant camera + notifications. Tap
   **Scan QR code** and frame the desktop QR. The token persists in
   Android Keystore; the WS connection comes up immediately.
4. If the camera is unavailable, tap **Pair manually** and paste the
   URI shown under the QR.

The desktop's `mio://pair?…` URI is also a registered deep-link, so a
shared link tapped from anywhere on the device opens straight into the
pairing screen with the payload pre-applied.

## Verifying the WS connection

Smoke from the desktop to confirm the brain side is healthy:

```bash
node desktop/scripts/ws-smoke.mjs --text "テスト"
```

Then send the same text from the phone. The two replies should
arrive in lockstep (the brain is shared) — that was the Phase M-1
exit criterion and is still the fastest end-to-end check.

## Roadmap

- **Scrollback on cold start.** Chat history lives in a ring buffer in
  the foreground service; the desktop already keeps the canonical log,
  so wiring the client to `chat.getHistory` restores history across
  restarts.
- **Gapless audio.** `chat.replyChunk` plays one chunk at a time.
  Pre-downloading each WAV closes most of the seam; an `ExoPlayer` swap
  is scoped to close the rest.
- **Zero-config discovery.** mDNS is implemented in `Discovery.kt`;
  consuming it from the pairing UI removes the re-pairing step when the
  desktop's IP changes.

## Permissions cheat sheet

| Permission | When asked | Why |
|---|---|---|
| `INTERNET` | Manifest-only | WS connection to desktop |
| `ACCESS_NETWORK_STATE` | Manifest-only | Reconnect on Wi-Fi changes |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | Manifest-only (API 34+) | Sticky WS connection |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` | Manifest-only | The type must be claimed before `getMediaProjection()` on API 34 |
| `FOREGROUND_SERVICE_MICROPHONE` | Manifest-only | STT driven from the service while the activity is backgrounded |
| `POST_NOTIFICATIONS` | First launch (API 33+) | Persistent "Mio is online" + the warning / surface channels |
| `CAMERA` | First scan, then first perception pull | QR pairing scanner, then camera frames |
| `RECORD_AUDIO` | First mic tap | `SpeechRecognizer` voice mode |
| `CHANGE_WIFI_MULTICAST_STATE` | Manifest-only | NSD discovery on stricter OEMs |
| `VIBRATE` | Manifest-only | Haptic tick when the JS controller classifies a touch |
| `SYSTEM_ALERT_WINDOW` | System Settings, driven by the in-app overlay toggle | Background floating bubble + chat dock |
| MediaProjection consent | Per projection session | Screen frames |
| `BIND_ACCESSIBILITY_SERVICE` | User enables the service in system Settings | Foreground-app package name |

Nothing is asked for up front: each runtime grant is requested at the
moment the feature is first used, and the two special permissions
(overlay, accessibility) require a deliberate trip into system
Settings. `MioAccessibilityService` reads the foreground package name
only — `canRetrieveWindowContent` is `false` and the event stream is
narrowed to `typeWindowStateChanged`, so on-screen text is never
reachable.

Phase M-2 originally planned a `SYSTEM_ALERT_WINDOW` overlay for the
avatar, but the in-app full-screen WebView re-design (M-2.3) removed
that requirement; the permission came back later, for the much smaller
background chat bubble. Warnings reach the user via a heads-up
notification channel plus an in-app Snackbar when `ChatScreen` is on
screen.

## Where to look next

- Wire framing → `desktop/src/shared/protocol.ts` (canonical) and
  `app/src/main/java/io/mio/mobile/net/Protocol.kt` (mirror).
- Server-side pairing endpoint → `desktop/src/main/ipcShim.ts`
  (`PairingIssueQr`).
- Reference WS client (run side-by-side for debugging) →
  `desktop/scripts/ws-smoke.mjs`.

## Phase M-7 — release builds, OEM polish, off-LAN

### Building `app-full-release.apk`

The release variant is signed via a keystore that lives at
`mobile/android/keystore/mio-release.jks`. Both the keystore and its
companion `keystore.properties` are gitignored — they belong in an
offline backup, never in source control. The release Gradle config
auto-detects whether the file is present; missing → falls back to the
debug signing key so a fresh clone still builds. To build a signed
release APK:

```powershell
cd mobile/android
./gradlew :app:assembleFullRelease
```

Output: `app/build/outputs/apk/full/release/app-full-release.apk`.
For a debug-signed variant suitable for side-loading without the
keystore at hand, use `assembleFullDebug` instead — output at
`app/build/outputs/apk/full/debug/app-full-debug.apk`.

### Product flavors

M-7.3 introduces two flavors. Neither names a model file: the
`bundleMioAssets` task copies every `*.vrm` it finds in
`desktop/assets/vrm/` into the APK, and `AvatarAssetCatalog` derives
the wardrobe from those filenames at runtime — the same rule the
desktop uses, so dropping another model into that folder reaches both
surfaces with no code change.

- **`full`** — the default; packages whatever `desktop/assets/vrm/`
  holds. In this repository that is one model.
- **`lite`** — same build, plus a per-flavor asset source set that
  shadows the packaged VRMs with trimmed ones from
  `desktop/assets/vrm/mobile/` when that directory exists at build
  time. Absent it (today's default) `lite` packages exactly what
  `full` does, minus the `-lite` version suffix — the build never
  fails over a missing trimmed asset.
  Intended for mid-range Androids where WebGL on a full-poly model
  drops frames.

Build the lite variant with `./gradlew :app:assembleLiteDebug` or
`assembleLiteRelease`.

### Keystore backup procedure

**This is the single most important file in the Android project.** Keep
an offline backup of the keystore and its passwords; losing them means
you can no longer ship updates to installed devices. An update APK
signed with a different key will not overwrite the installed copy —
users must uninstall the old one first (destroying their pairing,
chat-side state, etc.).

1. Back up `mobile/android/keystore/` (both `mio-release.jks` and
   `keystore.properties`) to storage outside the working tree
   immediately after generation — an encrypted archive or a password
   manager entry, kept somewhere the repo can never reach.
2. Refresh the backup whenever you rotate the password.
3. Do **not** commit either file. The repo-level `.gitignore` already
   excludes `*.jks` and `*.properties`; the `mobile/android/keystore/`
   path adds belt-and-braces.

To rotate the keystore: generate a new one and bump `versionCode`;
the next user-installed update will require an uninstall (so coordinate
with side-loaded testers before rotating).

### Tailscale / off-LAN

The desktop server binds the LAN by default. To pair from a phone
that isn't on the same Wi-Fi:

1. Install Tailscale on both desktop and phone, sign into the same
   tailnet, ensure both nodes show "Connected" in the Tailscale app.
2. On the desktop, identify the desktop's Tailscale hostname (e.g.
   `tail3a7b91.ts.net` or the MagicDNS short name).
3. Generate the pairing QR from Mio Settings → Mobile **but**
   override the LAN IP with the Tailscale hostname before scanning.
   The `mio://pair?h=<host>&p=<port>&t=<token>&d=<deviceId>&v=0`
   URI accepts any hostname; we used to default to the LAN IP, but
   any DNS-resolvable name (Tailscale, mDNS, a router-side host
   alias) works.
4. On the phone, scan the QR. The token rides in `auth.hello` on
   every reconnect; once paired, the phone re-resolves the hostname
   on each reconnect so Tailscale's network changes don't break
   anything.

Caveat: the risk register flags `Tailscale latency hurts TTS chunk
pacing` as Low–Medium. The existing chunk-at-a-time `chat.replyChunk`
flow is already designed to absorb high-RTT links, but if you
notice audible pacing seams enable MagicDNS to ensure DERP isn't
relaying every packet through a third region.

### OEM battery-optimization

The chat surface ships an in-app **Battery** entry in the top status
bar that opens `BatteryGuideScreen`. It branches on
`Build.MANUFACTURER` for Xiaomi MIUI, Samsung One UI, Huawei EMUI,
OPPO ColorOS, Vivo Funtouch / OriginOS, with a stock Android
fallback for everything else. The primary CTA opens
`Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`; the
secondary CTA jumps straight to the OEM-specific app-protection /
auto-start activity when one exists.

### Battery + WebGL profiling

Observation tasks. Run from a host with `adb` on PATH and the phone
unlocked:

```powershell
# 24-h idle drain check.
adb shell dumpsys batterystats --reset
# (leave the phone overnight on standby, paired, agent loop on default cadence)
adb shell dumpsys batterystats > out.txt
# Inspect the section "Estimated power use" for io.mio.mobile.

# WebGL frame-time profiling while the avatar is talking.
adb shell setprop debug.hwui.profile true
adb shell dumpsys gfxinfo io.mio.mobile framestats > gfx.txt
adb shell setprop debug.hwui.profile false
```

The Phase M-7 exit criteria are < 5% overnight battery delta and
median frame time ≤ 16 ms during the talking animation on a 60 Hz
mid-range device.
