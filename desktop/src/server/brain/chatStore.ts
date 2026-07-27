import { randomUUID } from 'node:crypto';

import type { AttachedImage, ChatMessage } from '@shared/protocol';

import { getDatabase } from './database';

// Chat persistence (Phase 4).

export interface SessionRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// Phase-10 — pinned genesis. The first six messages of a session,
// stored verbatim (not summarised) on the session row once that
// threshold is reached. Raw text is intentional: a Flash summary of the
// first meeting loses the emotional texture that makes "覚えてる？最初
// に言ったこと" actually work. Six = 3 user/assistant pairs, enough to
// capture a real opening exchange without bloating the preamble.
export interface SessionGenesisTurn {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

const GENESIS_MESSAGE_COUNT = 6;

interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  images_json: string | null;
  created_at: number;
}

export function listSessions(): SessionRow[] {
  const db = getDatabase();
  const rows = db
    .prepare<[], { id: string; title: string; created_at: number; updated_at: number }>(
      `SELECT id, title, created_at, updated_at
         FROM sessions
        ORDER BY updated_at DESC`,
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getSession(id: string): SessionRow | null {
  const db = getDatabase();
  const row = db
    .prepare<[string], { id: string; title: string; created_at: number; updated_at: number }>(
      `SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultTitle(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function createSession(title?: string): SessionRow {
  const db = getDatabase();
  const id = randomUUID();
  const now = Date.now();
  const finalTitle = (title?.trim() || defaultTitle(now)).slice(0, 120);
  db.prepare(
    `INSERT INTO sessions (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, finalTitle, now, now);
  return { id, title: finalTitle, createdAt: now, updatedAt: now };
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function deleteAllSessions(): void {
  const db = getDatabase();
  db.prepare(`DELETE FROM sessions`).run();
}

export function loadMessages(sessionId: string): ChatMessage[] {
  const db = getDatabase();
  const rows = db
    .prepare<[string], MessageRow>(
      `SELECT role, content, images_json, created_at
         FROM messages
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId);
  return rows.map((r) => {
    const msg: ChatMessage = {
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    };
    if (r.images_json) {
      try {
        const parsed = JSON.parse(r.images_json) as AttachedImage[];
        if (Array.isArray(parsed) && parsed.length > 0) msg.images = parsed;
      } catch {
        // Corrupt JSON — drop images rather than crash the chat hydrate.
      }
    }
    return msg;
  });
}

/**
 * Persist a chat message and return the new row id. The id lets the
 * Phase 6.5 recall path (`recall.ts`) tie a stored embedding back to
 * the source message without a second lookup, and lets the compaction
 * path (`compaction.ts`) track which messages have been folded into
 * the rolling summary.
 */
export function appendMessage(
  sessionId: string,
  message: ChatMessage,
): number {
  const db = getDatabase();
  const imagesJson = message.images && message.images.length > 0
    ? JSON.stringify(message.images)
    : null;
  let insertedId = 0;
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO messages (session_id, role, content, images_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, message.role, message.content, imagesJson, message.createdAt);
    insertedId = Number(result.lastInsertRowid);
    // Phase-10 — slide `created_at` down to the message's timestamp via
    // MIN() so the session row reflects the *first message* time, not the
    // "New session" click time. Idempotent — once any message has landed,
    // MIN keeps `created_at` pinned to the oldest one; on a brand-new
    // empty session it stays at the original `now` from createSession.
    // The Settings dropdown reads this column for its 「初対話 · …」 label.
    db.prepare(
      `UPDATE sessions
          SET updated_at = ?,
              created_at = MIN(created_at, ?)
        WHERE id = ?`,
    ).run(message.createdAt, message.createdAt, sessionId);

    // Phase-10 — capture pinned genesis on the 6th message of the
    // session (= 3 user/assistant pairs). Single shot: once
    // `genesis_json` is non-NULL it never gets rewritten, so a long
    // session's opening exchange stays frozen the way it actually
    // happened. The migration backfill (`database.backfillGenesisJson`)
    // handles pre-existing sessions; this branch handles every session
    // that crosses the threshold going forward.
    const stats = db
      .prepare<[string, string], { count: number; has_genesis: number }>(
        `SELECT (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS count,
                (SELECT genesis_json IS NOT NULL FROM sessions WHERE id = ?) AS has_genesis`,
      )
      .get(sessionId, sessionId);
    if (stats && stats.count === GENESIS_MESSAGE_COUNT && !stats.has_genesis) {
      const firstSix = db
        .prepare<[string, number], { role: 'user' | 'assistant'; content: string; created_at: number }>(
          `SELECT role, content, created_at
             FROM messages
            WHERE session_id = ?
            ORDER BY created_at ASC, id ASC
            LIMIT ?`,
        )
        .all(sessionId, GENESIS_MESSAGE_COUNT);
      const payload: SessionGenesisTurn[] = firstSix.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      }));
      db.prepare(`UPDATE sessions SET genesis_json = ? WHERE id = ?`).run(
        JSON.stringify(payload),
        sessionId,
      );
    }
  });
  tx();
  return insertedId;
}

/**
 * Phase-10 — read the pinned genesis (first 6 turns) for a session.
 * Returns null until the session crosses the threshold and the live
 * `appendMessage` path or the migration backfill has populated the
 * column. Used by `replyContext.buildReplyPreamble` to inject the
 * 「出会いの記憶」 block.
 */
export function getSessionGenesis(sessionId: string): SessionGenesisTurn[] | null {
  const db = getDatabase();
  const row = db
    .prepare<[string], { genesis_json: string | null }>(
      `SELECT genesis_json FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  if (!row?.genesis_json) return null;
  try {
    const parsed = JSON.parse(row.genesis_json);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(
        (t): t is SessionGenesisTurn =>
          !!t &&
          (t.role === 'user' || t.role === 'assistant') &&
          typeof t.content === 'string' &&
          typeof t.createdAt === 'number',
      )
      .slice(0, GENESIS_MESSAGE_COUNT);
  } catch {
    return null;
  }
}

export function clearMessages(sessionId: string): void {
  const db = getDatabase();
  db.prepare(`DELETE FROM session_compactions WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
}

export function renameSession(id: string, title: string): void {
  const db = getDatabase();
  const trimmed = title.trim().slice(0, 120);
  if (!trimmed) return;
  db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(
    trimmed,
    Date.now(),
    id,
  );
}
