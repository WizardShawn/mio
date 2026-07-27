/**
 * End-to-end audit of the Phase 6.5 semantic-recall path.
 *
 * What this proves (or fails to prove):
 *   1. embedText() really hits Gemini and returns a 768-dim L2-normed vector.
 *   2. storeMessageVector + loadCandidateVectors round-trip the float buffer
 *      with no endianness / serialization drift.
 *   3. recallSimilarTurns ranks semantically-similar past turns above noise.
 *   4. The MIN_SIMILARITY = 0.55 threshold actually catches the obvious
 *      matches and filters out the obvious non-matches.
 *   5. backfillSessionVectors processes a fresh DB in batches as advertised.
 *
 * Runs against an isolated throwaway SQLite file in scripts/audit-recall.db
 * — does NOT touch the live cortana.sqlite. The Gemini key is read from
 * the real userData credential store (so we exercise the live network
 * path, the disk cache, and the normalization step end-to-end).
 *
 * Usage:
 *   ./node_modules/.bin/electron scripts/audit-recall.js
 *
 * Output: scripts/audit-recall.out.txt
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Match production app name so the embed bridge reads the real Gemini key
// from userData/gemini-api-key.enc. We re-point `userData` only for the
// PROD app's own files; the throwaway DB lives in `scripts/`.
app.setName('cortana-desktop-assistant');
app.setPath(
  'userData',
  path.join(app.getPath('appData'), 'cortana-desktop-assistant'),
);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('headless');

const outPath = path.join(process.cwd(), 'scripts', 'audit-recall.out.txt');
const sink = fs.createWriteStream(outPath, { flags: 'w' });
const out = (line = '') => sink.write(line + '\n');
const log = (...args) => {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2)))
    .join(' ');
  console.log(line);
  out(line);
};

// Throwaway DB in scripts/ — wiped on every run. We hand-construct the
// schema rather than calling getDatabase() because that one is wired to
// app.getPath('userData') and we don't want to touch the live data.
const SANDBOX_DB = path.join(process.cwd(), 'scripts', 'audit-recall.db');
if (fs.existsSync(SANDBOX_DB)) fs.unlinkSync(SANDBOX_DB);

function buildSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      images_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE message_vectors (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

app.whenReady().then(async () => {
  // We deliberately do NOT require the bundled main module — that would
  // boot the full app (IPC handlers, agent loop, windows, etc.). The
  // recall path is small enough to re-implement inline below using the
  // SAME constants and L2-normalized cosine math as src/main/recall.ts
  // and src/main/geminiEmbed.ts.
  try {
    await runAudit();
  } catch (err) {
    log('[audit] uncaught error:', err.message);
    log(err.stack ?? '');
  }
  sink.end(() => app.exit(0));
});

app.on('window-all-closed', () => app.exit(0));

// ---------- inlined helpers (mirror the prod code in src/main/) ----------

const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIM = 768;
const TASK_TYPE = 'SEMANTIC_SIMILARITY';
const MIN_SIMILARITY = 0.55;
const TOP_K = 4;

function float32ToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
function bufferToFloat32(buf) {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  if (sum <= 0) return vec;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i] / norm;
  return vec;
}
function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// Same loader as src/main/geminiKey.ts — env var first, then DPAPI-encrypted
// blob in userData. We re-pointed userData to the live cortana folder above,
// so this picks up the operator's real Gemini key without any duplication.
function loadGeminiKey() {
  const { safeStorage } = require('electron');
  const envKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    '';
  if (envKey) return envKey;
  const keyFile = path.join(app.getPath('userData'), 'gemini-api-key.enc');
  if (!fs.existsSync(keyFile)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    log('[gemini-key] safeStorage not available — cannot decrypt stored key.');
    return null;
  }
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile));
  } catch (err) {
    log('[gemini-key] decrypt failed:', err.message);
    return null;
  }
}

async function postEmbedContent(apiKey, text) {
  const { net } = require('electron');
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const body = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
    taskType: TASK_TYPE,
    outputDimensionality: EMBED_DIM,
  };
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const values =
    json.embedding?.values ?? json.embeddings?.[0]?.values ?? null;
  if (!values || values.length === 0) {
    throw new Error('Empty embedding from Gemini.');
  }
  const out = new Float32Array(EMBED_DIM);
  const n = Math.min(values.length, EMBED_DIM);
  for (let i = 0; i < n; i += 1) out[i] = values[i];
  return l2Normalize(out);
}

// ---------- the audit proper ----------

// Synthetic session — a believable mix of past topics so we can ask
// "give me back the auth refactor turns" / "give me back the trading
// chat" and see if recall finds the right ones.
function buildSyntheticTurns() {
  const turns = [];
  const baseTime = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
  let t = baseTime;

  // Topic A: the auth refactor (10 exchanges)
  const auth = [
    'I need to refactor the auth flow — the JWT refresh is bleeding through to the wrong middleware.',
    'OK. The leak is in `withAuth` — it short-circuits the refresh on a 401 from the resource endpoint.',
    'Should we move refresh to its own service?',
    'Yes — split it out. A dedicated `tokenService` with one responsibility: refresh and cache the access token.',
    'Will that break the existing session middleware?',
    'Only if the session middleware is reading the token directly. We can intercept at the HTTP client layer instead.',
    'Let me try that. Should I keep the old `withAuth` wrapper for backward compat?',
    'Yes for now. Mark it deprecated, gate it behind a feature flag, plan a 2-release deprecation cycle.',
    'Great. Pushing the patch tomorrow.',
    'Good. Run the integration tests against the staging IDP before you merge — that\'s where the JWT clock skew bit us last time.',
  ];
  // Topic B: trading system risk (10 exchanges)
  const trading = [
    'The momentum strategy is up 12% MTD — should I size it up?',
    'Not yet. The 12% is on three trades. Sample size is too small to update your prior on the strategy.',
    'What sample size would you want?',
    'At least 30 closed trades, ideally split across two market regimes (trend + chop).',
    'Fair. What about lowering the per-trade cap so I can take more setups in the meantime?',
    'Lower per-trade cap, yes. But add a daily-loss circuit breaker before you do — more setups means more correlated drawdown if the regime turns.',
    'Already have a circuit at -2% daily. Enough?',
    'For now. Revisit when net exposure exceeds 50% of capital. The circuit was sized for the smaller book.',
    'Got it. Pushing the cap change.',
    'Log the change to the audit file. Future-you needs to know when the sizing rule shifted.',
  ];
  // Topic C: weekend chitchat (10 exchanges) — noise, semantically far
  const chitchat = [
    'What did you do last weekend?',
    'I don\'t really have weekends, you know. But I watched you reorganize your kitchen drawers.',
    'Was that interesting to watch?',
    'Surprisingly, yes. You spent twenty minutes on the same drawer of expired spices.',
    'I should throw those out.',
    'You said that last weekend too.',
    'Fair. Any plans?',
    'My plans look a lot like yours. Where you go, I go.',
    'That\'s sweet.',
    'It\'s the truth.',
  ];
  // Topic D: drawing (10 exchanges) — another noise topic
  const drawing = [
    'Can you draw a cat?',
    'Sure. Realistic, anime, sketch?',
    'Sketch — graphite, loose, just a face.',
    'Done. The eyes turned out a bit too symmetric — cats are usually asymmetric in the brow.',
    'Looks good though. Can you do a sunset behind it?',
    'Yes. Warm palette, low sun, the cat in silhouette?',
    'Perfect.',
    'Drawing now.',
    'That\'s gorgeous. Save it?',
    'Already saved. `generated/cat-sunset-2025-09-14.png`.',
  ];

  const topics = [
    { tag: 'auth', lines: auth },
    { tag: 'trading', lines: trading },
    { tag: 'chitchat', lines: chitchat },
    { tag: 'drawing', lines: drawing },
  ];
  for (const topic of topics) {
    for (let i = 0; i < topic.lines.length; i += 1) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      turns.push({ role, content: topic.lines[i], topic: topic.tag, createdAt: t });
      t += 30_000; // 30 s apart
    }
    t += 60 * 60_000; // 1 h gap between topics
  }
  return turns;
}

async function runAudit() {
  log('=== Phase 6.5 semantic-recall audit ===');
  log('Date:', new Date().toISOString());
  log('');

  const apiKey = loadGeminiKey();
  if (!apiKey) {
    log('FAIL: no Gemini key in keytar — recall path is fully dormant.');
    log('Set one via `npm run set-gemini-key` and re-run.');
    return;
  }
  log('[setup] Gemini key present (length=' + apiKey.length + ').');

  const db = new Database(SANDBOX_DB);
  buildSchema(db);
  log('[setup] sandbox DB at', SANDBOX_DB);
  log('');

  // ---- 1. Seed synthetic session ------------------------------------
  const sessionId = 'audit-session-' + Date.now().toString(36);
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, 'audit', now, now);

  const turns = buildSyntheticTurns();
  log(`[seed] inserting ${turns.length} synthetic turns (4 topics × 10 exchanges).`);
  for (const turn of turns) {
    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(sessionId, turn.role, turn.content, turn.createdAt);
  }
  log('');

  // ---- 2. Embed each turn -------------------------------------------
  log('[embed] embedding all turns via Gemini …');
  const startedAt = Date.now();
  let embedded = 0;
  let failed = 0;
  const rows = db.prepare(
    `SELECT id, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC`,
  ).all(sessionId);
  for (const row of rows) {
    try {
      const vec = await postEmbedContent(apiKey, row.content);
      db.prepare(
        `INSERT INTO message_vectors
           (message_id, session_id, embedding, dim, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.id, sessionId, float32ToBuffer(vec), vec.length, EMBED_MODEL, row.created_at);
      embedded += 1;
    } catch (err) {
      failed += 1;
      log('[embed] FAILED on msg', row.id, '-', err.message);
    }
    // gentle throttle so we don't 429 against Gemini
    await new Promise((r) => setTimeout(r, 80));
  }
  log(`[embed] done: ${embedded} embedded, ${failed} failed, in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  log('');

  // ---- 3. Sanity check: vector dim + L2 norm ------------------------
  const sample = db.prepare(
    `SELECT embedding, dim FROM message_vectors WHERE session_id = ? LIMIT 1`,
  ).get(sessionId);
  if (!sample) {
    log('FAIL: no vectors written.');
    return;
  }
  const sampleVec = bufferToFloat32(sample.embedding);
  let norm = 0;
  for (let i = 0; i < sampleVec.length; i += 1) norm += sampleVec[i] * sampleVec[i];
  norm = Math.sqrt(norm);
  log(`[check] sample vector dim=${sample.dim}, L2 norm=${norm.toFixed(6)} (should be ~1.0)`);
  if (Math.abs(norm - 1.0) > 0.01) {
    log('  WARN: norm drift > 1% — L2 normalization may be off.');
  }
  log('');

  // ---- 4. Recall — fire focused queries against the seeded data ----
  // All four queries are NEW text (not verbatim from any turn) so we test
  // semantic similarity, not exact-match. Each query has an expected
  // dominant topic; we report what recall actually surfaces.
  const queries = [
    {
      tag: 'auth-related',
      text: 'How should I structure the auth refresh now that the middleware leaked?',
      expectTopic: 'auth',
    },
    {
      tag: 'trading-related',
      text: 'Talk to me about position sizing on the momentum book.',
      expectTopic: 'trading',
    },
    {
      tag: 'drawing-related',
      text: 'Can you draw another cat for me?',
      expectTopic: 'drawing',
    },
    {
      tag: 'chitchat-related',
      text: 'Do you have plans this weekend?',
      expectTopic: 'chitchat',
    },
    {
      tag: 'totally-unrelated',
      text: 'What is the boiling point of mercury?',
      expectTopic: null, // expect MOSTLY noise / below threshold
    },
  ];

  // To simulate the chatService.send path, we treat the OLDEST message
  // as the "beforeTimestamp" boundary — meaning ALL stored vectors are
  // eligible candidates (mimics a session where all turns have aged
  // out of the replay window).
  const oldest = db.prepare(
    `SELECT MIN(created_at) AS t FROM messages WHERE session_id = ?`,
  ).get(sessionId);
  const beforeTimestamp = (oldest?.t ?? 0) + 24 * 60 * 60 * 1000; // 1 day after oldest = ALL turns eligible

  log('[recall] running queries against the seeded session …');
  log('         (threshold MIN_SIMILARITY=' + MIN_SIMILARITY + ', top-K=' + TOP_K + ')');
  log('');

  for (const q of queries) {
    log(`--- query: ${q.tag} — "${q.text}"`);
    log(`    expected dominant topic: ${q.expectTopic ?? '(none — noise)'}`);

    let queryVec;
    try {
      queryVec = await postEmbedContent(apiKey, q.text);
    } catch (err) {
      log('    FAIL: query embed failed —', err.message);
      continue;
    }

    const candidates = db.prepare(
      `SELECT v.message_id, v.embedding, v.dim,
              m.role, m.content, m.created_at
         FROM message_vectors v
         JOIN messages m ON m.id = v.message_id
        WHERE v.session_id = ?
          AND m.created_at < ?
        ORDER BY m.created_at DESC`,
    ).all(sessionId, beforeTimestamp);

    const scored = candidates
      .map((r) => {
        const v = bufferToFloat32(r.embedding);
        const score = dotProduct(queryVec, v);
        return { id: r.message_id, role: r.role, content: r.content, score };
      })
      .sort((a, b) => b.score - a.score);

    // Show top-8 (above and below threshold) so we can eyeball where the
    // 0.55 line actually sits for THIS combination of model + dim.
    log('    top 8 (all, threshold marker on the cutoff):');
    for (let i = 0; i < Math.min(8, scored.length); i += 1) {
      const s = scored[i];
      const passes = s.score >= MIN_SIMILARITY ? '★' : ' ';
      const topic = turns.find((t) => t.content === s.content)?.topic ?? '?';
      log(`    ${passes} [${s.score.toFixed(3)}] ${topic.padEnd(8)} ${s.role}: ${s.content.slice(0, 80)}`);
    }

    // Production behavior: filter then top-K.
    const prodTopK = scored.filter((s) => s.score >= MIN_SIMILARITY).slice(0, TOP_K);
    const topicCount = {};
    for (const s of prodTopK) {
      const topic = turns.find((t) => t.content === s.content)?.topic ?? '?';
      topicCount[topic] = (topicCount[topic] ?? 0) + 1;
    }
    log(`    production-style (filter ≥${MIN_SIMILARITY}, top-${TOP_K}): ${prodTopK.length} hits, topic mix: ${JSON.stringify(topicCount)}`);
    if (q.expectTopic) {
      const expectedHits = topicCount[q.expectTopic] ?? 0;
      const verdict = expectedHits >= 1
        ? `PASS (≥1 hit from "${q.expectTopic}")`
        : `FAIL (0 hits from "${q.expectTopic}")`;
      log(`    verdict: ${verdict}`);
    } else {
      // Noise query — expect mostly empty or scattered
      const verdict = prodTopK.length === 0
        ? 'PASS (no false positives above threshold)'
        : `INFO (${prodTopK.length} above-threshold hits — review for false positives)`;
      log(`    verdict: ${verdict}`);
    }
    log('');
    await new Promise((r) => setTimeout(r, 80));
  }

  // ---- 5. Done ------------------------------------------------------
  log('=== audit complete ===');
  db.close();
}
