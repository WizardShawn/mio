import { getDatabase } from './database';

// Phase 5 observation memory. The cycle's `write_memory` tool drops
// entries here; `query_memory` reads them back.

export interface MemoryEntry {
  id: number;
  summary: string;
  notable: boolean;
  reason: string | null;
  message: string | null;
  tags: string[];
  /**
   * Phase-11 M8 — 0-10 weighting set at write time. Higher = should
   * survive aging-out longer. Default 5 (neutral midpoint).
   */
  importance: number;
  createdAt: number;
}

interface MemoryRow {
  id: number;
  summary: string;
  notable: number;
  reason: string | null;
  message: string | null;
  tags: string | null;
  importance: number;
  created_at: number;
}

function rowToEntry(r: MemoryRow): MemoryEntry {
  let tags: string[] = [];
  if (r.tags) {
    try {
      const parsed = JSON.parse(r.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tags = r.tags.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return {
    id: r.id,
    summary: r.summary,
    notable: r.notable === 1,
    reason: r.reason,
    message: r.message,
    tags,
    importance: typeof r.importance === 'number' ? r.importance : 5,
    createdAt: r.created_at,
  };
}

export function writeMemory(input: {
  summary: string;
  notable: boolean;
  reason?: string | null;
  message?: string | null;
  tags?: string[];
  /**
   * Phase-11 M8 — caller-supplied importance (0-10). Clamped on
   * write. Default 5 when omitted (legacy callers); reflection.ts
   * writes 7; emotional milestones flagged by the cycle should
   * write 8-10.
   */
  importance?: number;
}): MemoryEntry {
  const db = getDatabase();
  const now = Date.now();
  const tagsJson = input.tags && input.tags.length > 0
    ? JSON.stringify(input.tags.slice(0, 16))
    : null;
  const importance = clampImportance(input.importance);
  const result = db
    .prepare(
      `INSERT INTO memory_entries (summary, notable, reason, message, tags, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.summary.slice(0, 4000),
      input.notable ? 1 : 0,
      input.reason ?? null,
      input.message ?? null,
      tagsJson,
      importance,
      now,
    );
  return {
    id: Number(result.lastInsertRowid),
    summary: input.summary,
    notable: input.notable,
    reason: input.reason ?? null,
    message: input.message ?? null,
    tags: input.tags ?? [],
    importance,
    createdAt: now,
  };
}

function clampImportance(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 5;
  return Math.max(0, Math.min(10, Math.round(v)));
}

/**
 * Phase 5 retrieval: recency first, with a coarse LIKE filter when the
 * caller passes a query. Phase 6 replaces this with vector similarity.
 */
export function queryMemory(query?: string, limit: number = 8): MemoryEntry[] {
  const db = getDatabase();
  const cap = Math.max(1, Math.min(50, limit));
  if (query && query.trim().length > 0) {
    const needle = `%${query.trim()}%`;
    const rows = db
      .prepare<[string, string, string, number], MemoryRow>(
        `SELECT id, summary, notable, reason, message, tags, importance, created_at
           FROM memory_entries
          WHERE summary LIKE ? OR reason LIKE ? OR message LIKE ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(needle, needle, needle, cap);
    return rows.map(rowToEntry);
  }
  const rows = db
    .prepare<[number], MemoryRow>(
      `SELECT id, summary, notable, reason, message, tags, importance, created_at
         FROM memory_entries
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(cap);
  return rows.map(rowToEntry);
}

/**
 * Phase-10 — notable-only retrieval. Separate from `queryMemory` so
 * the preamble can hold a dedicated "milestones" slot that doesn't age
 * out under the rolling-window observation feed.
 *
 * Phase-11 M8 — ranked by `importance · exp(-age_days / τ)` rather
 * than pure recency, so an emotionally weighty memory from three
 * months ago can still outrank a notable-but-routine one from this
 * week. τ is per-tag adaptive: entries tagged `reflection` decay
 * slowly (180 days) because synthesised patterns stay true for a
 * long time; everything else decays at 60 days. The recall-pool
 * fetch widens to limit × 4 so the JS-side scoring has something to
 * choose from across the importance distribution.
 *
 * Note: this is a heuristic, not literal ML. The exp curve is
 * monotonic and the constants are tunable; the goal is to make
 * "important + old" beat "routine + recent", not to compete with a
 * proper ranking model.
 */
const DECAY_TAU_DAYS_DEFAULT = 60;
const DECAY_TAU_DAYS_REFLECTION = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function decayTauForEntry(e: MemoryEntry): number {
  if (e.tags.includes('reflection')) return DECAY_TAU_DAYS_REFLECTION;
  return DECAY_TAU_DAYS_DEFAULT;
}

function importanceDecayScore(e: MemoryEntry, now: number): number {
  const ageDays = Math.max(0, (now - e.createdAt) / MS_PER_DAY);
  const tau = decayTauForEntry(e);
  return (e.importance / 10) * Math.exp(-ageDays / tau);
}

export function queryNotableMemory(limit: number = 3): MemoryEntry[] {
  const db = getDatabase();
  const cap = Math.max(1, Math.min(20, limit));
  const poolSize = Math.max(cap * 4, 16);
  const rows = db
    .prepare<[number], MemoryRow>(
      `SELECT id, summary, notable, reason, message, tags, importance, created_at
         FROM memory_entries
        WHERE notable = 1
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(poolSize);
  const entries = rows.map(rowToEntry);
  if (entries.length === 0) return [];

  const now = Date.now();
  return entries
    .map((e) => ({ entry: e, score: importanceDecayScore(e, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((r) => r.entry);
}

/**
 * Phase-11 M11 — anniversary lookup. Returns notable entries whose
 * `createdAt` falls on the same calendar month/day as `now`, at a
 * resolution of N months back (1, 3, 6, 12). The preamble renders the
 * top one (highest importance) as a single-line nudge so Mio can say
 * "今日でちょうど三ヶ月だね…" unprompted on the right day.
 *
 * Resolution is calendar-day, not exact-second; we accept any entry
 * whose anniversary day falls within `± ANNIVERSARY_DAY_TOLERANCE` of
 * today so the operator doesn't miss it if they're not chatting on
 * the literal day. Ordered by importance × month-bucket: a 12-month
 * anniversary of a 9-importance event wins over a 1-month of a
 * 5-importance one.
 */
const ANNIVERSARY_MONTHS = [1, 3, 6, 12] as const;
const ANNIVERSARY_DAY_TOLERANCE = 1;

export interface AnniversaryHit {
  entry: MemoryEntry;
  monthsAgo: number;
}

export function findAnniversaryHits(now: Date = new Date()): AnniversaryHit[] {
  const db = getDatabase();
  // Look back up to 12 months + tolerance; cap returned rows to keep
  // this cheap. The post-SQL filter does the real anniversary check
  // since SQLite date math at month precision is awkward.
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 13);
  const rows = db
    .prepare<[number, number, number], MemoryRow>(
      `SELECT id, summary, notable, reason, message, tags, importance, created_at
         FROM memory_entries
        WHERE notable = 1
          AND created_at >= ?
          AND created_at <= ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(cutoff.getTime(), now.getTime() - 24 * 60 * 60 * 1000, 50);

  const hits: AnniversaryHit[] = [];
  const todayY = now.getFullYear();
  const todayM = now.getMonth();
  const todayD = now.getDate();
  for (const r of rows) {
    const entry = rowToEntry(r);
    const created = new Date(entry.createdAt);
    for (const monthsBack of ANNIVERSARY_MONTHS) {
      // Target anniversary date = today's month/day at created.year +
      // (today - created in years, rounded). We instead compute it
      // forward: created + monthsBack months should equal "today".
      const target = new Date(created);
      target.setMonth(target.getMonth() + monthsBack);
      if (target.getFullYear() !== todayY) continue;
      if (target.getMonth() !== todayM) continue;
      const dayDelta = Math.abs(target.getDate() - todayD);
      if (dayDelta > ANNIVERSARY_DAY_TOLERANCE) continue;
      hits.push({ entry, monthsAgo: monthsBack });
      break; // one bucket per entry max
    }
  }

  // Sort by importance × monthsBack (foundational + long-ago wins).
  hits.sort(
    (a, b) =>
      b.entry.importance * b.monthsAgo - a.entry.importance * a.monthsAgo,
  );
  return hits;
}

/**
 * Every observation entry, newest first — no limit. Used by the
 * context-token meter on the Settings page to size the full memory
 * footprint; not a hot path (only read when Settings is open).
 */
export function getAllMemoryEntries(): MemoryEntry[] {
  const db = getDatabase();
  const rows = db
    .prepare<[], MemoryRow>(
      `SELECT id, summary, notable, reason, message, tags, importance, created_at
         FROM memory_entries
        ORDER BY created_at DESC`,
    )
    .all();
  return rows.map(rowToEntry);
}
