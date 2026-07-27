import { getDatabase } from './database';
import {
  EMBED_DIM,
  EMBED_MODEL,
  bufferToFloat32,
  embedText,
  float32ToBuffer,
} from './geminiEmbed';
import { loadGeminiKey } from './geminiKey';
import { getHost } from './host';

// Phase 6.5 — semantic recall.
//
// Every chat turn (user, assistant, gesture batch, auto-loop check-in,
// the cached startup greeting) gets embedded by Gemini and stored in
// `message_vectors`. On each interactive call, we embed the current
// user message and pull the top ~K most-similar OLDER turns (ones that
// fall outside the `MAX_REPLAYED_TURNS` window so they aren't already
// in the prompt) into the [系統メモ] preamble. Result: replay window
// stays bounded, but old conversation context — "the auth refactor we
// were stuck on three weeks ago" — can resurface when relevant.
//
// Vector store choice: in-process cosine over BLOB embeddings, NOT
// sqlite-vec. The dev plan's tech table names sqlite-vec, but the same
// plan repeatedly avoids native-build-matrix dependencies (see
// activeWindow.ts which uses PowerShell instead of `active-win`).
// sqlite-vec is a native loadable extension; at personal-assistant
// scale (thousands of turns max) the two are behaviorally identical
// and the in-process path keeps the build flat. Migration to sqlite-vec
// is a one-table swap if the soak ever puts pressure on this.
//
// All embeddings are L2-normalized at write time (see geminiEmbed.ts),
// so cosine similarity reduces to a dot product — no sqrt at query
// time, no per-vector normalization.

/**
 * Top-K recalled turns surfaced into the [系統メモ] preamble.
 *
 * Phase-10 — bumped 4 → 6. The sliding-window compaction (compaction.ts)
 * now only covers messages 70-210 back; everything older falls out of the
 * summary entirely and lives in vector recall only. With that much more
 * material relying on vector retrieval, 4 was leaving too many real
 * matches on the floor. 6 reaches further without crowding the rest of
 * the preamble; the M2 MMR pass (Phase 11) keeps the picks diverse so
 * none of those slots get wasted on near-duplicates of each other.
 */
export const DEFAULT_RECALL_K = 6;

/**
 * Minimum cosine similarity to consider a turn "relevant" enough to
 * surface, baseline value. Below this we'd rather show nothing than
 * dilute the recall section with semantically distant noise.
 *
 * Calibrated empirically by `scripts/audit-recall.js` against the actual
 * `gemini-embedding-001` model + the 768-dim Matryoshka truncation we
 * use (see `geminiEmbed.ts › EMBED_DIM`). Findings from a 40-turn
 * synthetic session covering four distinct topics:
 *   • genuine topical matches scored 0.74 – 0.94
 *   • semantically unrelated turns scored 0.67 – 0.72
 *   • the natural separator sat at ~0.73
 * The original `0.55` floor was too lax: a totally off-topic query
 * ("boiling point of mercury") returned four above-threshold "memories"
 * that were prepended to Mio's `[系統メモ] › 過去の関連したやり取り`
 * section every turn. At 0.70 we keep almost all real matches and
 * still cut the worst of the noise; tighten to 0.75 if false positives
 * start showing up in operator-visible recall sections again.
 *
 * Phase-10 — the chatService gate dropped from 20 → 12 chars so short
 * emotional asks ("覚えてる?", "あの話") can trigger recall. Short
 * queries embed less informatively, so we raise the threshold for them
 * via `effectiveSimilarityFloor` rather than letting 0.70-band noise
 * dominate a 12-char query.
 */
const MIN_SIMILARITY = 0.7;
const MIN_SIMILARITY_SHORT_QUERY = 0.78;
const SHORT_QUERY_CHAR_THRESHOLD = 20;

function effectiveSimilarityFloor(queryLength: number): number {
  return queryLength < SHORT_QUERY_CHAR_THRESHOLD
    ? MIN_SIMILARITY_SHORT_QUERY
    : MIN_SIMILARITY;
}

/**
 * Phase-10 — temporal de-duplication window. After we've picked a
 * candidate for recall, drop any other candidate whose `createdAt` falls
 * within this window of an already-selected (higher-scoring) one. Stops
 * 4 fragments of the same 10-minute argument from crowding the recall
 * block — the operator gets one anchor from that exchange, not the whole
 * sequence.
 */
const TEMPORAL_DEDUP_WINDOW_MS = 3 * 60 * 1000;

/**
 * Phase-10 — recency-bias coefficient. Two candidates with cosines
 * within ~0.03 of each other prefer the more recent one slightly,
 * because under the new sliding-window compaction the very-recent
 * past is likely already covered by the rolling summary, so an
 * older-but-equally-relevant match adds more information density.
 * Inverse-rank weighting: `score = cosine * (1 + RECENCY_BIAS * (newer_rank / total))`.
 * Small enough that genuine semantic relevance still dominates;
 * large enough to break ties toward freshness.
 */
const RECENCY_BIAS = 0.03;

/**
 * Phase-11 M2 — Maximal Marginal Relevance trade-off. Each next pick
 * after the first is chosen to maximise:
 *   `MMR_LAMBDA * relevance − (1 − MMR_LAMBDA) * max_similarity_to_picked`
 * λ closer to 1 = greedy relevance (old behaviour); λ closer to 0 =
 * pure diversity. 0.7 keeps relevance dominant while preventing
 * picks 2-K from being semantic clones of pick 1 — solves the
 * "4 fragments of the same argument" failure mode that pure cosine
 * sort produces on long sessions with a single dominant topic.
 *
 * Note: this is *semantic* diversity (vector distance). Temporal
 * dedup below (TEMPORAL_DEDUP_WINDOW_MS) is a separate filter for
 * "same conversation, different sentences" — they catch overlapping
 * but distinct failure modes.
 */
const MMR_LAMBDA = 0.7;

/**
 * Phase-11 M3 — Reciprocal Rank Fusion constant. Standard literature
 * value (Cormack et al. 2009); RRF is robust against the exact value
 * over a wide range. Score per candidate per ranking =
 *   `1 / (RRF_K + rank)`.
 * Final score = sum across both rankings (cosine + BM25). The constant
 * dampens the influence of very-high-rank-number candidates so the
 * top of one list doesn't get outvoted by the bulk of the other.
 */
const RRF_K = 60;

/**
 * Phase-11 M3 — BM25 candidate pool size. Larger than DEFAULT_RECALL_K
 * because RRF fusion needs both rankings to overlap meaningfully; if
 * BM25 only returned 4 results and cosine returned 4 different ones,
 * fusion would just be a concatenation. 30 gives RRF something to
 * work with without breaking the candidate-set assumption that lets
 * MMR run in sub-millisecond time.
 */
const BM25_POOL_SIZE = 30;

/**
 * Phase-11 M1 — Flash reranker model. Same `gemini-3.5-flash` as
 * compaction.ts uses (a "near-Pro reasoning at Flash cost & speed"
 * tier per Google's May 2026 spec sheet). Cheap enough to call on
 * every recall (~$0.0001/call) and fast enough that the user-facing
 * latency budget is still dominated by Anthropic streaming.
 */
const RERANK_MODEL = 'gemini-3.5-flash';

/**
 * Phase-11 M1 — how many post-MMR candidates to pass to Flash. The
 * reranker is the last quality filter; bigger pool = more chances to
 * find the actually-relevant items, but costs more tokens. K=6 final
 * picks × ~2 = 12 candidate ceiling; cap at `MAX_RERANK_CANDIDATES`
 * to bound the Flash prompt size.
 */
const RERANK_POOL_MULTIPLIER = 2;
const MAX_RERANK_CANDIDATES = 12;

/**
 * Phase-11 M1 — minimum rerank score to keep a candidate. Flash
 * returns 0-1 floats; we drop anything below this. Tighter than the
 * cosine floor because Flash sees the actual text and can confidently
 * mark things irrelevant.
 */
const MIN_RERANK_SCORE = 0.35;

const RERANK_SAFETY_SETTINGS_ALL_OFF: Array<{
  category: string;
  threshold: string;
}> = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];

/**
 * Bounded backfill batch size. The first launch on an existing DB
 * embeds historical turns in the background so semantic recall isn't
 * empty until the user types again. We cap per-call work so a session
 * with 500 stored messages doesn't pay for 500 sequential network
 * round-trips on app boot.
 */
const BACKFILL_BATCH_SIZE = 32;

/** Throttle between backfill embed calls so we don't hammer Gemini. */
const BACKFILL_DELAY_MS = 150;

export interface RecalledTurn {
  messageId: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** Cosine similarity in [-1, 1] (in practice [0, 1] for L2-normed vecs). */
  score: number;
  /**
   * Phase-11 M4 — conversation-aware context. The message immediately
   * before / after the matched one in the same session, when present.
   * Lets the formatter render a 3-line block so an assistant reply
   * pulled out of context (e.g. "うん、それでいいよ") is shown beside
   * the user question that triggered it — otherwise the model gets a
   * useless reply with no anchor.
   */
  before?: AdjacentTurn;
  after?: AdjacentTurn;
}

export interface AdjacentTurn {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

interface VectorRow {
  message_id: number;
  embedding: Buffer;
  dim: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

interface BackfillRow {
  id: number;
  content: string;
  created_at: number;
}

/**
 * Persist an embedding for a single message. Idempotent — duplicate
 * inserts on the same message id are silently ignored, which lets the
 * fire-and-forget caller in `anthropic.ts` retry on transient errors
 * without poisoning the table.
 */
export function storeMessageVector(args: {
  messageId: number;
  sessionId: string;
  vector: Float32Array;
  createdAt: number;
}): void {
  const db = getDatabase();
  const buf = float32ToBuffer(args.vector);
  db.prepare(
    `INSERT OR REPLACE INTO message_vectors
       (message_id, session_id, embedding, dim, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    args.messageId,
    args.sessionId,
    buf,
    args.vector.length,
    EMBED_MODEL,
    args.createdAt,
  );
}

/**
 * Has this message already been embedded? Used by the backfill loop
 * to skip rows that already have a vector.
 */
export function hasMessageVector(messageId: number): boolean {
  const db = getDatabase();
  const row = db
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM message_vectors WHERE message_id = ?`,
    )
    .get(messageId);
  return (row?.c ?? 0) > 0;
}

/**
 * Embed `content` via Gemini and store the vector against the message
 * id. Fire-and-forget: any failure (no key, network blip, empty text)
 * is logged and swallowed so an embedding miss can never block the
 * chat path. Idempotent — safe to call from multiple paths for the
 * same message.
 */
export async function embedAndStoreMessage(args: {
  messageId: number;
  sessionId: string;
  content: string;
  createdAt: number;
}): Promise<void> {
  if (!args.content || !args.content.trim()) return;
  // Skip if already embedded — covers the backfill ↔ live path race
  // where a message lands in the live path while the backfill is mid-loop.
  if (hasMessageVector(args.messageId)) return;
  try {
    const vec = await embedText(args.content);
    if (!vec) return; // No key / failure — degrade silently.
    storeMessageVector({
      messageId: args.messageId,
      sessionId: args.sessionId,
      vector: vec,
      createdAt: args.createdAt,
    });
  } catch (err) {
    console.warn('[recall] failed to embed message', args.messageId, err);
  }
}

/**
 * Embed the user's current message and return the top-K most similar
 * older turns from the same session. "Older" means strictly before
 * `beforeTimestamp` (the caller passes the oldest message that's
 * already going to be replayed in the prompt — anything ≥ that is
 * already visible to the model and not worth recalling).
 *
 * Best-effort: returns [] if Gemini can't embed (no key / failure),
 * if there are no stored vectors yet, or if no candidate scores above
 * `MIN_SIMILARITY`.
 */
export async function recallSimilarTurns(args: {
  sessionId: string;
  query: string;
  /** Only consider turns with `created_at < beforeTimestamp`. */
  beforeTimestamp: number;
  topK?: number;
}): Promise<RecalledTurn[]> {
  const trimmed = args.query.trim();
  if (!trimmed) return [];

  const queryVec = await embedText(trimmed);
  if (!queryVec) return [];

  const candidates = loadCandidateVectors(args.sessionId, args.beforeTimestamp);
  if (candidates.length === 0) return [];

  const k = Math.max(1, args.topK ?? DEFAULT_RECALL_K);
  // Phase-10 — adaptive cosine floor by query length. Short queries
  // embed less informatively and produce more spurious 0.70-band
  // matches; bumping the floor for them keeps the precision up.
  const floor = effectiveSimilarityFloor(trimmed.length);

  // Phase-11 M3 — fetch BM25 ranks in parallel with the cosine pass.
  // Lexical retrieval catches names / dates / rare proper nouns that
  // cosine misses; RRF fuses the two rankings below.
  const bm25Results = bm25Search({
    sessionId: args.sessionId,
    query: trimmed,
    beforeTimestamp: args.beforeTimestamp,
  });
  const bm25Ranks = new Map<number, number>();
  bm25Results.forEach((r, idx) => bm25Ranks.set(r.message_id, idx));

  // Phase-11 M2 + M3 — keep the embedding vector on the interim
  // scoring type so MMR selection can compute candidate-candidate
  // similarity. `cosScore` is retained alongside the fused `score` so
  // diagnostics can attribute relevance back to either signal.
  // Include a candidate if EITHER (a) it clears the cosine floor OR
  // (b) it appears in the BM25 top-N — BM25-only matches are usually
  // the rare-proper-noun saves cosine couldn't make.
  const scored: Array<
    RecalledTurn & { vec: Float32Array; cosScore: number; bm25Rank: number | null }
  > = [];
  for (const row of candidates) {
    if (row.dim !== queryVec.length) continue;
    const vec = bufferToFloat32(row.embedding);
    if (vec.length !== queryVec.length) continue;
    const cosScore = dotProduct(queryVec, vec);
    const bm25Rank = bm25Ranks.get(row.message_id) ?? null;
    if (cosScore < floor && bm25Rank === null) continue;
    scored.push({
      messageId: row.message_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      score: 0, // populated by RRF below
      vec,
      cosScore,
      bm25Rank,
    });
  }
  if (scored.length === 0) return [];

  // Phase-11 M3 — Reciprocal Rank Fusion. Rank candidates by cosine
  // (descending), then sum `1/(RRF_K + rank)` across cosine and BM25
  // rankings. RRF is robust because the constant `RRF_K=60` dampens
  // the influence of high rank numbers, so the top of one list can't
  // be outvoted by the bulk of the other.
  const byCos = [...scored].sort((a, b) => b.cosScore - a.cosScore);
  const cosRanks = new Map<number, number>();
  byCos.forEach((c, idx) => cosRanks.set(c.messageId, idx));
  for (const c of scored) {
    const cosRank = cosRanks.get(c.messageId) ?? 0;
    const rrfFromCos = 1 / (RRF_K + cosRank);
    const rrfFromBm25 = c.bm25Rank !== null ? 1 / (RRF_K + c.bm25Rank) : 0;
    c.score = rrfFromCos + rrfFromBm25;
  }

  // Phase-10 — mild recency boost (RECENCY_BIAS) on the *fused* score.
  // Rank by `createdAt` descending, then weight:
  //   `effective = score * (1 + RECENCY_BIAS * (1 - rank/N))`.
  // Most-recent candidate gets the full bias; oldest gets none. Tunable;
  // 0.03 is small enough that genuine cosine/BM25 dominance still wins,
  // large enough to break ties toward freshness.
  const byRecency = [...scored].sort((a, b) => b.createdAt - a.createdAt);
  const rankByMessageId = new Map<number, number>();
  byRecency.forEach((c, idx) => rankByMessageId.set(c.messageId, idx));
  const totalCandidates = byRecency.length;
  for (const c of scored) {
    const rank = rankByMessageId.get(c.messageId) ?? totalCandidates - 1;
    const recencyWeight = totalCandidates > 1
      ? 1 - rank / (totalCandidates - 1)
      : 0;
    c.score = c.score * (1 + RECENCY_BIAS * recencyWeight);
  }

  scored.sort((a, b) => b.score - a.score);

  // Phase-11 M2 — Maximal Marginal Relevance selection. First pick is
  // the highest scorer; each subsequent pick maximises
  //   `MMR_LAMBDA * relevance − (1 − MMR_LAMBDA) * max_sim_to_picked`.
  // Combined with the temporal dedup below, this gives both *semantic*
  // and *temporal* diversity in the final K picks.
  //
  // Computational cost: O(K · N) cosine ops where N ≤ |scored|. K=6,
  // N typically < 200 → < 1,200 dot products on 768-dim vectors,
  // sub-millisecond.
  // Phase-11 M1 — MMR over-selects so Flash rerank has a real choice.
  // We pick min(MMR_POOL_SIZE, candidates) through MMR, then narrow to
  // k via Flash. On rerank failure we keep the MMR top-k, so quality
  // never dips below the M2 baseline.
  const mmrPoolSize = Math.min(
    MAX_RERANK_CANDIDATES,
    Math.max(k, k * RERANK_POOL_MULTIPLIER),
  );
  const picked: Array<
    RecalledTurn & { vec: Float32Array; cosScore: number; bm25Rank: number | null }
  > = [];
  const remaining = [...scored];
  while (picked.length < mmrPoolSize && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i]!;
      // Temporal dedup gate — skip candidates within
      // TEMPORAL_DEDUP_WINDOW_MS of an already-picked turn. Stops a
      // single dense conversation from monopolising K slots with
      // near-adjacent fragments even if they're semantically distinct.
      const clashes = picked.some(
        (p) => Math.abs(p.createdAt - cand.createdAt) < TEMPORAL_DEDUP_WINDOW_MS,
      );
      if (clashes) continue;

      let maxSimToPicked = 0;
      for (const p of picked) {
        const sim = dotProduct(cand.vec, p.vec);
        if (sim > maxSimToPicked) maxSimToPicked = sim;
      }
      const mmr =
        MMR_LAMBDA * cand.score - (1 - MMR_LAMBDA) * maxSimToPicked;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    if (bestMmr === -Infinity) break; // every remaining candidate clashed temporally
    picked.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }

  // Phase-11 M1 — Flash rerank the MMR pool down to the final k.
  // Flash sees the actual conversation text (not just embeddings) and
  // can confidently mark things irrelevant that cosine + BM25 thought
  // looked like a match. On any failure (no key, malformed output)
  // `rerankScores` is null and we fall back to the MMR top-k.
  let finalPicks = picked;
  const rerankInput = picked.map((p) => ({
    role: p.role,
    content: p.content,
    createdAt: p.createdAt,
  }));
  const rerankScores = await rerankWithFlash({
    query: trimmed,
    candidates: rerankInput,
  });
  if (rerankScores) {
    const reranked = picked.map((p, i) => ({
      pick: p,
      rerankScore: rerankScores[i] ?? 0,
    }));
    reranked.sort((a, b) => b.rerankScore - a.rerankScore);
    finalPicks = reranked
      .filter((r) => r.rerankScore >= MIN_RERANK_SCORE)
      .slice(0, k)
      .map((r) => {
        // Overwrite `score` with the rerank value so callers and
        // diagnostics see the final-stage confidence, not the RRF
        // pre-rerank number.
        r.pick.score = r.rerankScore;
        return r.pick;
      });
  } else {
    finalPicks = picked.slice(0, k);
  }

  // Phase-11 M4 — attach the message immediately before and after each
  // pick so the formatter can render a 3-line conversational block.
  // The DB hops are cheap (covered index on messages) and only run for
  // the final K picks, not the full candidate set.
  const result: RecalledTurn[] = finalPicks.map(
    ({ vec: _vec, cosScore: _c, bm25Rank: _b, ...rest }) => rest,
  );
  for (const p of result) {
    const adj = loadAdjacentTurns(args.sessionId, p.messageId);
    if (adj.before) p.before = adj.before;
    if (adj.after) p.after = adj.after;
  }

  return result;
}

/**
 * Phase-11 M4 — fetch the messages immediately before and after a
 * given message id within the same session. Both can be null near the
 * session boundaries. Used to expand a recalled turn into a 3-line
 * conversational block so the model sees the question that prompted
 * an assistant reply (or the reply that followed a user question).
 */
function loadAdjacentTurns(
  sessionId: string,
  messageId: number,
): { before: AdjacentTurn | null; after: AdjacentTurn | null } {
  const db = getDatabase();
  const before = db
    .prepare<[string, number], AdjacentTurn>(
      `SELECT role, content, created_at AS createdAt
         FROM messages
        WHERE session_id = ?
          AND id < ?
          AND length(trim(content)) > 0
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(sessionId, messageId);
  const after = db
    .prepare<[string, number], AdjacentTurn>(
      `SELECT role, content, created_at AS createdAt
         FROM messages
        WHERE session_id = ?
          AND id > ?
          AND length(trim(content)) > 0
        ORDER BY id ASC
        LIMIT 1`,
    )
    .get(sessionId, messageId);
  return { before: before ?? null, after: after ?? null };
}

/**
 * Phase-11 M3 — escape a user-typed query for FTS5 MATCH. The default
 * FTS5 query language treats `:`, `-`, `(`, `)`, `*`, `"` as syntax;
 * an unsanitised user query like "what's up?" or a Japanese sentence
 * with a colon will trigger a `SQLITE_ERROR: malformed MATCH
 * expression`. We strip those characters, split on whitespace, drop
 * empty tokens, then re-join as a quoted phrase per token (which makes
 * each token an independent OR clause via FTS5's implicit OR-of-tokens
 * default). Returns null if nothing remained after stripping — caller
 * must fall back to cosine-only.
 */
function buildFtsMatchExpression(query: string): string | null {
  const stripped = query
    .replace(/["():*\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  const tokens = stripped.split(' ').filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  // Wrap each token in double quotes to neutralise any remaining
  // syntax-like chars FTS5 might object to (full-width punctuation,
  // unusual control chars). The implicit OR between quoted phrases
  // gives standard BM25 multi-term behaviour.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

interface Bm25Row {
  message_id: number;
  rank: number;
}

/**
 * Phase-11 M3 — BM25 lexical retrieval over the FTS5 mirror of
 * messages.content. Returns up to BM25_POOL_SIZE message ids ordered
 * best-first (FTS5's `bm25()` returns lower = better; we ORDER BY rank
 * ascending and reverse the sign so downstream code reads "higher =
 * better" like cosine does). Filters to the same session and the same
 * `created_at < beforeTimestamp` window cosine uses.
 *
 * Best-effort: returns [] on any malformed query, no FTS rows, or
 * unexpected SQLite error — so the cosine path stays the floor on
 * recall quality and BM25 only ever adds to it, never breaks it.
 */
interface RerankResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

/**
 * Phase-11 M1 — Flash-based relevance rerank. Given a user query and a
 * shortlist of pre-selected candidate turns, return a parallel array
 * of 0-1 relevance scores. The reranker reads the actual conversation
 * text (not just embeddings) so it catches the case where two turns
 * are semantically *close* but only one is the answer the user is
 * actually reaching for.
 *
 * Best-effort: returns null on any failure (no key, network blip,
 * malformed Flash output). The caller then falls back to the pre-rerank
 * MMR ranking — recall quality may dip slightly but never breaks.
 *
 * Cost ceiling per call: ~$0.0001 (12 candidates × ~50 chars each + a
 * short prompt + a JSON array of floats out — total < 2k tokens at
 * Flash pricing).
 */
async function rerankWithFlash(args: {
  query: string;
  candidates: Array<{ role: 'user' | 'assistant'; content: string; createdAt: number }>;
}): Promise<number[] | null> {
  if (args.candidates.length === 0) return [];
  const apiKey = loadGeminiKey();
  if (!apiKey) return null;

  const lines: string[] = [];
  lines.push('あなたは記憶検索の再ランカーです。');
  lines.push('以下のユーザーの発話に対して、各候補メッセージがどれくらい関連しているかを 0 から 1 のスコアで評価してください。');
  lines.push('1.0 = 完全に関連、0.0 = 全く無関係。');
  lines.push('');
  lines.push(`## ユーザーの発話`);
  lines.push(args.query);
  lines.push('');
  lines.push('## 候補メッセージ');
  args.candidates.forEach((c, i) => {
    const ts = new Date(c.createdAt).toLocaleString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const speaker = c.role === 'user' ? '彼' : '私';
    const body = c.content.replace(/\s+/g, ' ').trim().slice(0, 300);
    lines.push(`[${i}] [${ts}] ${speaker}: ${body}`);
  });
  lines.push('');
  lines.push('## 出力');
  lines.push(
    `候補数と同じ長さの JSON 配列を一行で出力してください。例: ${JSON.stringify(args.candidates.map(() => 0.0))}`,
  );
  lines.push('説明や前置きは不要。JSON 配列のみ。');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${RERANK_MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
    safetySettings: RERANK_SAFETY_SETTINGS_ALL_OFF,
  };

  try {
    const res = await getHost().net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[recall] rerank HTTP ${res.status}; falling back to MMR order`);
      return null;
    }
    const json = (await res.json()) as RerankResponse;
    if (json.error?.message) {
      console.warn('[recall] rerank error:', json.error.message);
      return null;
    }
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const scores = parsed.map((v) => {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(1, n));
    });
    if (scores.length !== args.candidates.length) {
      console.warn(
        `[recall] rerank length mismatch: got ${scores.length} for ${args.candidates.length} candidates`,
      );
      return null;
    }
    return scores;
  } catch (err) {
    console.warn('[recall] rerank failed (falling back to MMR order):', err);
    return null;
  }
}

function bm25Search(args: {
  sessionId: string;
  query: string;
  beforeTimestamp: number;
}): Bm25Row[] {
  const match = buildFtsMatchExpression(args.query);
  if (!match) return [];
  try {
    const db = getDatabase();
    return db
      .prepare<[string, string, number, number], Bm25Row>(
        `SELECT m.id AS message_id, bm25(messages_fts) AS rank
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ?
            AND m.session_id = ?
            AND m.created_at < ?
          ORDER BY rank ASC
          LIMIT ?`,
      )
      .all(match, args.sessionId, args.beforeTimestamp, BM25_POOL_SIZE);
  } catch (err) {
    console.warn('[recall] BM25 search failed (falling back to cosine-only):', err);
    return [];
  }
}

function loadCandidateVectors(
  sessionId: string,
  beforeTimestamp: number,
): VectorRow[] {
  const db = getDatabase();
  return db
    .prepare<[string, number], VectorRow>(
      `SELECT v.message_id   AS message_id,
              v.embedding    AS embedding,
              v.dim          AS dim,
              m.role         AS role,
              m.content      AS content,
              m.created_at   AS created_at
         FROM message_vectors v
         JOIN messages m ON m.id = v.message_id
        WHERE v.session_id = ?
          AND m.created_at < ?
        ORDER BY m.created_at DESC`,
    )
    .all(sessionId, beforeTimestamp);
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0;
  // Both vectors are unit-length (L2-normalized at write time), so
  // dot = cos. This is the hot path; manual loop is faster than the
  // typed-array .reduce idiom.
  for (let i = 0; i < a.length; i += 1) {
    s += a[i]! * b[i]!;
  }
  return s;
}

/**
 * Embed any session messages that don't have a vector yet. Bounded
 * per call (`BACKFILL_BATCH_SIZE`) so a freshly-installed app on a
 * 5000-turn DB doesn't pay 5000 sequential round-trips on first boot.
 * Re-runs on every session activation; converges over a handful of
 * boots.
 *
 * Returns the number of new vectors written so the caller can decide
 * whether to schedule another pass on idle.
 */
export async function backfillSessionVectors(args: {
  sessionId: string;
  maxToProcess?: number;
}): Promise<number> {
  const db = getDatabase();
  const cap = Math.max(1, args.maxToProcess ?? BACKFILL_BATCH_SIZE);
  const rows = db
    .prepare<[string, number], BackfillRow>(
      `SELECT m.id AS id, m.content AS content, m.created_at AS created_at
         FROM messages m
    LEFT JOIN message_vectors v ON v.message_id = m.id
        WHERE m.session_id = ?
          AND v.message_id IS NULL
          AND length(trim(m.content)) > 0
        ORDER BY m.created_at ASC
        LIMIT ?`,
    )
    .all(args.sessionId, cap);

  if (rows.length === 0) return 0;

  let written = 0;
  for (const row of rows) {
    const vec = await embedText(row.content);
    if (!vec) {
      // No key or hard failure — bail the whole backfill. Trying the
      // remaining rows would just produce the same warning N more times.
      break;
    }
    storeMessageVector({
      messageId: row.id,
      sessionId: args.sessionId,
      vector: vec,
      createdAt: row.created_at,
    });
    written += 1;
    if (written < rows.length) {
      await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
    }
  }
  return written;
}

/** Total stored vectors for a session. Useful for diagnostics / Settings. */
export function countSessionVectors(sessionId: string): number {
  const db = getDatabase();
  const row = db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM message_vectors WHERE session_id = ?`,
    )
    .get(sessionId);
  return row?.c ?? 0;
}

/**
 * Convenience used by the [系統メモ] preamble formatter: turn a
 * recalled turn into a short Japanese-tagged block. Speakers are
 * labelled with the same convention as the `前回のやり取り` line
 * (`彼` = operator, `私` = Mio).
 *
 * Phase-11 M4 — if the recalled turn carries `before` / `after`
 * adjacent context (attached by `recallSimilarTurns`), render all three
 * lines so the model sees the matched message in its conversational
 * context. The matched line is prefixed with `→` so the model can see
 * which line was the actual semantic hit.
 */
function formatAdjacentLine(turn: AdjacentTurn): string {
  const ts = new Date(turn.createdAt).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const speaker = turn.role === 'user' ? '彼' : '私';
  let body = turn.content.replace(/\s+/g, ' ').trim();
  if (body.length > MAX_RECALL_BODY_CHARS) {
    body = `${body.slice(0, MAX_RECALL_BODY_CHARS - 1)}…`;
  }
  return `  [${ts}] ${speaker}: ${body}`;
}

// Light cap so a long old monologue doesn't dominate the section.
const MAX_RECALL_BODY_CHARS = 220;

export function formatRecalledTurnJa(turn: RecalledTurn): string {
  const ts = new Date(turn.createdAt).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const speaker = turn.role === 'user' ? '彼' : '私';
  let body = turn.content.replace(/\s+/g, ' ').trim();
  if (body.length > MAX_RECALL_BODY_CHARS) {
    body = `${body.slice(0, MAX_RECALL_BODY_CHARS - 1)}…`;
  }
  const matchedLine = `→ [${ts}] ${speaker}: ${body}`;
  if (!turn.before && !turn.after) return matchedLine;

  const lines: string[] = [];
  if (turn.before) lines.push(formatAdjacentLine(turn.before));
  lines.push(matchedLine);
  if (turn.after) lines.push(formatAdjacentLine(turn.after));
  return lines.join('\n');
}

// Re-export the dim so other callers (e.g. recall-aware Settings UI
// in the future) can sanity-check stored vectors without round-tripping
// through the embed module.
export { EMBED_DIM };
