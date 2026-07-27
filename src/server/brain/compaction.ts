import { loadGeminiKey } from './geminiKey';
import { getDatabase } from './database';
import { getHost } from './host';

// Phase 6.5 — rolling per-session compaction.
//
// May 2026 — Google shipped Gemini 3.5 Flash, which Google's own
// benchmark table positions at "near-Pro level reasoning at Flash-tier
// cost and speed" (https://blog.google/innovation-and-ai/models-and-
// research/gemini-models/gemini-3-5/). Compaction is a per-session
// summarisation pass that runs on a rolling cadence; it does not need
// Pro-level depth and benefits from the 4x output-token-per-second
// speedup. Swapping pro-preview → 3.5-flash drops the per-pass spend
// to ~10% of pro pricing without a quality regression on the JSON-bag
// summary contract this module produces.
const COMPACTION_MODEL = 'gemini-3.5-flash';

const COMPACTION_SAFETY_SETTINGS_ALL_OFF: Array<{
  category: string;
  threshold: string;
}> = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];

// Phase-10 — sliding-window compaction parameters. The hard replay
// window in chatService.ts is 70 messages (35 pairs); this module
// summarises the *next* 140 messages back from there. Messages older
// than 70+140=210 fall out of the summary entirely and live only in
// vector recall (recall.ts). The summary itself stays at 1,200 chars
// — the operator's directive was "fine-tune scope, not volume", so the
// model now compresses a fixed 140-message slice each time the window
// shifts, instead of accumulating every old message into a 1,200-char
// bag forever.
const MAX_SUMMARIZED_MESSAGES = 140;
// Re-summarize only when the window has slid by this many messages
// since the last pass. Smaller = fresher summary, more Flash calls.
// 20 means ~1 pass per ~20 chat turns; well below the rate at which
// the hard-window shifts content out (which happens 1 msg/turn).
const SHIFT_THRESHOLD_MESSAGES = 20;
const MAX_SUMMARY_CHARS = 1200;
const MAX_MESSAGE_BODY_CHARS = 600;

export interface SessionCompaction {
  sessionId: string;
  summary: string;
  /** Oldest message id the current summary covers (lower bound of the window). */
  coveredFromId: number;
  /** Newest message id the current summary covers (upper bound = just below the hard window). */
  coveredThroughId: number;
  /** How many messages are in the current 140-msg sliding window (≤ MAX_SUMMARIZED_MESSAGES). */
  messageCount: number;
  updatedAt: number;
}

interface CompactionRow {
  session_id: string;
  summary: string;
  covered_from_id: number;
  covered_through_id: number;
  message_count: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

export function getCompactionSummary(sessionId: string): SessionCompaction | null {
  const db = getDatabase();
  const row = db
    .prepare<[string], CompactionRow>(
      `SELECT session_id, summary, covered_from_id, covered_through_id, message_count, updated_at
         FROM session_compactions
        WHERE session_id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    summary: row.summary,
    coveredFromId: row.covered_from_id,
    coveredThroughId: row.covered_through_id,
    messageCount: row.message_count,
    updatedAt: row.updated_at,
  };
}

function upsertCompaction(args: {
  sessionId: string;
  summary: string;
  coveredFromId: number;
  coveredThroughId: number;
  messageCount: number;
  now: number;
}): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO session_compactions
       (session_id, summary, covered_from_id, covered_through_id, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       summary = excluded.summary,
       covered_from_id = excluded.covered_from_id,
       covered_through_id = excluded.covered_through_id,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at`,
  ).run(
    args.sessionId,
    args.summary.slice(0, MAX_SUMMARY_CHARS),
    args.coveredFromId,
    args.coveredThroughId,
    args.messageCount,
    args.now,
  );
}

/**
 * Phase-10 — load the 140-message sliding window that sits immediately
 * past the hard replay window. `hardWindowSize` is the number of
 * messages chatService.ts replays verbatim (currently 70); the summary
 * covers the next `MAX_SUMMARIZED_MESSAGES` (140) messages back from
 * there. Messages older than that boundary are excluded — they live in
 * vector recall only.
 *
 * Returns the slice in chronological order so the prompt reads
 * front-to-back like a normal conversation. Empty array if the session
 * is too young to have anything outside the hard window yet.
 */
function loadSummaryWindow(args: {
  sessionId: string;
  hardWindowSize: number;
}): MessageRow[] {
  const db = getDatabase();
  // Find the upper bound: the oldest message id INSIDE the hard window.
  // Anything strictly older than that is a candidate for the summary.
  const upper = db
    .prepare<[string, number], { id: number }>(
      `SELECT id FROM messages
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1 OFFSET ?`,
    )
    .get(args.sessionId, Math.max(0, args.hardWindowSize - 1));
  if (!upper) return [];

  // Take up to MAX_SUMMARIZED_MESSAGES messages strictly older than
  // the hard window's oldest, newest first, then reverse so the prompt
  // reads chronologically.
  const rows = db
    .prepare<[string, number, number], MessageRow>(
      `SELECT id, role, content, created_at
         FROM messages
        WHERE session_id = ?
          AND id < ?
          AND length(trim(content)) > 0
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(args.sessionId, upper.id, MAX_SUMMARIZED_MESSAGES);
  rows.reverse();
  return rows;
}

function formatPendingForPrompt(messages: MessageRow[]): string {
  return messages
    .map((m) => {
      const ts = new Date(m.created_at).toLocaleString('ja-JP', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const speaker = m.role === 'user' ? '彼' : '澪';
      let body = m.content.replace(/\s+/g, ' ').trim();
      if (body.length > MAX_MESSAGE_BODY_CHARS) {
        body = `${body.slice(0, MAX_MESSAGE_BODY_CHARS - 1)}…`;
      }
      return `[${ts}] ${speaker}: ${body}`;
    })
    .join('\n');
}

/**
 * Phase-10 — sliding-window prompt. The model summarises the entire
 * 140-message window from scratch every pass; there is no "previous
 * summary to update" because the window shifts forward and old material
 * at the trailing edge legitimately needs to drop out, not be carried
 * forward. The whole purpose of the redesign was to stop the deep past
 * from compressing toward zero inside a perpetually-growing-yet-capped
 * summary.
 */
function buildCompactionPrompt(args: { window: MessageRow[] }): string {
  const block = formatPendingForPrompt(args.window);
  return [
    'あなたはデスクトップアシスタント「澪」の中期記憶を維持しています。',
    'ここでは、ハード記憶窓(直近70メッセージ)からこぼれ落ちた、',
    `その直前の最大${MAX_SUMMARIZED_MESSAGES}メッセージを一つの要約にまとめ直します。`,
    '毎回ゼロから書き直すスライディング窓なので、以前の要約を引き継ぐ必要はありません。',
    '',
    '## 要約する会話 (古い順)',
    block,
    '',
    '## 指示',
    '上の会話を読み、最新の要約を作成してください。',
    '- 重要な事実、進行中の話題、約束、操作者の好み、感情の流れは保持。',
    '- 単純な挨拶、相槌、雑談は省略。',
    '- 自然な日本語で、箇条書きでも段落でも構いません。',
    `- 全体で ${MAX_SUMMARY_CHARS} 文字以内。`,
    '- 出力は「要約」だけ。前置きや説明、ラベルは不要。',
  ].join('\n');
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

async function postSummarize(
  apiKey: string,
  prompt: string,
): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${COMPACTION_MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'text/plain',
    },
    safetySettings: COMPACTION_SAFETY_SETTINGS_ALL_OFF,
  };

  const res = await getHost().net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Gemini compaction HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }

  const json = (await res.json()) as GenerateContentResponse;
  if (json.error?.message) {
    throw new Error(`Gemini compaction: ${json.error.message}`);
  }

  const cand = json.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const summaryText = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!summaryText) {
    const fr = cand?.finishReason ?? '(unknown)';
    throw new Error(
      `Gemini compaction returned empty text (finishReason=${fr}).`,
    );
  }
  return summaryText;
}

export async function runCompactionIfNeeded(args: {
  sessionId: string;
  replayWindowSize: number;
}): Promise<{ updated: boolean; reason?: string }> {
  try {
    const window = loadSummaryWindow({
      sessionId: args.sessionId,
      hardWindowSize: args.replayWindowSize,
    });
    if (window.length === 0) {
      // Either the session is younger than the hard window, or the hard
      // window covers everything in the session — no summary needed.
      return { updated: false, reason: 'no-window' };
    }

    const existing = getCompactionSummary(args.sessionId);
    const newFromId = window[0]!.id;
    const newThroughId = window[window.length - 1]!.id;

    // Phase-10 — only re-summarize when the window has *meaningfully*
    // shifted. The hard window advances by 1 with every new turn, so
    // the summary window's lower bound also advances by 1 every turn;
    // re-running a 140-message Flash call on every turn would be ~2-3
    // orders of magnitude more cost than the operator's daily cap can
    // absorb. SHIFT_THRESHOLD_MESSAGES = 20 means we re-summarize
    // roughly every ~20 turns (≈ 1 pass per ~3 minutes of active
    // chat), which is fresh enough that the rolling summary never
    // drifts more than ~10% out of date.
    if (existing) {
      const upperShift = Math.abs(newThroughId - existing.coveredThroughId);
      const lowerShift = Math.abs(newFromId - existing.coveredFromId);
      const maxShift = Math.max(upperShift, lowerShift);
      if (maxShift < SHIFT_THRESHOLD_MESSAGES) {
        return { updated: false, reason: 'window-stable' };
      }
    }

    const apiKey = loadGeminiKey();
    if (!apiKey) {
      console.warn(
        '[compaction] no Gemini API key configured — skipping compaction',
      );
      return { updated: false, reason: 'no-key' };
    }

    // Phase-10 — re-summarize the whole sliding window from scratch.
    // No "existing summary to extend" because old content at the
    // trailing edge needs to drop out, not be carried forward — that's
    // the entire point of the sliding-window redesign.
    const prompt = buildCompactionPrompt({ window });

    const startedAt = Date.now();
    const newSummary = await postSummarize(apiKey, prompt);
    console.log(
      `[compaction] re-summarized sliding window of ${window.length} messages ` +
        `(ids ${newFromId}..${newThroughId}) in ${Date.now() - startedAt}ms ` +
        `(${newSummary.length} chars)`,
    );

    upsertCompaction({
      sessionId: args.sessionId,
      summary: newSummary,
      coveredFromId: newFromId,
      coveredThroughId: newThroughId,
      messageCount: window.length,
      now: Date.now(),
    });
    return { updated: true };
  } catch (err) {
    console.warn('[compaction] failed', err);
    return { updated: false, reason: 'error' };
  }
}
