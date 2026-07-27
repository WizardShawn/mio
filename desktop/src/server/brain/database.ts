import path from 'node:path';
import Database from 'better-sqlite3';

import { getHost } from './host';

// One shared SQLite handle for chat history (Phase 4) and memory entries
// (Phase 5). Single-file DB lives in userData so it survives reinstalls
// of the app shell without leaving stray data on the user's system.
//
// We open lazily so unit-style imports don't crash before the
// `HostAdapter` has been installed (which happens at app `ready`).

const DB_FILE = 'cortana.sqlite';

let cached: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (cached) return cached;
  const file = path.join(getHost().paths.userData, DB_FILE);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  cached = db;
  return db;
}

/**
 * SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (until 3.50,
 * which we cannot depend on across better-sqlite3 builds). We probe
 * the table_info pragma and only add the column when it's missing —
 * idempotent and cheap (a single PRAGMA + at most one DDL on first
 * migration after upgrade).
 */
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const rows = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content     TEXT NOT NULL,
      images_json TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_created
      ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      summary     TEXT NOT NULL,
      notable     INTEGER NOT NULL DEFAULT 0,
      reason      TEXT,
      message     TEXT,
      tags        TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_created
      ON memory_entries(created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_counters (
      day        TEXT PRIMARY KEY,
      cycles     INTEGER NOT NULL DEFAULT 0,
      in_tokens  INTEGER NOT NULL DEFAULT 0,
      out_tokens INTEGER NOT NULL DEFAULT 0,
      notifs     INTEGER NOT NULL DEFAULT 0,
      images     INTEGER NOT NULL DEFAULT 0
    );

    -- Phase-1 cost-meter: per-(day, pathway) usage breakdown so the
    -- HUD/settings can show which surface is burning the daily cap
    -- (chat typing vs cycle vs notable check-in vs welcome-back vs
    -- gesture vs computer-use). The roll-up in agent_counters is
    -- still the single source of truth for the cap check; this table
    -- only adds attribution.
    CREATE TABLE IF NOT EXISTS agent_pathway_counters (
      day                  TEXT NOT NULL,
      pathway              TEXT NOT NULL,
      calls                INTEGER NOT NULL DEFAULT 0,
      in_tokens            INTEGER NOT NULL DEFAULT 0,
      out_tokens           INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, pathway)
    );

    CREATE TABLE IF NOT EXISTS generated_images (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      prompt       TEXT NOT NULL,
      intent       TEXT,
      aspect_ratio TEXT,
      file_path    TEXT NOT NULL,
      source_kind  TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_generated_images_created
      ON generated_images(created_at DESC);

    CREATE TABLE IF NOT EXISTS message_vectors (
      message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      embedding   BLOB NOT NULL,
      dim         INTEGER NOT NULL,
      model       TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_vectors_session_created
      ON message_vectors(session_id, created_at);

    CREATE TABLE IF NOT EXISTS session_compactions (
      session_id          TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      summary             TEXT NOT NULL,
      covered_through_id  INTEGER NOT NULL,
      message_count       INTEGER NOT NULL DEFAULT 0,
      updated_at          INTEGER NOT NULL
    );

    -- Phase-11 M6 — reflection-pass log. The agent-loop periodically
    -- generates synthesised higher-order observations from the most
    -- recent ~50 messages (patterns, themes, emotional arcs no single
    -- turn would reveal) and stores them as memory_entries with
    -- notable=true and tags=[reflection]. This table records each
    -- reflection pass so we know how much new content has accumulated
    -- since the last one — the next pass only fires after enough new
    -- material has arrived to make synthesis worthwhile.
    CREATE TABLE IF NOT EXISTS session_reflections (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      covered_through_id INTEGER NOT NULL,
      observation_count  INTEGER NOT NULL,
      created_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_reflections_session_created
      ON session_reflections(session_id, created_at DESC);

    -- Phase-11 M3 — FTS5 virtual table for lexical retrieval. Cosine
    -- recall (recall.ts) misses rare proper nouns: names of people,
    -- places, pets, idiosyncratic terms — exactly the things that
    -- define the relationship. BM25 matches those reliably.
    -- The contentless-mirror form (content='', content_rowid) keeps
    -- the FTS index in a separate b-tree; we sync it explicitly via
    -- triggers below so ranking only sees real message content (no
    -- images_json, no system-prefix synthetic rows that the cycle
    -- injects with role=user).
    -- tokenize=unicode61 does Unicode case-folding and treats
    -- punctuation as separators; works for Japanese well enough
    -- because CJK code points stay distinct tokens (each kanji is its
    -- own token, which is actually useful for BM25 over short
    -- queries).
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='',
      tokenize='unicode61'
    );

    -- Phase-11 M3 — keep FTS5 in sync with messages. INSERT and DELETE
    -- triggers mirror writes; UPDATE not needed because chat-store
    -- never mutates message rows after insertion (it deletes + reinserts
    -- via clearMessages instead).
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai
      AFTER INSERT ON messages
      BEGIN
        INSERT INTO messages_fts (rowid, content)
        VALUES (new.id, new.content);
      END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad
      AFTER DELETE ON messages
      BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
  `);

  ensureColumn(db, 'agent_counters', 'images', 'INTEGER NOT NULL DEFAULT 0');
  // Phase-1 cost-meter — cached input tokens are billed separately by
  // Anthropic (writes at 1.25×, reads at 0.10× the standard input
  // rate) but they never appear in `usage.input_tokens`. Tracking
  // them explicitly is what lets `estimateCostUsd` reflect the real
  // bill instead of the stripped-down "fresh input only" number that
  // shipped pre-Phase-1.
  ensureColumn(db, 'agent_counters', 'cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'agent_counters', 'cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0');

  // Phase-10 — pinned session genesis. Stores the first ~6 messages of
  // each session as a JSON array of `{role, content, createdAt}` once the
  // session crosses the 6-message threshold. The preamble injects this as
  // a 「出会いの記憶」 block on every relevant turn, so the model can
  // always reach back to how the relationship started even after the
  // rolling summary has compressed the original exchange beyond
  // recognition. NULL until populated; the live path writes it on the
  // 6th `appendMessage`, the backfill below catches pre-existing rows.
  ensureColumn(db, 'sessions', 'genesis_json', 'TEXT');

  // Phase-10 — sliding-window compaction. The old append-only model
  // kept folding new pending messages into a 1,200-char summary forever,
  // so the deep past inexorably compressed toward zero detail. The
  // new model re-summarizes the 140 messages immediately past the
  // 70-message hard window from scratch each time the window has
  // shifted enough; messages older than 70+140=210 fall out of the
  // summary entirely and live only in vector recall.
  //
  // We need `covered_from_id` (the oldest message id the current
  // summary represents) to detect that shift. Pre-existing rows
  // populated by the old path get `covered_from_id = 0` and look
  // "fully shifted" on first read, so the very next compaction pass
  // overwrites them with a fresh sliding-window summary.
  ensureColumn(db, 'session_compactions', 'covered_from_id', 'INTEGER NOT NULL DEFAULT 0');

  // Phase-11 M8 — importance scoring (0-10). Set at write time by the
  // cycle (`write_memory({importance: …})`) or by `reflection.ts`
  // (which writes 7 by default — notable + considered insight). The
  // preamble's 「大切な瞬間」 ranking combines importance with
  // exp(-age/τ) age decay so emotionally weighty memories outlast
  // routine ones even if both share `notable=true`. Default of 5 (the
  // midpoint) means legacy rows without an explicit value participate
  // neutrally rather than being demoted.
  ensureColumn(db, 'memory_entries', 'importance', 'INTEGER NOT NULL DEFAULT 5');

  // Phase-10 — backfill `sessions.created_at` to match each session's
  // first persisted message. Originally the column held the "New session
  // click" time, which made the Settings dropdown's per-row stamp look
  // like every session had started today even when it held weeks of
  // history. The live write path (appendMessage) now pins this column via
  // MIN(created_at, message.created_at); this one-shot UPDATE corrects
  // every pre-existing row. Idempotent — sessions that already match
  // their MIN(messages.created_at) get a no-op write.
  db.exec(`
    UPDATE sessions
       SET created_at = COALESCE(
         (SELECT MIN(created_at) FROM messages WHERE messages.session_id = sessions.id),
         created_at
       );
  `);

  // Phase-10 — backfill `genesis_json` for pre-existing sessions. Pulls
  // the first 6 messages (oldest first) of every session that already
  // crosses the threshold and stuffs them into the column as a JSON
  // array. Idempotent — sessions that already have a populated
  // `genesis_json` are left alone, so re-running migrate() never
  // clobbers an evolving genesis. Live writes (chatStore.appendMessage)
  // handle new sessions going forward.
  backfillGenesisJson(db);

  // Phase-11 M3 — backfill the FTS5 index for messages that pre-date
  // the trigger. Detect "needs backfill" via a row-count gap between
  // `messages` and `messages_fts`. INSERT OR IGNORE so re-running the
  // migration after a successful backfill is a no-op.
  backfillMessagesFts(db);
}

interface GenesisMessageRow {
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

const GENESIS_MESSAGE_COUNT = 6;

function backfillMessagesFts(db: Database.Database): void {
  const counts = db
    .prepare<[], { messages: number; fts: number }>(
      `SELECT
         (SELECT COUNT(*) FROM messages) AS messages,
         (SELECT COUNT(*) FROM messages_fts) AS fts`,
    )
    .get();
  if (!counts) return;
  if (counts.messages === counts.fts) return;

  // Either fresh-install (both zero, no-op) or upgrade with messages
  // pre-dating the FTS triggers. Rebuild from messages with INSERT OR
  // IGNORE to skip rows already present (e.g. partial backfill on a
  // crashed previous boot).
  db.exec(`
    INSERT OR IGNORE INTO messages_fts (rowid, content)
      SELECT id, content FROM messages;
  `);
}

function backfillGenesisJson(db: Database.Database): void {
  const stale = db
    .prepare<[number], { id: string }>(
      `SELECT s.id AS id
         FROM sessions s
        WHERE s.genesis_json IS NULL
          AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) >= ?`,
    )
    .all(GENESIS_MESSAGE_COUNT);

  if (stale.length === 0) return;

  const selectFirstSix = db.prepare<[string, number], GenesisMessageRow>(
    `SELECT role, content, created_at
       FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
  );
  const updateGenesis = db.prepare(
    `UPDATE sessions SET genesis_json = ? WHERE id = ?`,
  );

  const tx = db.transaction(() => {
    for (const row of stale) {
      const msgs = selectFirstSix.all(row.id, GENESIS_MESSAGE_COUNT);
      if (msgs.length < GENESIS_MESSAGE_COUNT) continue;
      const payload = msgs.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      }));
      updateGenesis.run(JSON.stringify(payload), row.id);
    }
  });
  tx();
}
