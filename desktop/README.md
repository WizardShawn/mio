# Cortana — Desktop VRM Assistant

> Lives at `<workspace>/desktop/`. The sibling `<workspace>/mobile/` folder holds the Android client that pairs with this app. See the workspace-level [`../README.md`](../README.md) for orientation across both subprojects, and [`../DEVELOPMENT.md`](../DEVELOPMENT.md) for the architecture and per-phase status.

A persistent Windows desktop assistant rendered as a VRM avatar overlay, talking to Claude over a global hotkey. It is also the **brain** for every other surface: the Android client holds no keys, no model calls, and no memory, and talks to this process over WS+HTTP.

## Status

Phases 1–10 have shipped. Remaining: extended soak testing (see [`../DEVELOPMENT.md`](../DEVELOPMENT.md) §2.5).

- **Avatar shell** — transparent, frameless, always-on-top window with a tray icon and single-instance lock. `@pixiv/three-vrm` + `@pixiv/three-vrm-animation` render the `.vrm` with random looping idle / talking animations.
- **Chat loop** — global hotkey (`Ctrl+Enter`) summons the input pill; replies stream from `@anthropic-ai/sdk`. The talking animation swaps in for the duration of any stream.
- **Keys** — Anthropic key stored encrypted via the host adapter's `secrets` (Electron `safeStorage` → Windows DPAPI), or read from `ANTHROPIC_API_KEY`. An optional Gemini key unlocks TTS, 繁中 captions, embeddings, and compaction; without it those paths degrade rather than fail.
- **Screenshot + touch input** — every user turn auto-attaches a fresh screenshot (transient — not stored in history, so the next turn pays for a fresh capture rather than re-sending a stale frame). `Ctrl+V` over the input pill attaches an image chip, and *that* image is stored in chat history and stays referenceable across turns.
- **Avatar pointer-interaction channel** — the renderer projects the loaded VRM's humanoid bones (plus spring-bone chains for hair / skirt / ribbon) into screen space every frame and classifies cursor activity against that region map. Hover-dwell over a region for 1.5 s (`CARESS_DWELL_MS`) fires a `caress`; a single click fires a `poke`. The classifier covers eight verbs in total — `caress` · `poke` · `pat` · `tickle` · `stroke` · `grab` · `tug` · `pinch` — each carrying the region label and tone it was detected on. Bursts are batched into one synthetic user turn rather than a stutter of replies.
- **Persistence + persona** — SQLite (`better-sqlite3`) via `server/brain/database.ts` holds sessions, messages, agent observations, vectors, compaction summaries, and generated-image records. Persona is authored in `persona.md`, not in code.
- **Agent loop** — `server/brain/agent.ts` runs autonomous cycles on a timer under cost/rate caps tracked in `agentCounters.ts`.
- **Memory + semantic recall + compaction** — `memory.ts`, `recall.ts`, `compaction.ts`: L2-normalized embeddings stored as BLOBs in the same SQLite file, recency + vector recall merged under a token budget, older observations summarized and demoted out of the recall set without being deleted.
- **Tools, permissions, computer use** — `toolRunner.ts` plus `brain/tools/` (files, shell, web, a Playwright-driven browser, wardrobe, image generation) behind the `brain/permissions/` gate (classifier, approval dialog, audit log). `brain/computerUse/` drives the real desktop: screenshot in, mouse/keyboard synthesized out through PowerShell P/Invoke into `user32.dll` (no native module), under a watchdog.
- **ComfyUI image generation** — `brain/comfyui/` drives a local ComfyUI server from the `generate_image` tool, with a daily cap and an auto-dismissing image overlay window.
- **LAN transport** — token-auth WebSocket + HTTP asset mirror + mDNS announce under `server/transport/`, which is what the Android client pairs against.

---

## Requirements

- Windows 10/11
- Node.js 22+ and npm 11+
- An Anthropic API key (`sk-ant-…`)
- Optionally a Gemini API key — TTS, 繁中 captions, embeddings, compaction, and recall reranking use it. Without it those paths degrade instead of failing.

## Assets layout

The app loads from the first directory it finds that contains a `.vrm`:

1. `%APPDATA%/cortana-desktop-assistant/assets/` (user drop-in for installed builds)
2. `./assets/` (repo root, used in dev and packaged as `extraResources` in prod)

Expected shape:

```
assets/
├── vrm/                       # every .vrm here becomes one wardrobe outfit
├── animations/
│   ├── idle/                  # .vrma, picked at random, looped
│   ├── talking/               # .vrma, picked at random while Claude is streaming
│   └── extras/                # not loaded by the app; staging area
└── workflows/                 # ComfyUI workflow graphs (optional)
```

Nothing is hard-coded to a filename: `src/server/brain/assets.ts` scans `vrm/` at boot and derives the outfit list from what it finds. This repository ships one model, `vrm/Mio_Kimono.vrm`; the animations are user-supplied. See [`assets/README.md`](./assets/README.md) for what is included, why, and where to get the rest.

If `vrm/` is empty at launch, a friendly placeholder appears in the avatar window with the path to drop a file into.

## Install + run (dev)

```powershell
cd desktop
npm install
npm run dev
```

> All `npm` commands run from `<workspace>/desktop/`. The workspace root is intentionally not a package.

This builds the main + preload, starts the Vite dev server for the renderers, and launches Electron. The avatar window appears in the bottom-right of the primary display.

To run the production build locally:

```powershell
npm run build
npm run start
```

## Configure the API key

Two options:

1. **In-app (recommended)**: summon the chat window (`Ctrl+Enter`), click the ⚙ icon — or use the tray menu → Settings… — paste your key, press Save. It is encrypted via `safeStorage` and written to `%APPDATA%/cortana-desktop-assistant/anthropic-api-key.enc`. The optional Gemini key is entered on the same screen.
2. **Environment variable** (overrides the stored key): set `ANTHROPIC_API_KEY` (and `GEMINI_API_KEY`) before launching Cortana. Useful for development or for hosts where the OS keychain isn't available.

Neither key ever reaches the SQLite file, the preferences JSON, or a connected client.

## Controls

| Action | How |
|---|---|
| Show / hide the input pill | `Ctrl+Enter` (toggle); `Esc` inside the pill also dismisses |
| Send a message | Enter |
| Attach a screenshot to the next turn | Press `PrintScreen` (or any tool that fills the clipboard with an image), focus the input pill, then `Ctrl+V` — a thumbnail chip appears; remove with × |
| Trigger a touch gesture | Hover-dwell the cursor over any projected body region for ≥ 1.5 s — fires `caress` |
| Poke | Single-click over any projected body region |
| Open settings | Tray menu → Settings… |
| Move avatar | Click + drag any transparent area of the avatar window |
| Tray menu | Right-click the tray icon — show/hide avatar, talk, settings, quit |
| Dev tools | `Ctrl+Shift+I` while a window is focused |

## How it all fits together

```
┌──────────────────────────────────────────────────────────────────┐
│ Electron main process                                            │
│                                                                  │
│  Avatar · Chat · Settings · Permission · Image-overlay windows   │
│        ▲                                                         │
│        │ ipcShim.ts  (ipcMain.handle → methods.*, bus → windows) │
│        ▼                                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ server/  — transport-agnostic, ZERO electron imports       │  │
│  │   methods.ts · eventBus.ts                                 │  │
│  │   brain/  chatService · agent · memory · recall ·          │  │
│  │           compaction · toolRunner · tools · permissions ·  │  │
│  │           computerUse · comfyui   → SQLite + Anthropic SDK │  │
│  │   transport/  ws.ts · http.ts · auth.ts · mdns.ts ──▶ LAN  │  │
│  └────────────────────────────────────────────────────────────┘  │
│        ▲ hostAdapter.ts (paths · secrets · screenshot · notify)  │
│                                                                  │
│  Tray icon · Global hotkey · Single-instance lock                │
└──────────────────────────────────────────────────────────────────┘
```

The brain never imports `electron`; platform capabilities reach it through the
host adapter. That is what lets the identical code path serve the local
renderer over IPC and the Android client over WebSocket. See
[`../DEVELOPMENT.md`](../DEVELOPMENT.md) §1 for the full contract.

The `cortana-asset://local/...` custom protocol streams the VRM and VRMA files from the resolved assets directory directly into the renderer without bundling them through Vite, sandboxed to the assets root.

## File map

```
src/
├── shared/
│   ├── protocol.ts     # canonical method + event schema — THE contract
│   └── ipc.ts          # Electron channel names + payload contracts
├── server/             # transport-agnostic; no electron imports
│   ├── index.ts        # createServer({ host }) → { methods, eventBus }
│   ├── methods.ts      # one async function per protocol verb
│   ├── eventBus.ts     # typed in-process pub/sub
│   ├── brain/
│   │   ├── host.ts             # HostAdapter interface (the electron seam)
│   │   ├── chatService.ts      # streaming chat turn + tool rounds
│   │   ├── agent.ts            # autonomous cycle loop
│   │   ├── agentCounters.ts    # daily cost / rate caps
│   │   ├── database.ts         # SQLite schema + migrations
│   │   ├── memory.ts · recall.ts · compaction.ts
│   │   ├── persona.ts · replyContext.ts · replyTts.ts · replyMood.ts
│   │   ├── toolRunner.ts + tools/       # files · shell · web · browser · image
│   │   ├── permissions/                 # classifier · gate · audit log
│   │   ├── computerUse/                 # Playwright session + watchdog
│   │   ├── comfyui/                     # image generation client + store
│   │   ├── geminiEmbed.ts · geminiTts.ts · geminiTranslate.ts
│   │   └── assets.ts           # resolve <userData>/assets vs <repo>/assets
│   └── transport/      # ws.ts · http.ts · auth.ts · mdns.ts
├── main/               # electron-only
│   ├── index.ts        # app lifecycle, single-instance lock, bootstrap
│   ├── hostAdapter.ts  # HostAdapter implementation (DPAPI, capture, notify)
│   ├── ipcShim.ts      # ipcMain.handle delegators + event fan-out
│   ├── windows.ts      # BrowserWindow creation for every surface
│   ├── tray.ts · hotkey.ts · permissionPrompt.ts · imageOverlay.ts
│   ├── screenshot.ts   # desktopCapturer across all displays
│   └── activeWindow.ts # PowerShell-backed foreground-window title
├── preload/            # contextBridge surfaces per window
└── renderer/           # avatar · chat · settings · permission · imageOverlay · menu
    └── avatar/
        ├── main.ts         # three.js scene boot + animation mixer
        └── gestures.ts     # bone-projection hover/click detector
```

## Scope and requirements

- **Models are pinned in code.** `chatService.ts` sets the chat model, `agent.ts` uses a cheaper one for autonomous cycles, and each Gemini helper pins its own. Changing one is a one-line edit.
- **Gemini-backed features use a second key.** TTS, 繁中 captions, embeddings, compaction, and recall reranking all call Gemini. Without that key recall falls back to recency only and the rest degrade gracefully.
- **ComfyUI is opt-in and external.** `generate_image` expects a ComfyUI server you run yourself, plus workflow graphs under `assets/workflows/`.
- **Animations are supplied per-install.** With `assets/animations/` empty the avatar loads and renders in its rest pose; everything else works. See [`assets/README.md`](./assets/README.md).
- **Windows host.** The host adapter is the portability seam and the brain is platform-free; the shipped implementation is Electron on Windows (DPAPI secrets, PowerShell foreground-window query).

## Scripts

```
npm run dev          # Electron + Vite dev server with HMR
npm run build        # Production build to ./out
npm run start        # Run the production build locally
npm run typecheck    # Strict tsc across main + renderer
npm run dist         # electron-builder full installer (NSIS)
npm run package      # electron-builder --dir (unpacked build)
```
