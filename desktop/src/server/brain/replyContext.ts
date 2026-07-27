import type { MemoryContextStats } from '@shared/protocol';

import { getSessionGenesis, loadMessages, type SessionGenesisTurn } from './chatStore';
import { getDatabase } from './database';
import {
  findAnniversaryHits,
  getAllMemoryEntries,
  queryMemory,
  queryNotableMemory,
  type MemoryEntry,
} from './memory';
import type { SessionCompaction } from './compaction';
import { formatRecalledTurnJa, type RecalledTurn } from './recall';

// Phase 6 — context-window discipline.

// Phase-6 cost-saver — `[系統メモ]` preamble is uncacheable (time and
// gap text change every turn), and at the pre-tightening defaults it
// could run 3-4 k tokens per chat call once cycle activity built up.
// Halved the observation cap to 4, drop entries the rolling compaction
// already absorbed, and skip the preamble outright when the gap is too
// short for any of the time-sensitive hints to matter.
const RECENT_OBSERVATIONS_K = 4;
// Phase-10 — soft cap on each rendered genesis turn. Six turns × ~200
// chars ≈ 1,200 chars total, ~300-400 tokens. Large enough to preserve
// emotional texture of the opening exchange; small enough that even on
// a heavy-preamble turn the genesis block fits comfortably.
const GENESIS_TURN_CHAR_CAP = 200;
// Phase-10 — separate slot for `notable=true` observations so milestones
// (first meeting, names, promises, anniversaries, emotionally weighted
// moments flagged by the cycle's `write_memory({notable:true})`) stay
// surfaced regardless of how stale they get. Without this split, a busy
// week of routine `write_memory` calls would shove the very memories
// that define the relationship out of the recent-K window.
const NOTABLE_OBSERVATIONS_K = 3;
const OBSERVATION_CHAR_CAP = 320;
const RECENT_IMAGES_K = 4;
const RECENT_IMAGES_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Below this gap, skip the preamble entirely on back-to-back chat
 * turns — the model already has fresh wall-clock context in its
 * (cached) prior turn and nothing about the rolling memory hints is
 * load-bearing across a 90 s window.
 */
const PREAMBLE_SUPPRESS_GAP_MS = 90_000;

interface LastChatTurnInfo {
  createdAt: number;
  role: 'user' | 'assistant' | null;
}

export function getLastTurnInfo(sessionId: string | null): LastChatTurnInfo | null {
  if (!sessionId) return null;
  const db = getDatabase();
  const row = db
    .prepare<[string], { role: 'user' | 'assistant'; created_at: number }>(
      `SELECT role, created_at
         FROM messages
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId);
  if (!row) return null;
  return { createdAt: row.created_at, role: row.role };
}

/**
 * Phase-10 — most recent timestamp of a genuine user action in this
 * session. "Genuine" excludes system-driven user-role rows like the
 * `[系統／起動 — おかえり挨拶]` welcome-back block and the
 * `[系統／背景觀察跟進 — notable]` check-in block, both of which are
 * persisted with `role='user'` for conversational continuity but
 * weren't actually typed or touched by the operator. Gestures count
 * (they're a real physical interaction with the avatar) — the
 * `[gesture:` prefix is treated as activity.
 *
 * Returns `null` if the session has no genuine user turn yet. The
 * agent loop uses this to skip the notable-chat check-in when the
 * operator hasn't engaged in a while (a check-in fired into a closed
 * laptop is pure waste).
 */
export function getLastUserActivityAt(sessionId: string | null): number | null {
  if (!sessionId) return null;
  const db = getDatabase();
  const row = db
    .prepare<[string], { created_at: number }>(
      `SELECT created_at
         FROM messages
        WHERE session_id = ?
          AND role = 'user'
          AND substr(content, 1, 2) != '[系'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId);
  return row ? row.created_at : null;
}

export function formatGapJa(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'たった今';
  if (ms < 90_000) return 'たった今';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}分前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}日前`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}ヶ月前`;
  const year = Math.round(month / 12);
  return `${year}年前`;
}

function formatNow(now: Date): string {
  const localStr = now.toLocaleString('ja-JP', {
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offsetStr = `UTC${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(
    absMin % 60,
  ).padStart(2, '0')}`;
  return `${localStr} (${offsetStr})`;
}

interface RecentImageRow {
  intent: string | null;
  prompt: string;
  createdAt: number;
}

function getRecentGeneratedImages(now: Date): RecentImageRow[] {
  try {
    const db = getDatabase();
    const cutoff = now.getTime() - RECENT_IMAGES_WINDOW_MS;
    const rows = db
      .prepare<
        [number, number],
        { intent: string | null; prompt: string; created_at: number }
      >(
        `SELECT intent, prompt, created_at
           FROM generated_images
          WHERE created_at >= ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(cutoff, RECENT_IMAGES_K);
    return rows.map((r) => ({
      intent: r.intent,
      prompt: r.prompt,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

function formatRecentImage(row: RecentImageRow): string {
  const ts = new Date(row.createdAt).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const caption =
    row.intent && row.intent.trim().length > 0
      ? row.intent.trim()
      : row.prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `・ [${ts}] ${caption}`;
}

function formatGenesisTurn(turn: SessionGenesisTurn): string {
  const ts = new Date(turn.createdAt).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const speaker = turn.role === 'user' ? '彼' : '私';
  let body = turn.content.replace(/\s+/g, ' ').trim();
  if (body.length > GENESIS_TURN_CHAR_CAP) {
    body = `${body.slice(0, GENESIS_TURN_CHAR_CAP - 1)}…`;
  }
  return `[${ts}] ${speaker}: ${body}`;
}

function formatObservation(entry: MemoryEntry): string {
  const ts = new Date(entry.createdAt).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const flag = entry.notable ? '★' : '・';
  let body = entry.summary.replace(/\s+/g, ' ').trim();
  if (body.length > OBSERVATION_CHAR_CAP) {
    body = `${body.slice(0, OBSERVATION_CHAR_CAP - 1)}…`;
  }
  return `${flag} [${ts}] ${body}`;
}

export interface ReplyContextPreamble {
  text: string;
  hasContent: boolean;
}

export function buildReplyPreamble(args: {
  sessionId: string | null;
  now?: Date;
  compaction?: SessionCompaction | null;
  recalled?: RecalledTurn[];
}): ReplyContextPreamble {
  const now = args.now ?? new Date();
  const last = getLastTurnInfo(args.sessionId);
  const compaction = args.compaction ?? null;
  const recalled = args.recalled ?? [];
  const recentImages = getRecentGeneratedImages(now);
  // Phase-10 — pinned genesis. Null for sessions under 6 messages, or
  // (transiently) for sessions that haven't been touched by the live
  // path or the migration backfill yet.
  const genesis = args.sessionId ? getSessionGenesis(args.sessionId) : null;
  // Phase-11 M11 — anniversary triggers. Single highest-weighted hit
  // for today (if any); empty most days. The check is cheap (one SQL
  // SELECT + a 50-row in-process loop) so we run it unconditionally.
  const anniversaries = findAnniversaryHits(now);

  // Phase-6 — back-to-back chat turns (< 90 s gap) don't benefit from
  // the time/gap/observation hints; the model already has the prior
  // turn's wall-clock context in its (now cache-warm) replay window,
  // and shipping ~3 k tokens of preamble every other turn is pure
  // waste. Suppress the entire `[系統メモ]` block in that window.
  if (last) {
    const gapMs = now.getTime() - last.createdAt;
    if (gapMs >= 0 && gapMs < PREAMBLE_SUPPRESS_GAP_MS) {
      return { text: '', hasContent: false };
    }
  }

  // Phase-6 — drop observations that the rolling compaction summary
  // has already absorbed. The compaction stores `updatedAt` (when the
  // summary last folded in pending messages); any observation older
  // than that is implicitly already in the summary the model is
  // about to read, so listing it again is double-billing.
  //
  // We over-fetch (`× 2`) and post-filter rather than pushing the cap
  // into `queryMemory`, so a session that hasn't compacted yet still
  // gets the same K-most-recent rows the old path returned.
  const rawObservations = queryMemory(undefined, RECENT_OBSERVATIONS_K * 2);
  const observations = (() => {
    if (!compaction) return rawObservations.slice(0, RECENT_OBSERVATIONS_K);
    const cutoff = compaction.updatedAt;
    const filtered = rawObservations.filter((e) => e.createdAt >= cutoff);
    return filtered.slice(0, RECENT_OBSERVATIONS_K);
  })();

  // Phase-10 — notable observations bypass the compaction cutoff. The
  // whole point of the "milestones" slot is that it survives past the
  // rolling summary; gating it on `>= compaction.updatedAt` would defeat
  // that. We dedupe against the recent-K above so a notable entry that's
  // also recent doesn't get rendered twice.
  const recentIds = new Set(observations.map((e) => e.id));
  const notableObservations = queryNotableMemory(NOTABLE_OBSERVATIONS_K * 2)
    .filter((e) => !recentIds.has(e.id))
    .slice(0, NOTABLE_OBSERVATIONS_K);

  if (
    !last &&
    observations.length === 0 &&
    notableObservations.length === 0 &&
    !compaction &&
    !genesis &&
    anniversaries.length === 0 &&
    recalled.length === 0 &&
    recentImages.length === 0
  ) {
    return { text: '', hasContent: false };
  }

  const lines: string[] = [];
  lines.push('[系統メモ — 表示されない内部ヒント]');
  lines.push(`今: ${formatNow(now)}`);
  if (last) {
    const gapMs = now.getTime() - last.createdAt;
    const gap = formatGapJa(gapMs);
    const who = last.role === 'user' ? '彼から' : 'あなたから';
    lines.push(`前回のやり取り: ${gap} (${who})`);
  }

  if (compaction && compaction.summary.trim().length > 0) {
    lines.push('');
    lines.push('会話の累積要約 (古いやり取り):');
    lines.push(compaction.summary.trim());
  }

  if (genesis && genesis.length > 0) {
    lines.push('');
    lines.push('出会いの記憶 (このセッションが始まった日):');
    for (const turn of genesis) {
      lines.push(formatGenesisTurn(turn));
    }
  }

  if (observations.length > 0) {
    lines.push('');
    lines.push('最近の静かな観察ノート (新しい順):');
    for (const entry of observations) {
      lines.push(formatObservation(entry));
    }
  }

  if (notableObservations.length > 0) {
    lines.push('');
    lines.push('大切な瞬間 (notable — 古くても忘れてはいけないもの):');
    for (const entry of notableObservations) {
      lines.push(formatObservation(entry));
    }
  }

  if (anniversaries.length > 0) {
    lines.push('');
    lines.push('今日の記念日 (もしふさわしければ自然に触れて):');
    // Cap at 2 to keep the preamble bounded on rare days when several
    // notable events line up.
    for (const hit of anniversaries.slice(0, 2)) {
      const monthLabel =
        hit.monthsAgo === 12 ? '一年' : `${hit.monthsAgo}ヶ月`;
      const body = hit.entry.summary.replace(/\s+/g, ' ').trim();
      lines.push(`★ ${monthLabel}前の今日: ${body}`);
    }
  }

  if (recalled.length > 0) {
    lines.push('');
    lines.push('過去の関連したやり取り (記憶から):');
    for (const turn of recalled) {
      lines.push(formatRecalledTurnJa(turn));
    }
  }

  if (recentImages.length > 0) {
    lines.push('');
    lines.push('最近描いた絵 (新しい順):');
    for (const row of recentImages) {
      lines.push(formatRecentImage(row));
    }
  }

  lines.push('[メモ終わり]');

  return { text: lines.join('\n'), hasContent: true };
}

export function buildCurrentTimeLine(now: Date = new Date()): string {
  return `[系統メモ] 今: ${formatNow(now)}`;
}

// ---------- Memory context token meter ----------

const IMAGE_TOKEN_ESTIMATE = 1600;

function isCjkCodepoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodepoint(cp)) cjk += 1;
    else rest += 1;
  }
  return Math.ceil(cjk + rest / 4);
}

export function estimateMemoryContextTokens(
  sessionId: string | null,
): MemoryContextStats {
  let estimatedTokens = 0;
  let messageCount = 0;

  if (sessionId) {
    const messages = loadMessages(sessionId);
    messageCount = messages.length;
    for (const m of messages) {
      estimatedTokens += estimateTokens(m.content);
      if (m.images && m.images.length > 0) {
        estimatedTokens += m.images.length * IMAGE_TOKEN_ESTIMATE;
      }
    }
  }

  const entries = getAllMemoryEntries();
  for (const e of entries) {
    estimatedTokens += estimateTokens(e.summary);
    if (e.reason) estimatedTokens += estimateTokens(e.reason);
    if (e.message) estimatedTokens += estimateTokens(e.message);
  }

  return {
    estimatedTokens,
    messageCount,
    observationCount: entries.length,
  };
}
