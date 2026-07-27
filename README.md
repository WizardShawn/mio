# Mio

A persistent VRM-avatar AI assistant that runs continuously on the desktop,
holds memory across sessions, and observes on its own schedule instead of
waiting to be prompted.

One **brain** runs 24/7 on a desktop host and owns everything stateful — the
agent loop, the memory store, the persona, model orchestration. Every
**surface** — the Electron overlay, the Android app — is a thin client of that
brain. Memory written from a phone-initiated turn is visible on the desktop the
next turn with *zero sync logic*, because the memory only ever lives in one
place.

```
┌──────────────────────────────────────────────────────────────────┐
│ Desktop host (always-on)                                         │
│                                                                  │
│   brain ── agent loop · memory · persona · model orchestration   │
│   transports ── Electron IPC (local) · WebSocket + HTTP (LAN)    │
│   API keys ── OS credential store, never leave this machine      │
└──────────────────────────────────────────────────────────────────┘
                    │
              LAN / Tailscale
                    │
┌──────────────────────────────────────────────────────────────────┐
│ Android client — sensor + viewer                                 │
│   no brain · no keys · no memory                                 │
│   camera · screen capture · mic/STT · foreground-app intel       │
└──────────────────────────────────────────────────────────────────┘
```

If the desktop is asleep, Mio is asleep. That is intentional.

---

## What makes it interesting

**The brain is platform-agnostic by construction.** `desktop/src/server/brain/**`
has zero imports from `electron`. Every platform capability the brain needs —
paths, secret storage, screenshots, active-window title, notifications,
outbound HTTP — goes through a `HostAdapter` interface. A headless build
supplies a different adapter and the brain doesn't notice. Verify it yourself:

```bash
rg -n "from 'electron'" desktop/src/server
```

**One protocol contract, two transports.** `shared/protocol.ts` defines a
`ServerMethodMap` (RPC verbs) and a `ServerEventMap` (push events). Electron IPC
and the WebSocket server both route into the same `methods.ts` and subscribe to
the same event bus, so a turn driven from any client is visible on every client
and backed by one database.

**Memory is a vector store without a vector extension.** A single SQLite file
via `better-sqlite3`; embeddings stored as BLOBs in that same file and searched
with in-process cosine. Embeddings are L2-normalized *at write time*, so cosine
reduces to a dot product at query time. At personal-assistant scale this is
behaviourally identical to `sqlite-vec` with one less native dependency, and
migrating later is a one-table swap.

**Recall is two-step, then budgeted.** Every agent cycle and chat turn merges
recency (last K by time) with semantic search against the current screenshot
description or user message, re-ranked for diversity, assembled into labelled
blocks under a token budget.

**Compaction demotes rather than deletes.** When recall context exceeds
threshold, older observations are summarized into compact entries and the
originals are *demoted* — still in the database, dropped from recall. The
transcript grows forever; the recall budget doesn't.

**The agent loop has real bounds.** Daily counters for cycles, tokens,
notifications and images are enforced in the database, not in a prompt. The
interrupt bar is deliberately high — an assistant that speaks every ten minutes
is a nuisance, so most cycles write a private note and stay silent.

**One storage language.** Everything persisted — messages, observations,
compaction summaries, embeddings — is Japanese. One language keeps the vector
space clean and lets TTS read straight off the same buffer that history replays
from. The Traditional Chinese caption is a per-render translation, cached by
source text, never stored as memory.

---

## Layout

```
├── desktop/            Electron host — brain + local surfaces + LAN server
│   ├── src/shared/     protocol contract (the source of truth)
│   ├── src/server/     transport-agnostic: brain, methods, event bus
│   ├── src/main/       Electron-only: host adapter, IPC shim, windows, tray
│   ├── src/renderer/   avatar · chat · settings surfaces
│   ├── persona.md      the shipped persona
│   └── assets/         VRM models + animations (see assets/README.md)
└── mobile/android/     Kotlin client — sensors + WebView avatar
```

Read [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the architecture in depth,
[`desktop/README.md`](./desktop/README.md) for the desktop app, and
[`mobile/android/README.md`](./mobile/android/README.md) for the Android client.

The workspace root deliberately has no `package.json` — the two subprojects
share zero npm dependencies, so there is no monorepo tool. They coordinate
through the LAN protocol contract, not through shared code.

## Running it

```bash
cd desktop
npm install
npm run dev
```

Requires Windows 10/11, Node 22+, and an Anthropic API key entered in Settings
(optionally a Gemini key for TTS, translation, embeddings and compaction). **No
key is bundled with this repository** — keys are encrypted through the OS
credential store (DPAPI on Windows) and never touch the database, the
preferences file, or any client.

Avatar assets are mostly not redistributable and are not included; see
[`desktop/assets/README.md`](./desktop/assets/README.md) for what to supply.

---

## How this was built

I designed, specified, directed and QA'd this system; the implementation was
produced through AI-driven development under my direction. The architecture
decisions above — the brain/surface split, the host-adapter boundary, storing
normalized embeddings to collapse cosine into a dot product, demoting rather
than deleting on compaction, enforcing agent bounds in the database — are mine,
and so is every review that sent an implementation back for not meeting them.

I work this way deliberately and would rather say so plainly than let a reader
guess.

## Status

Actively developed, and in daily use on my own machine.

The desktop app is feature-complete through its planned phases: avatar shell,
streaming chat, screenshot and touch input, persistence and persona, the agent
loop with safety bounds, cross-source memory, semantic recall and compaction,
agent tools behind a permission layer, computer use, and ComfyUI image
generation.

The Android client ships QR pairing, the WebView avatar with live outfit
swapping, camera capture, speech-to-text, MediaProjection screen capture,
foreground-app intel, notification channels, a quick-settings tile and a
home-screen widget.

## License

All rights reserved — see [`LICENSE`](./LICENSE). This repository is published
as a portfolio work sample: readable and reviewable, not licensed for reuse.
Avatar assets carry their own separate terms.

---

**I-Shun Lo** · [ishunlo.studio](https://ishunlo.studio) · ishunl@outlook.com
