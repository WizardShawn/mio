# Mio — Development

Mio is a persistent VRM-avatar AI assistant. One **brain** runs 24/7 on the
desktop and owns everything stateful — agent loop, memory, persona, model
orchestration. Every surface is a thin client of that brain, reaching it over
one of two transports that speak the same schema.

```
Desktop host (always-on)
  brain ── agent loop · memory · persona · model orchestration
    │
    ├── Electron IPC ─────── local renderers   (always up)
    └── WebSocket + HTTP ─── any LAN client    (opt-in: MIO_LAN=1)
```

This doc has two sections: **server development** (the brain and its
transports) and **desktop client development** (the Electron app).

---

## 1. Server Development

The server is the canonical brain plus the transports that wrap it. It is the
single source of truth for state; all clients are interchangeable.

### 1.1 Cardinal rule

```
src/server/brain/**  has  ZERO  imports from 'electron'.
```

This is the invariant the whole brain/surface split rests on, and it holds
across every module in `server/brain/`. It verifies in one line (§1.7):

```bash
rg -n "from 'electron'" src/server     # expected: 0 matches
```

When the brain needs a platform capability (paths, secret storage, screenshot,
active-window title, notifications, outbound HTTP), it calls the **host
adapter** — interface in `server/brain/host.ts`, Electron implementation in
`main/hostAdapter.ts`. A headless build would supply a different adapter.
Genuinely Electron-only concerns (windows, tray, dialogs, asset `protocol://`)
live in `main/` and are owned by the IPC shim.

### 1.2 Layout

```
src/
├── shared/protocol.ts      ← canonical method + event schema (THE contract)
├── server/                 ← transport-agnostic
│   ├── index.ts            ← createServer({ host }) → { methods, eventBus }
│   ├── eventBus.ts         ← typed in-process pub/sub
│   ├── methods.ts          ← one async function per protocol verb
│   ├── brain/              ← chatService, agent loop, memory, persona, tools…
│   └── transport/          ← ws.ts · http.ts · auth.ts · mdns.ts
├── main/                   ← Electron-only (adapter, IPC shim, windows, tray…)
├── preload/                ← contextBridge surface, one file per renderer
└── renderer/               ← avatar · chat · settings · permission · menu · imageOverlay
```

### 1.3 The contract — `shared/protocol.ts`

Two maps both transports speak:

- **`ServerMethodMap`** — `{ args, result }` per RPC verb. Each maps to exactly
  one function in `server/methods.ts` (dot-name `chat.send` → `chatSend`).
  Groups: chat, sessions, greeting, agent, permission, comfyui, keys, prefs,
  avatar, perception.
- **`ServerEventMap`** — push signals the brain emits (`chat.stream`,
  `chat.replyChunk`, `avatar.setTalking`, `agent.status`, …).

Because the schema is the only coupling point, a client is whatever can send
`{ method, args }` and read back `{ ok, result }`. The perception verbs are the
clearest case: `perception.activeApp` lets any connected client report the app
it currently has in the foreground, buffered by `server/brain/mobileActiveApp.ts`
as exactly one most-recent sample with a 60-second freshness TTL and nothing on
disk. The agent loop reads that sample next to the desktop foreground-window
probe and hands the model both, so it can judge which surface the operator is
actually on. A sample past its TTL resolves to `null` rather than a stale claim.

### 1.4 Transports

- **Electron IPC** (`main/ipcShim.ts`) — thin `ipcMain.handle` delegators into
  `server.methods.*`, plus a bus subscription fanning events to the right
  `BrowserWindow`. Always up; this is how the local renderers reach the brain.
- **WebSocket + HTTP** (`server/transport/`) — the client-agnostic LAN surface.
  Token-auth WS at `/ws`, asset mirror at `/asset/...`, pairing at `/pair`,
  mDNS announce as `_mio._tcp.local.`.

Both transports subscribe to the same event bus and route into the same
`methods.ts`, so a turn driven from any client is visible on every client and
backed by one database.

**The LAN transport is opt-in.** `main/index.ts` wraps the whole HTTP + WS +
mDNS startup block in `if (process.env.MIO_LAN === '1')`. A stock launch binds
no port and makes no mDNS announcement; `getLanPort()` returns `null` and the
shutdown path no-ops. That default is deliberate. The transport exposes the
same server surface the local renderer drives, so anything that pairs can read
the screen, run tools, and spend API credit — and `/pair` is permissive by
design (any caller that POSTs a `deviceId` gets a token), which is reasonable on
a trusted network and emphatically not on a shared one. Turning it on is
explicit:

```powershell
$env:MIO_LAN = '1'; npm run dev
```

The wire shape, once it is on:

- **Framing** — JSON over `ws://host:port/ws`. The first frame must be `hello`
  with `{ token, deviceId, protocolVersion }`; the server answers `welcome` or
  `authFailed`, after which `call` frames get `callResult` replies and `event`
  frames push bus events. A protocol-version mismatch fails the handshake, and
  a socket that has not authenticated within 5 s is closed.
- **Binary-after-call** — `perception.upload` sends its JSON `call` frame and
  then the encoded image bytes as the next binary frame on the same socket.
  The server keeps one pending-upload slot per client with a 5 s timer, so a
  second call arriving mid-upload fails the pending one instead of letting the
  two halves interleave.
- **Pairing** — POST `{ deviceId }` to `/pair` → `{ token }`. Tokens are 32
  random bytes, one per device id, stored encrypted at rest through
  `HostAdapter.secrets`; re-pairing the same id rotates the secret. Settings can
  render the same payload as a `mio://pair?h=…&p=…&t=…&d=…` QR — it asks main
  for the bound port and refuses when the transport is off.
- **Asset mirroring** — the brain emits internal `cortana-asset://` URLs. The WS
  transport rewrites them per client into `http://<host>/asset/...` using the
  `Host:` header captured at upgrade, so every client gets URLs that resolve
  from where it sits. `/asset/local/*` and `/asset/audio/*` are read-only and
  path-normalized against their roots.
- **Reach** — the HTTP server binds `0.0.0.0`, so any interface with a route to
  the host works, and the mDNS TXT record carries protocol version plus hostname
  so a discovering client can tell two instances apart.

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
`memory.ts`, `recall.ts`, `compaction.ts`, `reflection.ts`) and only ever on the
desktop host. No client persists or syncs anything.

**Storage.** A single SQLite file (`better-sqlite3`). Vectors are stored as
BLOBs in that same file — no native loadable extension — and searched with
in-process cosine. Embeddings are **L2-normalized at write time**, so cosine
reduces to a dot product at query time. At personal-assistant scale (thousands
of turns) this is behaviorally identical to `sqlite-vec`; migrating to
`sqlite-vec` later is a one-table swap.

**Embeddings + auxiliary models.** Embeddings use Gemini
`gemini-embedding-001` (dim 768) via the existing Gemini key — Anthropic has no
embeddings API. Compaction summaries, recall reranking, and the reflection pass
all use `gemini-3.5-flash`; caption translation uses `gemini-3.1-flash-lite`.
All of them degrade gracefully when the Gemini key is absent.

**Schema (SQLite):**

| Table | Purpose |
|---|---|
| `sessions` | chat sessions |
| `messages` | user-facing chat turns (`content`, `images_json`) |
| `messages_fts` | contentless FTS5 mirror of `messages`, trigger-synced, for BM25 |
| `memory_entries` | agent-cycle observations (`summary`, `notable`, `reason`, `tags`, `importance`) |
| `agent_counters` | daily counters for safety caps (cycles, tokens, cache tokens, notifs, images) |
| `agent_pathway_counters` | per-(day, pathway) attribution behind the cost meter |
| `message_vectors` | semantic-recall index over chat turns (`embedding` BLOB, `dim`, `model`) |
| `session_compactions` | rolling Japanese summary for turns aged out of replay |
| `session_reflections` | log of reflection passes, so the next one only fires on enough new material |
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

**Recall pattern.** A chat turn whose text clears a 12-character floor runs the
full retrieval pipeline over turns older than the replay window; the agent cycle
reads memory entries directly through `queryMemory`, ranked by
`importance · exp(-age_days / τ)` so milestones outlive routine chatter.

1. **Embed once** — one `gemini-embedding-001` call per turn (~200–500 ms cold,
   cached on repeats).
2. **Two rankings** — cosine over the stored vectors, and BM25 over the
   `messages_fts` mirror. Lexical retrieval earns its place because cosine
   reliably misses rare proper nouns — names of people, places, pets — which
   are exactly the tokens that carry the relationship.
3. **Fuse, then diversify** — reciprocal rank fusion (`1 / (60 + rank)`) merges
   the two orderings, and a Maximal Marginal Relevance pass (λ = 0.7)
   over-selects a pool so near-duplicates don't consume every slot.
4. **Rerank** — `gemini-3.5-flash` narrows the MMR pool to the final K
   (default 6). If the rerank call fails, the MMR top-K stands.

A cosine floor of 0.70 — 0.78 for queries under 20 characters, which embed less
informatively — keeps distant turns out entirely. Those thresholds were
calibrated with `scripts/audit-recall.js` against the same model and the same
768-dim truncation the app runs on.

The reply preamble assembles the results as labelled Japanese blocks: pinned
session genesis, the rolling compaction summary, recent turns, notable
observations held in their own slot, and the top-K recalled past turns. Replay
window is capped at 35 exchanges; the DB keeps the full transcript.

**Compaction.** When recall context exceeds a threshold, older observations are
summarized into compact entries and the originals **demoted** — kept in the DB,
dropped from recall. Compaction runs fully detached from the chat path. This is
the bounded-context discipline any long-running autonomous agent needs: the
transcript grows without limit, the recall budget does not, and nothing is
thrown away to keep the two reconciled.

### 1.7 Verify

```bash
npm run typecheck
rg -n "from 'electron'" src/server              # expect 0 matches
```

The WS path needs the opt-in transport running, so start the app with
`MIO_LAN=1` first — otherwise there is no port to pair against:

```bash
node scripts/ws-smoke.mjs --text "テスト"       # pairs, opens WS, drives a turn
```

The script discovers the host over mDNS (or takes `--host`/`--port`), POSTs
`/pair`, sends `auth.hello`, then drives one `chat.send` and prints every event
frame it receives. While it runs, the desktop chat pill mirrors the same reply —
that is the shared-brain property.

---

## 2. Desktop Client Development

The desktop client is the Electron app: the always-on host process plus the
local renderer surfaces. It also packages the shared assets (VRM model,
animations, persona) that every client reuses by reference.

### 2.1 Requirements

- Windows 10/11, Node.js 22+
- An Anthropic API key (`sk-ant-…`); optionally a Gemini key for TTS,
  translation, embeddings, and compaction, and a Comfy Cloud key for the
  billed ComfyUI partner nodes.

Keys are supplied by whoever runs the app. Nothing is bundled and nothing is
read out of the repository: a key is either pasted into Settings — encrypted
through `HostAdapter.secrets` (DPAPI on Windows) into a `.enc` blob under
`userData` — or picked up from `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` /
`COMFY_CLOUD_API_KEY`. None ever reaches the SQLite file,
`user-preferences.json`, or a connected client. Without the Gemini key the
Gemini-backed paths degrade instead of failing.

### 2.2 Dev loop

```powershell
npm install
npm run dev        # Electron + Vite dev server with HMR
```

Other scripts: `npm run build` / `start` (production build), `typecheck`,
`rebuild` (electron-rebuild for `better-sqlite3`), `dist` (NSIS installer),
`package` (unpacked).

### 2.3 Renderer surfaces

The Electron main process hosts several `BrowserWindow` renderers, each driven
through the IPC shim:

- **Avatar** — transparent, frameless, always-on-top. `@pixiv/three-vrm` +
  `@pixiv/three-vrm-animation` render the `.vrm` with random looping idle /
  talking animations. Includes a bone-projection gesture detector — cursor
  activity classified against a per-frame projection of the rig's bones and
  spring-bone chains into eight verbs (`caress` · `poke` · `pat` · `tickle` ·
  `stroke` · `grab` · `tug` · `pinch`) — whose events batch into synthetic user
  turns. Hit zones are stored in metres and reprojected to pixel radii each
  frame, so depth and zoom changes scale them correctly.
- **Chat** — streaming chat UI summoned by a global hotkey; supports
  paste-to-attach image chips.
- **Settings, permission prompt, image overlay, tray menu** — supporting
  surfaces.

Every user turn auto-attaches a fresh screenshot (transient — not stored).
Pasted images persist in chat history.

### 2.4 Assets

The app loads from the first directory containing a `.vrm`:
`%APPDATA%/cortana-desktop-assistant/assets/`, then the repo root's `assets/`
(the packaged build reads it out of `resourcesPath`). Expected shape:

```
assets/
├── vrm/                    # every .vrm here becomes one wardrobe outfit
├── animations/
│   ├── idle/               # picked at random, looped
│   ├── talking/            # picked at random while streaming
│   └── extras/             # staging area, not loaded
└── workflows/              # ComfyUI workflow graphs (optional)
```

Nothing there is hard-coded: `assets.ts` scans `vrm/` at boot and derives the
outfit id from each filename, so dropping in another `.vrm` makes it reachable
by the `change_clothes` tool on the next launch with no code change.

VRM/VRMA files stream into the renderer over the `cortana-asset://` custom
protocol (mirrored at `http://host:port/asset/...` when the LAN transport is
enabled), sandboxed to the assets root. The persona lives in `persona.md` at the
repo root. See `assets/README.md` for what ships and what you supply.

### 2.5 Status

Phases 1–12 shipped: avatar shell, chat loop, screenshot/touch input,
persistence + persona, agent loop with safety bounds, cross-source memory,
semantic recall + compaction, polish, agent tools/permissions/computer-use,
ComfyUI image generation, the hybrid-retrieval memory overhaul (BM25 + cosine
fusion, MMR, Flash rerank, reflection passes, importance-weighted aging), and
per-pathway cost metering with model routing — the observation cycle runs on
`claude-haiku-4-5` while chat and computer-use run on `claude-opus-4-7`, each
behind a two-layer prompt cache.
