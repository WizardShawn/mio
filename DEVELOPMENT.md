# Mio — Development

Mio is a persistent VRM-avatar AI assistant. One **brain** runs 24/7 on the
desktop and owns everything stateful — agent loop, memory, persona, model
orchestration. Every surface (the desktop overlay, the Android app) is a thin
client of that brain.

```
Desktop host (always-on)
  brain ── agent loop · memory · persona · model orchestration
  transports ── Electron IPC (local renderer) · WebSocket+HTTP (LAN clients)
        │
   LAN / Tailscale
        │
  Android app (sensor + viewer — no brain, no keys, no memory)
```

This doc has three sections: **server development** (the brain and its
transports), **desktop client development** (the Electron app), and **mobile
app development** (the Android client).

---

## 1. Server Development

The server is the canonical brain plus the transports that wrap it. It is the
single source of truth for state; all clients are interchangeable.

### 1.1 Cardinal rule

```
desktop/src/server/brain/**  has  ZERO  imports from 'electron'.
```

This is an architectural invariant, not an automated check — there is no CI in
this repository. Verify it yourself with the grep in §1.7 (`rg -n "from
'electron'" desktop/src/server`, expected 0 matches); if you fork this, that
one-liner is the natural thing to put in a pre-commit hook or a CI job.

When the brain needs a platform capability (paths, secret storage, screenshot,
active-window title, notifications, outbound HTTP), it calls the **host
adapter** — interface in `server/brain/host.ts`, Electron implementation in
`main/hostAdapter.ts`. A headless build would supply a different adapter.
Genuinely Electron-only concerns (windows, tray, dialogs, asset `protocol://`)
live in `main/` and are owned by the IPC shim.

### 1.2 Layout

```
desktop/src/
├── shared/protocol.ts      ← canonical method + event schema (THE contract)
├── server/                 ← transport-agnostic
│   ├── index.ts            ← createServer({ host }) → { methods, eventBus }
│   ├── eventBus.ts         ← typed in-process pub/sub
│   ├── methods.ts          ← one async function per protocol verb
│   ├── brain/              ← chatService, agent loop, memory, persona, tools…
│   └── transport/          ← ws.ts · http.ts · auth.ts · mdns.ts
└── main/                   ← Electron-only (adapter, IPC shim, windows, tray…)
```

### 1.3 The contract — `shared/protocol.ts`

Two maps both transports speak:

- **`ServerMethodMap`** — `{ args, result }` per RPC verb. Each maps to exactly
  one function in `server/methods.ts` (dot-name `chat.send` → `chatSend`).
  Groups: chat, sessions, greeting, agent, permissions, comfyui, keys, prefs,
  avatar.
- **`ServerEventMap`** — push signals the brain emits (`chat.stream`,
  `chat.replyChunk`, `avatar.setTalking`, `agent.status`, …).

### 1.4 Transports

- **Electron IPC** (`main/ipcShim.ts`) — thin `ipcMain.handle` delegators into
  `server.methods.*`, plus a bus subscription fanning events to the right
  `BrowserWindow`. Used by desktop renderers.
- **WebSocket + HTTP** (`server/transport/`) — token-auth WS at `/ws`, asset
  mirror at `/asset/...`, pairing at `/pair`, mDNS announce as
  `_mio._tcp.local.`. Used by mobile and any off-process client.

Both transports subscribe to the same event bus and route into the same
`methods.ts`, so a turn driven from any client is visible on every client and
backed by one database.

### 1.5 Extending the server

- **New method:** add to `ServerMethodMap`, implement in `methods.ts` (brain
  calls only), wire events through `eventBus` if needed. WS clients can call it
  immediately; the desktop renderer needs an `IpcChannels` key + shim + preload
  entry.
- **New platform capability:** extend the `HostAdapter` interface, implement in
  `main/hostAdapter.ts`, call via `getHost()`.

### 1.6 Memory system (load-bearing)

Memory is what gives the agent loop continuity — without it every cycle is
amnesic. It lives entirely in the brain (`server/brain/`: `database.ts`,
`memory.ts`, `recall.ts`, `compaction.ts`) and only ever on the desktop. No
client persists or syncs anything.

**Storage.** A single SQLite file (`better-sqlite3`). Vectors are stored as
BLOBs in that same file — no native loadable extension — and searched with
in-process cosine. Embeddings are **L2-normalized at write time**, so cosine
reduces to a dot product at query time. At personal-assistant scale (thousands
of turns) this is behaviorally identical to `sqlite-vec`; migrating to
`sqlite-vec` later is a one-table swap.

**Embeddings + compaction models.** Embeddings use Gemini
`gemini-embedding-001` (dim 768) via the existing Gemini key — Anthropic has no
embeddings API. Compaction summaries, recall reranking, and reflection all use
`gemini-3.5-flash`. All of them degrade gracefully when the Gemini key is
absent.

**Schema (SQLite):**

| Table | Purpose |
|---|---|
| `sessions` | chat sessions |
| `messages` | user-facing chat turns (`content`, `images_json`) |
| `memory_entries` | agent-cycle observations (`summary`, `notable`, `reason`, `tags`) |
| `agent_counters` | daily counters for safety caps (cycles, tokens, notifs, images) |
| `message_vectors` | semantic-recall index over chat turns (`embedding` BLOB, `dim`, `model`) |
| `session_compactions` | rolling Japanese summary for turns aged out of replay |
| `generated_images` | every image drawn via `generate_image` (prompt, intent, path) |

User preferences (display name, active session, gesture/greeting/agent/
permission/ComfyUI prefs, current outfit) live in a separate
`user-preferences.json` under `userData`. API keys never touch the DB or JSON —
they sit in the OS credential store. Model ids are not preferences: each call
site pins its own constant in code (see `chatService.ts`, `agent.ts`, and the
`gemini*.ts` helpers).

**Language discipline.** Everything stored — `messages.content`,
`memory_entries.text`, compaction summaries, embeddings — is Japanese. One
language keeps the vector space clean and lets TTS read straight off the same
buffer history replays from. The 繁中 caption is a per-render translation,
cached on disk by source text, never stored as memory.

**Recall pattern.** On every agent cycle and every chat turn, recall is
two-step, then merged into the model context under a token budget:

1. **Recency** — last K observations / messages by time.
2. **Semantic** — vector search against the current screenshot description or
   user message. One `gemini-embedding-001` call per turn (~200–500 ms cold,
   cached on repeats).

The reply preamble assembles these as labelled Japanese blocks: rolling
compaction summary, recent turns, and top-K semantically recalled past turns.
Replay window is capped at 50 exchanges; the DB keeps the full transcript.

**Compaction.** When recall context exceeds a threshold, older observations are
summarized into compact entries and the originals **demoted** — kept in the DB,
dropped from recall. Compaction runs fully detached from the chat path. This is
the bounded-context discipline any long-running autonomous agent needs: the
transcript grows without limit, the recall budget does not, and nothing is
thrown away to keep the two reconciled.

### 1.7 Verify

```bash
npm --prefix desktop run typecheck
rg -n "from 'electron'" desktop/src/server     # expect 0 matches
node desktop/scripts/ws-smoke.mjs --text "テスト"   # pairs, opens WS, drives a turn
```

While the smoke script runs, the desktop chat pill mirrors the same reply —
that is the shared-brain property.

---

## 2. Desktop Client Development

The desktop client is the Electron app: the always-on host process plus the
local renderer surfaces. It also packages the shared assets (VRM model,
animations, persona) that every client reuses by reference.

### 2.1 Requirements

- Windows 10/11, Node.js 22+, npm 11+
- An Anthropic API key (`sk-ant-…`); optionally a Gemini key for TTS,
  translation, embeddings, and compaction.

Both keys are supplied by whoever runs the app. Nothing is bundled and nothing
is read out of the repository: a key is either pasted into Settings — encrypted
through `HostAdapter.secrets` (DPAPI on Windows) into a `.enc` blob under
`userData` — or picked up from `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`. Neither
ever reaches the SQLite file, `userPreferences.json`, or a connected client.
Without the Gemini key the Gemini-backed paths degrade instead of failing.

### 2.2 Dev loop

```powershell
cd desktop
npm install
npm run dev        # Electron + Vite dev server with HMR
```

Other scripts: `npm run build` / `start` (production build), `typecheck`,
`dist` (NSIS installer), `package` (unpacked).

### 2.3 Renderer surfaces

The Electron main process hosts several `BrowserWindow` renderers, each driven
through the IPC shim:

- **Avatar** — transparent, frameless, always-on-top. `@pixiv/three-vrm` +
  `@pixiv/three-vrm-animation` render the `.vrm` with random looping idle /
  talking animations. Includes a bone-projection gesture detector — cursor
  activity classified against a per-frame projection of the rig's bones and
  spring-bone chains into eight verbs (`caress` · `poke` · `pat` · `tickle` ·
  `stroke` · `grab` · `tug` · `pinch`) — whose events batch into synthetic user
  turns.
- **Chat** — streaming chat UI summoned by a global hotkey; supports
  paste-to-attach image chips.
- **Settings, permission prompt, image overlay, tray menu** — supporting
  surfaces.

Every user turn auto-attaches a fresh screenshot (transient — not stored).
Pasted images persist in chat history.

### 2.4 Assets

The app loads from the first directory containing a `.vrm`:
`%APPDATA%/cortana-desktop-assistant/assets/`, then `./assets/`. Expected
shape:

```
assets/
├── vrm/                    # first .vrm found is loaded
└── animations/
    ├── idle/               # picked at random, looped
    ├── talking/            # picked at random while streaming
    └── extras/             # staging area, not loaded
```

VRM/VRMA files stream into the renderer over the `cortana-asset://` custom
protocol (mirrored at `http://host:port/asset/...` for WS clients), sandboxed
to the assets root. The persona lives in `desktop/persona.md`.

### 2.5 Status

Phases 1–10 shipped: avatar shell, chat loop, screenshot/touch input,
persistence + persona, agent loop with safety bounds, cross-source memory,
semantic recall + compaction, polish, agent tools/permissions/computer-use, and
ComfyUI image generation. Remaining: extended soak testing.

---

## 3. Mobile App Development

The mobile app is an Android APK (side-loaded, no Play Store) that turns a
phone into a **perception surface + viewer** for the desktop's Mio. It holds no
API keys, makes no model calls, and persists no memory. If the desktop is
asleep, Mio is asleep — intentionally.

> Android-only. Every iOS sandbox restriction Mio would hit (system-wide
> overlay, foreground-app screenshot, 24/7 foreground service, App Store review
> of AI-character apps) is permitted on Android with the right permissions.

### 3.1 Scope

- **Owns:** WS transport + reconnection, sensors (camera, screen, mic,
  foreground app), and rendering the avatar in a `WebView`.
- **Does not own:** persona, prompting, model knowledge, memory — all on the
  desktop. The phone is purely transport + sensors + rendering.

Memory written from a phone-initiated turn is visible on the desktop next turn
with **zero sync logic**, because the memory only ever lives on the desktop.

### 3.2 Connecting to the server

The desktop's WS+HTTP transport (section 1.4) is the mobile contract. The
Android side mirrors `shared/protocol.ts` into Kotlin by hand — there is no
shared codegen and no generated client, so **drift between the two definitions
is a real, known risk**. What exists today is a containment measure, not a
detector: both Kotlin `Json` instances (`net/MioClient.kt`,
`avatar/MioAvatarBridge.kt`) are configured with `ignoreUnknownKeys = true`, and
the TypeScript side parses with `JSON.parse`, so a field added on one side
decodes harmlessly on the other instead of throwing. That covers additive
changes; a renamed or retyped field still fails at runtime, and nothing catches
it before then. A fixture round-trip check — encode a sample of every frame type
on one side, decode on the other — is the obvious guard and **has not been
written yet**.

- **Wire framing** — JSON over `ws://host:port/ws`. First frame is `hello`
  with `{ token, deviceId, protocolVersion }`; then `call` frames get
  `callResult` replies, and `event` frames push bus events. Binary frames carry
  perception payloads: `perception.upload` sends its JSON `call` frame and then
  the JPEG bytes on the same socket, with a send lock on the client and a
  pending-upload state machine plus timeout on the server so the two halves
  cannot interleave with another call.
- **Pairing** — POST `{ deviceId }` to `/pair` → `{ token }`. Settings renders a
  `mio://pair?h=…&p=…&t=…&d=…` QR carrying host, port, and a freshly issued
  token; the phone scans it or takes the same URI as a deep link. The endpoint
  itself is still permissive — any LAN caller that POSTs a `deviceId` gets a
  token — so the QR is the ergonomic path, not an authorization gate. Tokens
  are 32 random bytes, encrypted on disk via `HostAdapter.secrets`.
- **Discovery** — desktop announces `_mio._tcp.local.`; Android discovers via
  `NsdManager`. Off-LAN uses Tailscale on both ends.

### 3.3 Process model

A single Android process: a foreground service holds the WS connection and
survives backgrounding; a full-screen in-app `WebView` renders the **same**
Three.js / `@pixiv/three-vrm` code the desktop uses, bundled into the APK by
`mobile/android/avatar-bundler` rather than forked. No native VRM renderer is
built. (`SYSTEM_ALERT_WINDOW` was the original plan for the avatar surface and
was dropped; it came back later, for a much smaller floating chat bubble shown
while the app is backgrounded.)

Sensors stream to the desktop as perception inputs: back/front camera
(CameraX), screen capture (MediaProjection), microphone + STT
(`SpeechRecognizer`), and foreground-app intel (`AccessibilityService`). Reply
text, TTS audio chunks, and avatar state stream back.

### 3.4 Phases

Mobile work was planned in phases M-0 → M-8: server preflight, Android scaffold,
VRM avatar in WebView, real-eyes camera, STT voice input, MediaProjection +
foreground intel, surface notifications + live state, polish/battery/OEM
whitelisting, and wardrobe + facial expressions.

M-0 → M-6 and M-8 have shipped; M-7 is partial. The app is 31 Kotlin files
(~10.4k lines) under `mobile/android/app/src/main/java/io/mio/mobile/`.

| Phase | State | Evidence |
|---|---|---|
| M-0 server preflight | shipped | `desktop/src/server/transport/` — `ws.ts` · `http.ts` · `auth.ts` · `mdns.ts` |
| M-1 scaffold | shipped | `net/MioClient.kt` (OkHttp WS + reconnect), `net/Protocol.kt` (hand-mirrored `shared/protocol.ts`), `secure/TokenStore.kt` (Android Keystore), `service/MioForegroundService.kt`, `ui/PairingScreen.kt` (QR + `mio://` deep link + manual paste), `ui/ChatScreen.kt`, `audio/ChunkPlayer.kt` |
| M-2 avatar in WebView | shipped | `avatar/` + `mobile/android/avatar-bundler/`. esbuild bundles the desktop's `renderer/avatar/{main,gestures}.ts` verbatim into an IIFE, served to the `WebView` off a virtual `https://appassets.androidplatform.net` origin by `WebViewAssetLoader` (three.js `fetch()`es the VRM, which `file://` can't satisfy); `MioAvatarBridge.kt` is the JS↔Kotlin channel; touch-vs-hover gesture branches gate on a `__MIO_PLATFORM__` define; `HapticTicker.kt` pulses when the JS controller classifies a touch |
| M-3 camera | shipped | `camera/CameraSession.kt` — CameraX, bind/capture/unbind per frame (no held camera between pulls), JPEG q75 with longest edge ≤ 1280 px, shipped over `perception.upload` |
| M-4 STT | shipped | `stt/SpeechSession.kt` — `SpeechRecognizer` restarted across sentence pauses, partials streamed as live preview, 6 s of silence auto-sends the accumulated transcript |
| M-5 projection + intel | shipped | `screen/ScreenCaptureSession.kt` (MediaProjection → `VirtualDisplay` → one JPEG, torn down per capture), `service/MioAccessibilityService.kt` + `ActiveAppRelay.kt` → `perception.activeApp`; the service claims the `mediaProjection` FGS type |
| M-6 notifications + live state | shipped | three channels in `MioForegroundService.kt` (connection · warning · `notification.surface`), `service/MioQuickSettingsTile.kt`, `widget/MioStatusWidget.kt`, fanned out over a custom broadcast by `MioStatusBroadcast.kt` |
| M-7 polish / battery / OEM | **partial** | Done: `ui/BatteryGuideScreen.kt` branches on `Build.MANUFACTURER` (MIUI · One UI · EMUI · ColorOS · Funtouch/OriginOS) into the OEM auto-start pages; `full`/`lite` product flavors and gitignored release signing in `app/build.gradle.kts`; off-LAN pairing (the `mio://pair` URI takes any resolvable hostname, so a Tailscale name works without client changes). Not done: the drain and frame-time measurements the phase exits on, and the `ExoPlayer` swap for TTS-chunk seams — `ChunkPlayer.kt` still pipelines `MediaPlayer` instances |
| M-8 wardrobe + expressions | shipped | `avatar/AvatarAssetCatalog.kt` derives one outfit per `.vrm` bundled into the APK, mirroring the desktop's `outfitIdFromFilename`; `avatar.setOutfit` reloads the model live. Expressions are not Kotlin code — the mood → `VRMExpression` table lives in the shared renderer bundle and is driven by the `mood` field on `avatar.setTalking` |

Work continued past the original plan: a background overlay (tagged M-10) in
`overlay/ChatOverlay.kt` — a floating bubble plus bottom chat dock the
foreground service raises when the activity stops and tears down when it
resumes, behind `SYSTEM_ALERT_WINDOW` and an in-app toggle — and
`ui/AgentScreen.kt`, a phone-side remote for the desktop agent loop
(`agent.pauseToggle`, `agent.runNow`, `agent.prefs*`).

### 3.5 Status

Side-loadable today; never submitted to a store. Standing gaps:

- **No cold-start history.** The chat log is an in-process ring buffer in the
  foreground service — deliberate, since the phone persists no conversation
  state — and the client does not yet call `chat.getHistory` to rehydrate after
  a restart.
- **Discovery not surfaced.** `net/Discovery.kt` implements the `_mio._tcp.`
  `NsdManager` browse, but pairing still uses the explicit host in the QR
  payload; nothing in the UI consumes a discovered service yet.
- **M-7 measurements outstanding** — see the table above.
- **Animations are not in the repo.** `desktop/assets/animations/{idle,talking,extras}`
  is empty on a fresh clone, so the APK builds (the Gradle bundler warns and
  skips those buckets) but the avatar holds its rest pose instead of playing
  idle / talking loops. A missing `desktop/assets/vrm/` is still a hard build
  failure — there would be no avatar at all. See `desktop/assets/README.md` for
  what ships and what you supply.
