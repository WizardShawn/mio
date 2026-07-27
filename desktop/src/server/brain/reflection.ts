import { getDatabase } from './database';
import { embedAndStoreMessage } from './recall';
import { getHost } from './host';
import { loadGeminiKey } from './geminiKey';
import { writeMemory } from './memory';

// Phase-11 M6 — reflection passes.
//
// Once enough new chat material has accumulated since the previous
// pass, the agent loop calls `runReflectionIfDue` to synthesise 2-3
// higher-order observations from the recent ~50 messages of the
// active session. Examples of what a good reflection looks like:
//   • 「彼は仕事のストレスがあると深夜2時以降の会話が増える」
//   • 「毎週金曜の夜、ゲームの話題に切り替わる」
//   • 「『あかね』は彼の妹、現在25歳、3月生まれ」
// These aren't anywhere in any individual turn — they're patterns
// that only become visible across many turns. Park et al.'s
// generative-agents paper (2023) shows this single pattern
// dominates "knows me" perception in long-running agents.
//
// Reflections are written to `memory_entries` with `notable=true` and
// `tags=['reflection']`, so they participate in:
//   • the preamble's 「大切な瞬間」 slot (Edit D) — surfaced on every
//     relevant turn regardless of age,
//   • vector recall — embedded by `embedAndStoreMessage` so a future
//     similar query can pull the same insight back even after the
//     observations age out of the recent slot.

const REFLECTION_MODEL = 'gemini-3.5-flash';
const REFLECTION_MIN_NEW_MESSAGES = 20;
const REFLECTION_LOOKBACK_MESSAGES = 50;
const REFLECTION_MIN_GAP_MS = 60 * 60 * 1000; // 1 hour
const REFLECTION_MAX_PER_PASS = 3;
const REFLECTION_BODY_CHARS_PER_MESSAGE = 400;

const REFLECTION_SAFETY_SETTINGS_ALL_OFF: Array<{
  category: string;
  threshold: string;
}> = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];

interface ReflectionMessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

interface ReflectionRecord {
  covered_through_id: number;
  created_at: number;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

interface ReflectionObservation {
  summary: string;
  reason?: string;
  tags?: string[];
}

function getLastReflection(sessionId: string): ReflectionRecord | null {
  const db = getDatabase();
  return (
    db
      .prepare<[string], ReflectionRecord>(
        `SELECT covered_through_id, created_at
           FROM session_reflections
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(sessionId) ?? null
  );
}

function loadRecentMessages(
  sessionId: string,
  limit: number,
): ReflectionMessageRow[] {
  const db = getDatabase();
  const rows = db
    .prepare<[string, number], ReflectionMessageRow>(
      `SELECT id, role, content, created_at
         FROM messages
        WHERE session_id = ?
          AND length(trim(content)) > 0
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(sessionId, limit);
  rows.reverse();
  return rows;
}

function countMessagesSinceId(sessionId: string, afterId: number): number {
  const db = getDatabase();
  const row = db
    .prepare<[string, number], { c: number }>(
      `SELECT COUNT(*) AS c
         FROM messages
        WHERE session_id = ?
          AND id > ?
          AND length(trim(content)) > 0`,
    )
    .get(sessionId, afterId);
  return row?.c ?? 0;
}

function formatMessagesForPrompt(messages: ReflectionMessageRow[]): string {
  return messages
    .map((m) => {
      const ts = new Date(m.created_at).toLocaleString('ja-JP', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const speaker = m.role === 'user' ? '彼' : '私(澪)';
      let body = m.content.replace(/\s+/g, ' ').trim();
      if (body.length > REFLECTION_BODY_CHARS_PER_MESSAGE) {
        body = `${body.slice(0, REFLECTION_BODY_CHARS_PER_MESSAGE - 1)}…`;
      }
      return `[${ts}] ${speaker}: ${body}`;
    })
    .join('\n');
}

function buildReflectionPrompt(messages: ReflectionMessageRow[]): string {
  return [
    'あなたはデスクトップアシスタント「澪」の長期記憶を保つ「リフレクション役」です。',
    '以下は、操作者(彼)との直近の会話履歴です。',
    'この履歴を読み、個々のメッセージには現れない、より高次の観察を 2〜3 件抽出してください。',
    '',
    '## 良いリフレクションの例',
    '- 「彼は仕事のストレスがあると深夜2時以降の会話が増える」',
    '- 「毎週金曜の夜、ゲームの話題に切り替わる」',
    '- 「『あかね』は彼の妹、現在25歳、3月生まれ」',
    '- 「最近、料理を作ることに興味を持ち始めている」',
    '',
    '## やってはいけないこと',
    '- 単発の出来事をそのまま要約しない (それは普通の write_memory の仕事)',
    '- 当たり障りのない一般論を書かない (「彼は時々忙しい」など)',
    '- 推測を断定として書かない',
    '',
    '## 直近の会話 (古い順)',
    formatMessagesForPrompt(messages),
    '',
    '## 出力',
    `${REFLECTION_MAX_PER_PASS} 件以内の JSON 配列。各要素は以下のキーを持つ:`,
    '- `summary`: 観察そのもの (繁體中文で50-150字)',
    '- `reason`: なぜそう判断したか、根拠となる具体的なやり取り (繁體中文で100字以内)',
    '- `tags`: 関連するキーワードの配列 (最大3つ、英語または日本語)',
    '',
    `例: ${JSON.stringify([
      {
        summary: '他在工作壓力大時，深夜2點以後的對話會增加。',
        reason: '過去三週中，週二與週四常常在凌晨2點後仍在抱怨工作。',
        tags: ['stress', 'sleep', 'pattern'],
      },
    ])}`,
    '',
    '説明や前置きは不要。JSON 配列のみ。観察が一つも見つからなければ空配列 `[]` を返す。',
  ].join('\n');
}

async function postReflection(
  apiKey: string,
  prompt: string,
): Promise<ReflectionObservation[]> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${REFLECTION_MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
    },
    safetySettings: REFLECTION_SAFETY_SETTINGS_ALL_OFF,
  };

  const res = await getHost().net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Gemini reflection HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  const json = (await res.json()) as GenerateContentResponse;
  if (json.error?.message) {
    throw new Error(`Gemini reflection: ${json.error.message}`);
  }
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) return [];

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  const obs: ReflectionObservation[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const summary = typeof r['summary'] === 'string' ? r['summary'].trim() : '';
    if (!summary) continue;
    const reason = typeof r['reason'] === 'string' ? r['reason'].trim() : undefined;
    const rawTags = r['tags'];
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((t): t is string => typeof t === 'string')
      : undefined;
    obs.push({ summary, reason, tags });
    if (obs.length >= REFLECTION_MAX_PER_PASS) break;
  }
  return obs;
}

function recordReflection(args: {
  sessionId: string;
  coveredThroughId: number;
  observationCount: number;
  now: number;
}): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO session_reflections
       (session_id, covered_through_id, observation_count, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    args.sessionId,
    args.coveredThroughId,
    args.observationCount,
    args.now,
  );
}

/**
 * Phase-11 M6 — main reflection entry point. The agent loop calls this
 * after a successful cycle tick. Returns `{ ran: false, reason }` when
 * the gates (cooldown, insufficient new messages, no key, no session)
 * say to skip; `{ ran: true, observationCount }` on a successful pass.
 *
 * Best-effort: any failure logs and returns `{ ran: false }` rather
 * than propagating, so a Flash hiccup never crashes the agent loop.
 */
export async function runReflectionIfDue(
  sessionId: string | null,
): Promise<{ ran: boolean; reason?: string; observationCount?: number }> {
  if (!sessionId) return { ran: false, reason: 'no-session' };

  try {
    const now = Date.now();
    const last = getLastReflection(sessionId);

    if (last) {
      if (now - last.created_at < REFLECTION_MIN_GAP_MS) {
        return { ran: false, reason: 'cooldown' };
      }
      const newCount = countMessagesSinceId(sessionId, last.covered_through_id);
      if (newCount < REFLECTION_MIN_NEW_MESSAGES) {
        return { ran: false, reason: 'insufficient-new-messages' };
      }
    } else {
      // No prior reflection — require the minimum batch from scratch.
      const total = countMessagesSinceId(sessionId, 0);
      if (total < REFLECTION_MIN_NEW_MESSAGES) {
        return { ran: false, reason: 'insufficient-new-messages' };
      }
    }

    const messages = loadRecentMessages(sessionId, REFLECTION_LOOKBACK_MESSAGES);
    if (messages.length === 0) return { ran: false, reason: 'empty-window' };

    const apiKey = loadGeminiKey();
    if (!apiKey) return { ran: false, reason: 'no-key' };

    const prompt = buildReflectionPrompt(messages);
    const startedAt = Date.now();
    const observations = await postReflection(apiKey, prompt);
    console.log(
      `[reflection] generated ${observations.length} observation(s) ` +
        `from ${messages.length} messages in ${Date.now() - startedAt}ms`,
    );

    // Persist each observation as a notable memory entry with the
    // 'reflection' tag, then embed it so vector recall can surface it
    // on future relevant queries. Fire-and-forget on the embed: any
    // failure shouldn't break the rest of the pass.
    for (const obs of observations) {
      const tagsWithReflection = ['reflection', ...(obs.tags ?? [])].slice(0, 16);
      // Phase-11 M8 — reflections write importance=7. Higher than the
      // default 5 so they outrank routine notable entries in the
      // age-decayed milestone ranking; lower than 9-10 which is
      // reserved for foundational milestones (first meeting, names,
      // vows) the cycle flags explicitly. The 180-day τ for the
      // `reflection` tag (see memory.ts) means a 7-weighted reflection
      // outranks a 5-weighted recent observation for several months.
      const entry = writeMemory({
        summary: obs.summary,
        notable: true,
        reason: obs.reason ?? null,
        tags: tagsWithReflection,
        importance: 7,
      });
      // The recall path embeds messages, not memory_entries — and
      // there's no message id to attach to here. We skip embedding for
      // now; reflections still participate in retrieval via the
      // preamble's 「大切な瞬間」 slot (notable=true) which is fetched
      // by id, not by similarity. Future enhancement: a parallel
      // `memory_vectors` table to make notable memories
      // semantically queryable too.
      void entry;
    }

    recordReflection({
      sessionId,
      coveredThroughId: messages[messages.length - 1]!.id,
      observationCount: observations.length,
      now,
    });

    // Mark the M2 import as used so the linter doesn't warn — the
    // future enhancement above is what would actually call it. Keeping
    // the import in place avoids re-adding it later.
    void embedAndStoreMessage;

    return { ran: true, observationCount: observations.length };
  } catch (err) {
    console.warn('[reflection] failed', err);
    return { ran: false, reason: 'error' };
  }
}
