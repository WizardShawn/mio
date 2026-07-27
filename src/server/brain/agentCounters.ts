import { getDatabase } from './database';

// Per-day rolling counters for Anthropic usage.
//
// Phase-1 cost-meter — `usage.input_tokens` from the Anthropic SDK
// excludes anything served from the prompt cache. The dashboard used
// to multiply `input_tokens × $15/M` and called it a day, which made
// the HUD silently under-report real spend by the cost of every
// cached-system-prompt write (~$0.16 per 5-min ephemeral TTL refresh)
// plus the discounted cache reads. We now record the four token
// classes the SDK actually returns and the cost formula sums them at
// their real per-class rates.

/**
 * Pathway label tagged onto every Anthropic call so the per-surface
 * breakdown in `agent_pathway_counters` tells us which surface is
 * actually burning the daily cap. Mirrors the entry-point inventory
 * in the cost plan: see `plans/claude_api_cost_optimization`.
 */
export type ApiPathway =
  | 'chat'
  | 'cycle'
  | 'check_in'
  | 'welcome_back'
  | 'gesture'
  | 'computer_use';

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureRow(day: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO agent_counters (day, cycles, in_tokens, out_tokens, notifs, images, cache_write_tokens, cache_read_tokens)
     VALUES (?, 0, 0, 0, 0, 0, 0, 0)
     ON CONFLICT(day) DO NOTHING`,
  ).run(day);
}

function ensurePathwayRow(day: string, pathway: ApiPathway): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO agent_pathway_counters
       (day, pathway, calls, in_tokens, out_tokens, cache_write_tokens, cache_read_tokens)
     VALUES (?, ?, 0, 0, 0, 0, 0)
     ON CONFLICT(day, pathway) DO NOTHING`,
  ).run(day, pathway);
}

export interface UsageBreakdown {
  inTokens: number;
  outTokens: number;
  /** Tokens written to the ephemeral prompt cache this call (1.25× input). */
  cacheWriteTokens: number;
  /** Tokens served from cache this call (0.10× input). */
  cacheReadTokens: number;
}

export interface DailyCounters {
  day: string;
  cycles: number;
  inTokens: number;
  outTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  notifs: number;
  images: number;
}

export interface PathwayCounters {
  day: string;
  pathway: ApiPathway;
  calls: number;
  inTokens: number;
  outTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

interface CountersRow {
  day: string;
  cycles: number;
  in_tokens: number;
  out_tokens: number;
  notifs: number;
  images: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

interface PathwayRow {
  day: string;
  pathway: string;
  calls: number;
  in_tokens: number;
  out_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

export function getDailyCounters(): DailyCounters {
  const day = todayKey();
  ensureRow(day);
  const db = getDatabase();
  const row = db
    .prepare<[string], CountersRow>(
      `SELECT day, cycles, in_tokens, out_tokens, notifs, images,
              cache_write_tokens, cache_read_tokens
         FROM agent_counters WHERE day = ?`,
    )
    .get(day);
  return {
    day,
    cycles: row?.cycles ?? 0,
    inTokens: row?.in_tokens ?? 0,
    outTokens: row?.out_tokens ?? 0,
    cacheWriteTokens: row?.cache_write_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    notifs: row?.notifs ?? 0,
    images: row?.images ?? 0,
  };
}

/**
 * Per-pathway breakdown for the day. Useful for the HUD/settings
 * "which surface is bleeding" view. Sums across all rows match the
 * roll-up in `agent_counters` (the cap check uses the roll-up).
 */
export function getPathwayCountersToday(): PathwayCounters[] {
  const day = todayKey();
  const db = getDatabase();
  const rows = db
    .prepare<[string], PathwayRow>(
      `SELECT day, pathway, calls, in_tokens, out_tokens,
              cache_write_tokens, cache_read_tokens
         FROM agent_pathway_counters
        WHERE day = ?
        ORDER BY (in_tokens + out_tokens + cache_write_tokens + cache_read_tokens) DESC`,
    )
    .all(day);
  return rows.map((r) => {
    const pathway = r.pathway as ApiPathway;
    return {
      day: r.day,
      pathway,
      calls: r.calls,
      inTokens: r.in_tokens,
      outTokens: r.out_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      cacheReadTokens: r.cache_read_tokens,
      // Cost per row at the pathway's own model rate. Falls back to
      // Opus 4.7 if a legacy row carries a pathway name we no longer
      // recognise (conservative — old prices were highest).
      estimatedCostUsd: estimateCostUsd(
        r.in_tokens,
        r.out_tokens,
        r.cache_write_tokens,
        r.cache_read_tokens,
        PATHWAY_MODEL[pathway] ?? 'opus-4-7',
      ),
    };
  });
}

function bumpPathway(
  day: string,
  pathway: ApiPathway,
  usage: UsageBreakdown,
): void {
  ensurePathwayRow(day, pathway);
  const db = getDatabase();
  db.prepare(
    `UPDATE agent_pathway_counters
        SET calls              = calls + 1,
            in_tokens          = in_tokens + ?,
            out_tokens         = out_tokens + ?,
            cache_write_tokens = cache_write_tokens + ?,
            cache_read_tokens  = cache_read_tokens + ?
      WHERE day = ? AND pathway = ?`,
  ).run(
    Math.max(0, usage.inTokens),
    Math.max(0, usage.outTokens),
    Math.max(0, usage.cacheWriteTokens),
    Math.max(0, usage.cacheReadTokens),
    day,
    pathway,
  );
}

export function bumpCycle(usage: UsageBreakdown): DailyCounters {
  const day = todayKey();
  ensureRow(day);
  const db = getDatabase();
  db.prepare(
    `UPDATE agent_counters
        SET cycles             = cycles + 1,
            in_tokens          = in_tokens + ?,
            out_tokens         = out_tokens + ?,
            cache_write_tokens = cache_write_tokens + ?,
            cache_read_tokens  = cache_read_tokens + ?
      WHERE day = ?`,
  ).run(
    Math.max(0, usage.inTokens),
    Math.max(0, usage.outTokens),
    Math.max(0, usage.cacheWriteTokens),
    Math.max(0, usage.cacheReadTokens),
    day,
  );
  bumpPathway(day, 'cycle', usage);
  return getDailyCounters();
}

/**
 * Phase-1 — call this on every Anthropic response from the chat
 * pathway (typed user, gesture batch, notable check-in, welcome-back,
 * computer-use). `pathway` tags the row written to
 * `agent_pathway_counters` so the HUD can show which surface is
 * actually consuming the budget. The roll-up in `agent_counters` is
 * still the single number the cap check reads.
 */
export function bumpChatUsage(
  usage: UsageBreakdown,
  pathway: ApiPathway = 'chat',
): DailyCounters {
  const day = todayKey();
  ensureRow(day);
  const db = getDatabase();
  db.prepare(
    `UPDATE agent_counters
        SET in_tokens          = in_tokens + ?,
            out_tokens         = out_tokens + ?,
            cache_write_tokens = cache_write_tokens + ?,
            cache_read_tokens  = cache_read_tokens + ?
      WHERE day = ?`,
  ).run(
    Math.max(0, usage.inTokens),
    Math.max(0, usage.outTokens),
    Math.max(0, usage.cacheWriteTokens),
    Math.max(0, usage.cacheReadTokens),
    day,
  );
  bumpPathway(day, pathway, usage);
  return getDailyCounters();
}

export function bumpNotification(): DailyCounters {
  const day = todayKey();
  ensureRow(day);
  const db = getDatabase();
  db.prepare(
    `UPDATE agent_counters SET notifs = notifs + 1 WHERE day = ?`,
  ).run(day);
  return getDailyCounters();
}

export function bumpImage(): DailyCounters {
  const day = todayKey();
  ensureRow(day);
  const db = getDatabase();
  db.prepare(
    `UPDATE agent_counters SET images = images + 1 WHERE day = ?`,
  ).run(day);
  return getDailyCounters();
}

// Per-model list pricing, USD per million tokens. Cache write is
// 1.25× input for the default 5-minute ephemeral TTL; cache read is
// 0.10× input.
//
// Phase-12 — pre-Phase-12 the meter used a single Opus 4.0/4.1-era
// constant set ($15 / $75 in/out) for every pathway. Two problems:
// (a) Opus 4.7's current list price is $5 / $25 — about 3× lower —
// so the meter over-reported and the daily cap was firing at ~⅓ of
// the budget the operator actually authorised; (b) the `cycle`
// pathway now runs on Haiku 4.5 (~5× cheaper still). Without
// per-model rates the cap and HUD both drift from reality. With
// them, both track.
//
// Note: 1-hour-TTL cache writes are billed at 2× input (vs. 1.25×
// for 5m). We don't split those out here because the SDK's
// `cache_creation_input_tokens` doesn't separate them on this
// version, and 1h-TTL writes amortise to near-zero once the entry
// is warm — the resulting under-count is dwarfed by the 3× rate
// correction above.
export type CostModel = 'opus-4-7' | 'sonnet-4-6' | 'haiku-4-5';

const RATES: Record<CostModel, {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}> = {
  'opus-4-7':   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'haiku-4-5':  { input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * Pathway → Anthropic model map. Mirrors which model each call site
 * passes to `client.messages.create`. **Update both this map AND the
 * actual call site in sync**, or the meter silently drifts from the
 * real bill.
 *
 *   - cycle:        Haiku 4.5  (autonomous observation; JSON-note only)
 *   - chat:         Opus 4.7   (typed user; full tool surface)
 *   - check_in:     Opus 4.7   (notable check-in chat turn)
 *   - welcome_back: Opus 4.7   (launch greeting if gap > 30 min)
 *   - gesture:      Opus 4.7   (avatar touch reaction)
 *   - computer_use: Opus 4.7   (visual-control session)
 */
const PATHWAY_MODEL: Record<ApiPathway, CostModel> = {
  chat: 'opus-4-7',
  cycle: 'haiku-4-5',
  check_in: 'opus-4-7',
  welcome_back: 'opus-4-7',
  gesture: 'opus-4-7',
  computer_use: 'opus-4-7',
};

export function estimateCostUsd(
  inTokens: number,
  outTokens: number,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
  model: CostModel = 'opus-4-7',
): number {
  const r = RATES[model];
  return (
    (inTokens / 1_000_000) * r.input +
    (outTokens / 1_000_000) * r.output +
    (cacheWriteTokens / 1_000_000) * r.cacheWrite +
    (cacheReadTokens / 1_000_000) * r.cacheRead
  );
}

/**
 * Sum of today's per-pathway costs, each row priced at the model
 * that pathway actually runs on. Replaces the old roll-up costing
 * (`estimateCostUsd(getDailyCounters().*)`) which was model-blind
 * and over-reported by ~3× once the `cycle` pathway moved to Haiku.
 *
 * Cap gates in `agent.ts > tick`, `chatService.ts > send`, and
 * `computerUse/session.ts`, plus the HUD figure on
 * `AgentStatus.estimatedCostUsdToday`, all read this number. The
 * roll-up in `agent_counters` is still used for cycles/images/
 * notifications counts — only the *dollar* total flows through here.
 */
export function getEstimatedCostTodayUsd(): number {
  return getPathwayCountersToday().reduce(
    (sum, row) => sum + row.estimatedCostUsd,
    0,
  );
}

/**
 * Tiny helper that converts the SDK's raw `usage` object into the
 * `UsageBreakdown` shape `bumpChatUsage` / `bumpCycle` want. Kept
 * here so every caller normalises the same way (the SDK exposes
 * cache fields as snake_case optional numbers and we want them
 * coerced to non-negative integers regardless).
 */
export function usageFromResponse(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): UsageBreakdown {
  return {
    inTokens: Math.max(0, Math.floor(usage.input_tokens ?? 0)),
    outTokens: Math.max(0, Math.floor(usage.output_tokens ?? 0)),
    cacheWriteTokens: Math.max(
      0,
      Math.floor(usage.cache_creation_input_tokens ?? 0),
    ),
    cacheReadTokens: Math.max(
      0,
      Math.floor(usage.cache_read_input_tokens ?? 0),
    ),
  };
}
