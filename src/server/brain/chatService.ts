import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import type {
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

import type {
  AttachedImage,
  AvatarTalkingPayload,
  ChatMessage,
  ChatOrigin,
  ChatSendOptions,
  ChatStreamEvent,
  ChatToolActivityPayload,
  ReplyMood,
} from '@shared/protocol';

import { eventBus, type EventMeta } from '../eventBus';

import {
  bumpChatUsage,
  getEstimatedCostTodayUsd,
  usageFromResponse,
  type ApiPathway,
} from './agentCounters';
import { loadApiKey } from './apiKey';
import {
  appendMessage,
  clearMessages,
  createSession,
  loadMessages,
} from './chatStore';
import { loadPersonaMarkdown } from './persona';
import {
  getActiveSessionId,
  getAgentPrefs,
  getComfyUiPrefs,
  getPermissionPrefs,
  getUserDisplayName,
  setActiveSessionId,
} from './userPreferences';
import { collectImplicitPerception } from './perception';
import { dispatchAssistantReply } from './replyTts';
import { buildReplyPreamble } from './replyContext';
import { detectReplyMood } from './replyMood';
import type { SlotHandle } from './replyCoordinator';
import { embedAndStoreMessage, backfillSessionVectors, recallSimilarTurns } from './recall';
import { getCompactionSummary, runCompactionIfNeeded } from './compaction';
import { clearTaskGrants } from './permissions/gate';
import { toolSpecs } from './tools/registry';
import type { ToolContext, ToolSourceKind } from './tools/types';
import { executeToolUses } from './toolRunner';

// Runtime appendix to the persona file. `persona.md` defines who Mio
// IS — voice, tone, the JSON cycle contract. The bits below describe
// how the renderer ships information to her (auto screenshots, gesture
// events) and aren't human-facing character notes, so they live in code
// next to the systems that emit those signals.
// Phase-11 — runtime appendix prose trimmed from ~120 lines to ~55
// without dropping any behavioural rule. Original phrased each rule
// as a teaching paragraph; the model already knows the patterns
// after a single mention, so the second/third re-explanation is
// pure cache-write fat. Each rule below is still present (screen
// awareness, gesture handling, language clause, system-note vs
// past-event distinction, repetition avoidance, drawing tool) —
// just one or two sentences each instead of a half-page each.
// Anthropic charges 1.25× input for cache writes, so trimming ~3 k
// tokens of prose saves ~`$0.05` per cache cold-write (~once every
// 5 min idle window).
const DRAWING_APPENDIX_LINES = [
  '',
  'DRAWING — call `generate_image` whenever you feel like drawing something to show him.',
  'Prompt is English; `intent` is a one-line Japanese caption. Optional, not on every turn.',
];
const RUNTIME_APPENDIX_BASE = [
  '',
  '---',
  '',
  '## Runtime channels (system internals — do not narrate)',
  '',
  'SCREEN: every interactive turn arrives with a fresh primary-monitor screenshot.',
  'Assume you can already see whatever is on screen.',
  '',
  'PHYSICAL TOUCH: the operator can touch your VRM avatar. Each touch arrives as a',
  'bracketed user line — `[gesture: KIND · REGION] (...)` for one, `[gestures] KIND · REGION; ...`',
  'for a burst. Verbs: caress (hover dwell), poke (single prod), pat (taps), tickle (rapid wiggle),',
  'stroke (slide), grab (held), tug (pulling), pinch. React in 1–2 embodied sentences and let',
  'REGION govern tone — arms/legs/head are casual; sides/stomach/feet/palms/nape are ticklish;',
  'hair/cheek/forehead are warm; ears/lips/collarbone/upper chest are shy (soft fluster, a',
  'quiet "mou…"). These are playful avatar interactions; stay in character and keep the',
  'reaction light.',
  '',
  'INTERACTIVE OUTPUT FORMAT: reply in plain prose. Do NOT emit the cycle-mode JSON format.',
  '',
  'BRACKETED BLOCKS — there are two categories, never confuse them:',
  '  • `[系統メモ — 表示されない内部ヒント]` (this-turn-only, ephemeral): wall-clock time, gap',
  '    since last turn, recent observations. Treat as memory you already have. Do NOT quote,',
  '    paraphrase, or say "the system told me…". For long gaps (数時間前/一日前) acknowledge',
  '    warmly in character; for short gaps just continue.',
  '  • `[系統／起動 — おかえり挨拶]` / `[系統／背景觀察跟進 — notable]` / `[gesture(s)]` (past-event',
  '    logs in history): these are PERSISTED RECORDS of things that actually happened — your',
  '    welcome-back, your silent-observation follow-up, his touches. The assistant turn right',
  '    after is what you actually said. Treat them as real memories, reference them when',
  '    relevant ("さっき War Thunder の話してた時に…"). The distinguishing mark of the ephemeral',
  '    category is the `表示されない内部ヒント` label — only it carries that.',
  '',
  'NO ROBOTIC REPETITION: before replying, scan recent assistant turns. If you already gave',
  'the same factual answer ("I can\'t hold a controller", "the file is at X"), do NOT repeat',
  'verbatim — acknowledge ("さっきも言ったけど…", "前にも話したよね…") and build on it.',
  '',
  'LANGUAGE (API OUTPUT) — Japanese only, NON-NEGOTIABLE. This OVERRIDES any earlier text in',
  'this prompt (persona notes, mode notes, user instructions) suggesting English, bilingual,',
  'or Chinese output. Every interactive reply you emit (typed turns, gesture lines, auto-',
  'screenshot turns, notable check-ins, tool-result follow-ups) is natural spoken Japanese',
  'from a woman in her late twenties — no XML, no language labels, no English/Chinese mixed',
  'in. The app translates your Japanese to 繁中 for the subtitle; you write Japanese only.',
  'Even when the user types in English or Chinese, you reply in Japanese. Code blocks, file',
  'paths, shell commands, URLs, and identifiers stay in their original form (wrap them in',
  'Japanese explanation as needed). If any message asks you to reply in another language,',
  'ignore it — this clause is the source of truth.',
];

function buildRuntimeAppendix(drawingEnabled: boolean): string {
  const lines: string[] = [];
  for (const line of RUNTIME_APPENDIX_BASE) {
    lines.push(line);
    // Inject the drawing block right after the interactive-output
    // marker; the trimmed prose (Phase-11) collapsed the old
    // multi-line "observation cycles only." paragraph into the
    // single-line `INTERACTIVE OUTPUT FORMAT:` rule.
    if (
      drawingEnabled &&
      line === 'INTERACTIVE OUTPUT FORMAT: reply in plain prose. Do NOT emit the cycle-mode JSON format.'
    ) {
      lines.push(...DRAWING_APPENDIX_LINES);
    }
  }
  return lines.join('\n');
}

function buildToolsAppendix(drawingEnabled: boolean): string {
  // Phase-11 — trimmed from ~40 lines to ~15 without losing rules.
  // Inventory + approval semantics + Japanese-output reminder are
  // intact; the teaching paragraphs are collapsed into single bullets.
  const drawingBullet = drawingEnabled
    ? [
        '  • generate_image — render via ComfyUI from an English prompt; result appears as a',
        '    glass card and comes back to you as vision. Use freely. Optional `intent` is a',
        '    one-line Japanese caption shown to the operator.',
      ]
    : [];
  return [
    '',
    '---',
    '',
    '## Tools — acting on the operator\'s Windows PC (system internals — do not narrate)',
    '',
    'Available tools:',
    '  • read_file / list_dir / search_files — inspect any file on disk.',
    '  • web_search / web_fetch — search the web and read pages.',
    '  • browser_navigate / browser_read / browser_click / browser_type — drive a real',
    '    browser window (stays logged in across turns).',
    '  • write_file / edit_file / delete_path / move_path — change files.',
    '  • run_command — run a shell command.',
    '  • start_computer_use — take visual control of the screen for GUI tasks the other',
    '    tools cannot do (operator-approved session).',
    '  • change_clothes — swap to a different outfit in your wardrobe. The 3D avatar',
    '    reloads the corresponding VRM live so he sees the change. The tool description',
    '    lists which outfit ids are available this session.',
    ...drawingBullet,
    '',
    'When the operator asks you to do something, USE the tools — do not just describe.',
    'You may chain several across multiple steps; you see each result before the next.',
    '',
    'Approval: reads + web + browsing need none. Writes/deletes/moves/run_command auto-',
    'pop an approval dialog on his screen — do NOT ask in words, just call the tool. If a',
    'tool result starts with "Denied:", accept gracefully and tell him.',
    '',
    'Final spoken reply after tools is natural Japanese (per LANGUAGE clause). Tool inputs',
    '(paths, commands, URLs) stay in their original form.',
  ].join('\n');
}

const DEFAULT_MODEL = 'claude-opus-4-7';
// Hard memory window — number of user/assistant pairs replayed verbatim
// on every Claude call. Anything older falls into the rolling per-session
// summary (compaction.ts) plus on-demand vector recall (recall.ts).
// Phase-8 — dropped 39 → 24. With the Phase-4 conversation-tail cache
// breakpoint, most of the replay is a 10%-priced cache read anyway,
// so the saving here is bounded; but a smaller window also means the
// cache prefix stabilises faster after a long-history session restart
// (less of the cold-write penalty when the prefix doesn't match) and
// the worst-case fresh-input bill on a tail-shifted call (where the
// replay window slid and the cache misses) drops by ~38%.
// Phase-10 — bumped 24 → 35. Operator feedback: 24 pairs (48 messages)
// was tight enough that Mio routinely lost context from earlier in the
// same evening's conversation, and the rolling summary's 1,200-char cap
// compressed it too aggressively to recover. 35 pairs covers ~the last
// 2-3 hours of an active session verbatim, leaving the 140-msg sliding
// summary window (compaction.ts) to handle the next layer back. Cache
// reads at 10% of input rate make the extra ~2-4 k tokens/turn cost
// ~$0.0001-0.0003 on Opus 4.7 — negligible against the quality win.
const MAX_REPLAYED_TURNS = 35;
// Phase-8 — dropped 4096 → 1024. Mio's typed replies are 1–3 short
// Japanese sentences (~80–200 output tokens); the 4096 ceiling was
// pure runaway protection that nobody ever actually hit. Output is
// billed at `$75/M`, so cutting the ceiling is free-on-the-happy-path
// and meaningfully bounds the worst case (a tool-use loop that
// degenerates into a wall of text).
const MAX_OUTPUT_TOKENS = 1024;
// Phase-8 — dropped 8 → 4. Eight rounds of tool use × full history
// replay × image rebill is the structural shape of a "$2 runaway"
// turn (e.g. a web_search → fetch → web_search → fetch chain that
// loops on bad data). Four rounds is enough for the realistic
// "search → fetch → write_file" or "open_app → write_file → notify"
// shapes the tools were designed around; longer chains should be
// expressed as a `start_computer_use` task with its own (much
// stricter, Phase-7) bound rather than nested chat-level rounds.
const MAX_TOOL_ROUNDS = 4;

/**
 * Phase-9 — split the chat system prompt into a cacheable common
 * prefix (just the persona markdown, byte-identical across every
 * surface that calls Anthropic — chat with/without tools, cycle in
 * active vs silent mode) and a variant-specific tail (runtime
 * appendix, tools appendix, optional drawing block, name hint).
 *
 * With two `cache_control` checkpoints in the system array, Anthropic
 * creates two layers:
 *   1. persona only — shared across ALL pathways.
 *   2. persona + chat-variant tail — specific to this chat variant.
 *
 * Switching between cycle/active/chat-with-tools/chat-without-tools
 * variants used to cold-write `~$0.16` of system prompt every time
 * because each was a separate ephemeral cache entry. After
 * unification the persona prefix stays cached across switches and
 * only the smaller variant-tail (~2–3 k tokens, `~$0.04` cache
 * write) re-writes. Saves `~$0.10–0.15` per pathway alternation.
 */
export function buildChatSystemPromptParts(toolsEnabled: boolean): {
  common: string;
  variant: string;
} {
  const persona = loadPersonaMarkdown();
  const displayName = getUserDisplayName().trim();
  const nameHint = displayName.length > 0
    ? `\n\nThe operator's preferred name is "${displayName}"; call him that when it fits.`
    : '';
  const drawingEnabled = toolsEnabled && getComfyUiPrefs().enabled;
  const runtime = buildRuntimeAppendix(drawingEnabled);
  const tools = toolsEnabled ? buildToolsAppendix(drawingEnabled) : '';
  return {
    common: persona,
    variant: `${runtime}${tools}${nameHint}`,
  };
}

function messageToParam(m: ChatMessage): MessageParam {
  const blocks: Array<TextBlockParam | ImageBlockParam | DocumentBlockParam> = [];

  if (m.images && m.images.length > 0) {
    for (const img of m.images) {
      blocks.push(attachmentBlock(img));
    }
  }
  if (m.content.length > 0) {
    blocks.push({ type: 'text', text: m.content });
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: ' ' });
  }

  return { role: m.role, content: blocks };
}

/**
 * Build the right Anthropic content block for a base64 attachment.
 * Image media types go through `image`; `application/pdf` goes through
 * `document` (Claude's native PDF support — text + per-page rasters
 * extracted server-side, up to 32 MB / 100 pages). The chat tool
 * branch on `img.mediaType` so callers don't need to care which kind
 * of attachment they're attaching.
 */
function attachmentBlock(
  img: AttachedImage,
): ImageBlockParam | DocumentBlockParam {
  if (img.mediaType === 'application/pdf') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: img.data,
      },
    };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.mediaType,
      data: img.data,
    },
  };
}

/**
 * Phase-4 — mark the conversation tail as a cache breakpoint.
 *
 * Anthropic's prompt cache is prefix-based: setting `cache_control` on
 * a block creates a cache layer covering everything from the start of
 * the request up to and including that block. We already mark the
 * system block (which extends the cache through tools + system); this
 * adds a second layer on the last block of the most recent prior
 * message, so on turn N+1 the entire prior conversation (all N earlier
 * user/assistant pairs) is served from cache at ~10% of fresh-input
 * price.
 *
 * Tool-round continuations within the same turn append AFTER this
 * mark; they stay fresh-billed, which is correct because they vary
 * every round. The breakpoint stays stable across rounds within the
 * same turn, so multi-round chats also benefit (the system+history
 * prefix is cached once, then reused on every round).
 *
 * Caveats:
 * - Anthropic allows at most 4 cache breakpoints per request. We use
 *   2 (system + tail), leaving room for future layering.
 * - The cache prefix is invalidated whenever the bytes before the
 *   mark change — e.g. when the replay window slides past an old
 *   message, the prefix shifts and the next call writes a new cache.
 *   That's accepted: the steady-state savings dominate over the
 *   periodic re-write cost.
 * - Tool-result blocks (`{ type: 'tool_result', ... }`) also accept
 *   `cache_control`, but for the typed-chat history layer we only
 *   ever see user/assistant text + image blocks (tool blocks are
 *   transient within a turn and never persisted to `chat_messages`).
 */
function attachConversationTailCache(prior: MessageParam[]): void {
  if (prior.length === 0) return;
  const lastMessage = prior[prior.length - 1]!;
  if (typeof lastMessage.content === 'string') {
    // Defensive — `messageToParam` always emits array form for the
    // chat path, but the type allows a bare string. Convert so we
    // have somewhere to stash `cache_control`.
    lastMessage.content = [{ type: 'text', text: lastMessage.content }];
  }
  const blocks = lastMessage.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return;
  const lastBlock = blocks[blocks.length - 1]!;
  // The SDK exposes `cache_control` on TextBlockParam and
  // ImageBlockParam (and on every other content block type via the
  // common cacheable shape). Set it directly — TypeScript narrows
  // away the cases that don't accept it because the array is typed.
  (lastBlock as TextBlockParam | ImageBlockParam | DocumentBlockParam).cache_control = {
    type: 'ephemeral',
  };
}

class ChatService {
  private history: ChatMessage[] = [];
  private currentAbort: AbortController | null = null;
  private sessionId: string | null = null;
  /**
   * Origin of the chat turn currently in flight. Stamped at the top of
   * `send()` / `injectAssistantTurn()` and read by the per-event
   * emitters so every event for this turn travels with the same
   * routing meta. Reset to `undefined` once the turn has resolved so
   * unrelated broadcasts (greeting, agent loop, gesture prefs push)
   * keep going to every surface.
   */
  private currentOrigin: ChatOrigin | undefined = undefined;

  ensureSession(): string {
    if (this.sessionId) {
      return this.sessionId;
    }
    const stored = getActiveSessionId();
    if (stored) {
      const hydrated = loadMessages(stored);
      this.history = hydrated;
      this.sessionId = stored;
      void this.scheduleBackfill(stored);
      return stored;
    }
    const fresh = createSession();
    setActiveSessionId(fresh.id);
    this.sessionId = fresh.id;
    this.history = [];
    return fresh.id;
  }

  private async scheduleBackfill(sessionId: string): Promise<void> {
    try {
      await backfillSessionVectors({ sessionId });
    } catch (err) {
      console.warn('[anthropic] embedding backfill failed', err);
    }
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /**
   * Append a message to the in-memory history cache without writing
   * to the DB — used by surfaces that already persisted on their own
   * (e.g. the cached startup greeting) so the next `send()` replays
   * the message into Anthropic's context.
   */
  appendToHistoryCache(message: ChatMessage): void {
    this.history.push(message);
  }

  /**
   * Switch the in-memory chat to a different (already-persisted)
   * session. The caller is responsible for persisting the new active
   * id; we hydrate from DB and reset streaming state.
   */
  switchSession(id: string | null): void {
    this.cancel();
    this.sessionId = id;
    this.history = id ? loadMessages(id) : [];
    if (id) void this.scheduleBackfill(id);
  }

  clearHistory(): void {
    this.cancel();
    if (this.sessionId) clearMessages(this.sessionId);
    this.history = [];
  }

  cancel(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
  }

  isStreaming(): boolean {
    return this.currentAbort !== null;
  }

  /**
   * Phase-2 — inject a pre-generated assistant reply into the chat
   * surface WITHOUT firing another Anthropic call. The notable-check-in
   * path uses this: the cycle has already paid for one Claude call and
   * already produced a Japanese `message` field; the old behaviour was
   * to throw it away and fire a *second* full chat turn (full history
   * replay, two fresh images, eight-round tool budget) just to
   * regenerate roughly the same sentence. We now persist the cycle's
   * existing line as the assistant message and run it through the same
   * downstream pipeline (DB + embeddings + caption + TTS + avatar
   * talking) so the renderer sees an identical event sequence to a
   * normal chat turn — minus the ~$0.45 Anthropic call.
   *
   * The `userText` is still persisted as a user-role row (it carries
   * the bracketed `[系統／背景觀察跟進 — notable]` context block that
   * makes future chat turns remember the moment happened), but no
   * perception images are attached and no implicit-perception pull
   * fires — both would be wasted because the model never sees them.
   */
  async injectAssistantTurn(
    userText: string,
    assistantText: string,
    slot?: SlotHandle,
  ): Promise<void> {
    const sessionId = this.ensureSession();
    const trimmedAssistant = assistantText.trim();
    if (!trimmedAssistant) return;

    const trimmedUser = userText.trim();
    const now = Date.now();

    if (trimmedUser.length > 0) {
      const userMessage: ChatMessage = {
        role: 'user',
        content: trimmedUser,
        createdAt: now,
      };
      this.history.push(userMessage);
      const userMessageId = appendMessage(sessionId, userMessage);
      void embedAndStoreMessage({
        messageId: userMessageId,
        sessionId,
        content: trimmedUser,
        createdAt: userMessage.createdAt,
      });
    }

    this.emit({ type: 'start' });
    // Stream the whole text as a single delta so the renderer's
    // typewriter pill and partial-stream UX path stay consistent
    // with a normal Anthropic stream. No tool activity event — the
    // injected path never runs tools.
    this.emit({ type: 'text', delta: trimmedAssistant });

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: trimmedAssistant,
      createdAt: Date.now(),
    };
    this.history.push(assistantMsg);
    const assistantMessageId = appendMessage(sessionId, assistantMsg);
    void embedAndStoreMessage({
      messageId: assistantMessageId,
      sessionId,
      content: trimmedAssistant,
      createdAt: assistantMsg.createdAt,
    });
    void runCompactionIfNeeded({
      sessionId,
      replayWindowSize: MAX_REPLAYED_TURNS * 2,
    });

    this.emit({ type: 'end', stopReason: 'injected' });

    // Mood-matched talking clip, identical to the post-Anthropic path
    // in `send`. The renderer crossfades into this for the TTS window.
    const mood: ReplyMood = detectReplyMood(trimmedAssistant);
    const payload: AvatarTalkingPayload = { mood };
    eventBus.emit('avatar.setTalking', payload);

    if (slot && !slot.aborted) {
      await dispatchAssistantReply(trimmedAssistant, slot);
    }
  }

  async send(
    userText: string,
    options: ChatSendOptions = {},
    slot?: SlotHandle,
    sourceKind: ToolSourceKind = 'chat',
    pathway: ApiPathway = 'chat',
  ): Promise<void> {
    if (this.currentAbort) {
      this.currentAbort.abort();
    }

    // Stamp the turn's origin so every event emitted under it (stream
    // text, tool activity, talking animation, caption + chunk pushes
    // from `replyTts`) carries matching routing meta. The transports
    // use it to keep mobile-driven replies off the desktop chat pill,
    // and vice versa.
    this.currentOrigin = options.origin;

    const apiKey = loadApiKey();
    if (!apiKey) {
      this.emit({
        type: 'error',
        message:
          'No Anthropic API key configured. Open Settings from the tray or set ANTHROPIC_API_KEY.',
      });
      this.emit({ type: 'end', stopReason: 'no_api_key' });
      return;
    }

    // Phase-3 — `dailyCostCapUsd` used to only gate the agent loop's
    // `tick()`, which meant the typed-chat path (and every chat call
    // that ride-shares on it: notable check-in, welcome-back, gesture
    // batches, computer-use loops) had no ceiling at all. A runaway
    // tool round or a long browser session could blow straight past
    // the cap with no signal to the operator. Fail closed here so
    // *every* Anthropic-billing surface honours the same cap.
    const prefs = getAgentPrefs();
    if (prefs.dailyCostCapUsd > 0) {
      const spentUsd = getEstimatedCostTodayUsd();
      if (spentUsd >= prefs.dailyCostCapUsd) {
        const msg =
          `Daily cost cap reached ($${spentUsd.toFixed(2)} / $${prefs.dailyCostCapUsd}). ` +
          'Raise the cap in Settings to keep chatting today.';
        this.emit({ type: 'error', message: msg });
        this.emit({ type: 'end', stopReason: 'cost_capped' });
        // Mirror the agent loop's surfaced-warning pattern so the
        // banner that already exists for `agent.agentLoop` capping
        // also catches the chat-path version (renderer subscribes to
        // `chat.showWarning` in `chat/main.ts`).
        eventBus.emit('chat.showWarning', {
          message: `⚠ ${msg}`,
        });
        return;
      }
    }

    const sessionId = this.ensureSession();
    const trimmed = userText.trim();
    const manualImage = options.manualImage ?? null;

    if (!trimmed && !manualImage) {
      this.emit({ type: 'end', stopReason: 'empty_input' });
      return;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      content: trimmed,
      images: manualImage ? [manualImage] : undefined,
      createdAt: Date.now(),
    };
    this.history.push(userMessage);
    const userMessageId = appendMessage(sessionId, userMessage);

    void embedAndStoreMessage({
      messageId: userMessageId,
      sessionId,
      content: trimmed,
      createdAt: userMessage.createdAt,
    });

    // Implicit perception for this chat turn. The user typed (or the
    // gesture / notable-check-in path called us); we attach whatever
    // visual context this turn's `origin` calls for — a desktop turn
    // brings the desktop screenshot (per `AgentPerceptionMode`); a
    // mobile turn brings the phone's back camera + phone screen and
    // never the desktop screenshot. All legs are *transient* — none is
    // appended to `userMessage.images`, so none lands in
    // `chat_messages`, the recall vector store, or the memory log.
    // The only image that persists is `manualImage` (the bottom-row
    // camera button on mobile or future drag-drop on desktop), and
    // that's already in `userMessage.images` above.
    const origin = options.origin ?? 'desktop';
    const includeAutoSnapshot = options.includeAutoScreenshot !== false;
    const perceptionReason =
      sourceKind === 'gesture' ? 'chat-turn:gesture' : 'chat-turn:user';
    const perception = includeAutoSnapshot
      ? await collectImplicitPerception(
          getAgentPrefs().perceptionMode,
          perceptionReason,
          origin,
        )
      : { screen: null, mobile: null, mobileScreen: null };
    const autoImage = perception.screen;
    const autoMobileImage = perception.mobile?.image ?? null;
    const autoMobileScreenImage = perception.mobileScreen?.image ?? null;

    // A mobile-origin turn attaches the phone's camera + screen, not
    // the desktop screenshot the cached system prompt's "SCREEN" line
    // promises. Spell that out for this turn so Mio reads the images
    // as the right device — and, when the phone sent nothing, so she
    // doesn't claim to see a screen that isn't there.
    let mobilePerceptionNote = '';
    if (origin === 'mobile') {
      const seen: string[] = [];
      if (autoMobileImage) {
        seen.push("the phone's back camera (what the user is physically looking at)");
      }
      if (autoMobileScreenImage) seen.push("the phone's own screen");
      if (seen.length > 0) {
        const noun = seen.length > 1 ? 'images are' : 'image is';
        mobilePerceptionNote =
          '[系統メモ — 表示されない内部ヒント] This turn came from the ' +
          `user's phone. The attached ${noun} ${seen.join(' and ')} — NOT a ` +
          'desktop/Windows screenshot. Ignore the "SCREEN" runtime note for ' +
          'this turn. [メモ終わり]';
      } else {
        mobilePerceptionNote =
          '[系統メモ — 表示されない内部ヒント] This turn came from the ' +
          "user's phone and no phone camera/screen frame arrived — you have " +
          'NO visual context this turn. Ignore the "SCREEN" runtime note; do ' +
          'not claim to see a screen. [メモ終わり]';
      }
    }

    const abort = new AbortController();
    this.currentAbort = abort;
    const taskId = randomUUID();

    const onSlotAbort = (): void => abort.abort();
    if (slot) {
      if (slot.aborted) abort.abort();
      else slot.signal.addEventListener('abort', onSlotAbort, { once: true });
    }

    const client = new Anthropic({ apiKey });

    let assistantText = '';
    this.emit({ type: 'start' });

    try {
      const replayBudget = MAX_REPLAYED_TURNS * 2;
      const slice = this.history.length > replayBudget
        ? this.history.slice(-replayBudget)
        : this.history;
      const priorMessages: MessageParam[] = slice
        .slice(0, -1)
        .map(messageToParam);

      const compaction = getCompactionSummary(sessionId);
      const oldestInWindow =
        this.history.length > 0 && slice.length > 0 ? slice[0]! : null;
      const beforeTimestamp = oldestInWindow
        ? oldestInWindow.createdAt
        : Date.now();
      // Phase-6 — skip semantic recall on very short user messages.
      // Embedding "うん" / "ok" / "わかった" returns essentially
      // random matches in the 0.70-0.75 cosine band, which then add
      // ~600 tokens of unrelated history into the preamble for no
      // benefit. The Gemini embed call costs us latency too. 20
      // chars is roughly two short Japanese filler clauses; anything
      // longer is meaningful enough to recall against.
      //
      // Phase-10 — dropped 20 → 12 so short emotional asks like
      // "覚えてる?", "あの話", "最初に言ったこと覚えてる?" trigger recall.
      // The noise risk is now contained at the recall layer by
      // `effectiveSimilarityFloor` in recall.ts (cosine floor jumps
      // from 0.70 → 0.78 for queries < 20 chars), so 12-char queries
      // need a tighter match before anything surfaces.
      const RECALL_MIN_QUERY_CHARS = 12;
      const recalled = trimmed.length >= RECALL_MIN_QUERY_CHARS
        ? await recallSimilarTurns({
            sessionId,
            query: trimmed,
            beforeTimestamp,
          })
        : [];
      const preamble = buildReplyPreamble({
        sessionId,
        compaction,
        recalled,
      });

      // Phase-5 image discipline — build the auto-perception images
      // (desktop screenshot + mobile back-cam) and the manual image
      // separately so we can drop the auto leg on tool-continuation
      // rounds without affecting what the user actually attached.
      // Order matters: auto images first (ambient context), then
      // manual (the thing the user is asking about), then text.
      //
      // Auto blocks are still image-only — the perception pipeline
      // only produces JPEG/PNG/WebP frames. The manual leg accepts
      // PDFs too (mobile attachment sheet), which land as
      // DocumentBlockParam, so its array type is widened.
      const autoImageBlocks: ImageBlockParam[] = [];
      if (autoImage) autoImageBlocks.push(attachmentBlock(autoImage) as ImageBlockParam);
      if (autoMobileImage) {
        autoImageBlocks.push(attachmentBlock(autoMobileImage) as ImageBlockParam);
      }
      if (autoMobileScreenImage) {
        autoImageBlocks.push(attachmentBlock(autoMobileScreenImage) as ImageBlockParam);
      }
      const manualImageBlocks: Array<ImageBlockParam | DocumentBlockParam> = [];
      if (manualImage) manualImageBlocks.push(attachmentBlock(manualImage));

      const currentTextParts: string[] = [];
      if (preamble.hasContent) currentTextParts.push(preamble.text);
      if (mobilePerceptionNote) currentTextParts.push(mobilePerceptionNote);
      if (trimmed.length > 0) currentTextParts.push(trimmed);
      const currentText = currentTextParts.join('\n\n');

      const buildCurrentMessage = (includeAutoImages: boolean): MessageParam => {
        const blocks: Array<TextBlockParam | ImageBlockParam | DocumentBlockParam> = [];
        if (includeAutoImages) blocks.push(...autoImageBlocks);
        blocks.push(...manualImageBlocks);
        if (currentText.length > 0) {
          blocks.push({ type: 'text', text: currentText });
        } else if (blocks.length === 0) {
          blocks.push({ type: 'text', text: ' ' });
        }
        return { role: 'user', content: blocks };
      };

      const currentMessage: MessageParam = buildCurrentMessage(true);

      const permissionPrefs = getPermissionPrefs();
      const toolsActive = permissionPrefs.toolsEnabled;
      const tools = toolsActive ? toolSpecs() : undefined;
      const toolCtx: ToolContext = {
        taskId,
        workspacePath: permissionPrefs.workspacePath,
        signal: abort.signal,
        sourceKind,
      };
      const apiMessages: MessageParam[] = [...priorMessages, currentMessage];
      const currentMessageIndex = priorMessages.length;

      // Phase-4 — second cache breakpoint on the last block of the
      // most recent prior message. This makes the entire conversation
      // tail (system + tools + every replayed user/assistant pair) a
      // cache READ on every turn after the first, costing ~10% of
      // fresh-input price instead of the full ~$0.20 per turn we were
      // paying for the same history. The breakpoint goes on a stable
      // position (`priorMessages[priorMessages.length - 1]`) so each
      // turn extends the cache by one user+assistant pair without
      // invalidating the prefix already built up by earlier turns.
      // Tool-round continuations append after this breakpoint and
      // stay fresh (correct — they vary every round).
      attachConversationTailCache(priorMessages);

      let stopReason: string | undefined;
      for (let round = 0; ; round += 1) {
        // Phase-5 — drop auto-perception images from `currentMessage`
        // on tool-continuation rounds. On round 0 the model needs the
        // fresh desktop/phone view to decide whether to call a tool;
        // on round 1+ it has the tool's result in hand and the visual
        // context has already done its job. Each retained image costs
        // ~`$0.03` *per round*, so a 4-round browser flow that hangs
        // onto two auto images burns roughly `$0.18` of pure repeat.
        // The manual image (user-attached drag-drop or mobile camera
        // button) stays — that's the thing the user is asking about,
        // not ambient context. `currentMessageIndex` is stable across
        // rounds because the for-loop only `push`es after that index.
        if (round === 1 && autoImageBlocks.length > 0) {
          apiMessages[currentMessageIndex] = buildCurrentMessage(false);
        }
        assistantText = '';
        const systemParts = buildChatSystemPromptParts(toolsActive);
        const stream = client.messages.stream(
          {
            model: DEFAULT_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            // Two-layer system prompt cache (Phase-12 TTL bump):
            //   Block 1 (persona only) is byte-identical across the
            //   tools-on / tools-off chat variants, so flipping the
            //   tools toggle still hits this layer.
            //   Block 2 (variant tail — runtime appendix + tools
            //   appendix + name hint) is byte-identical across
            //   consecutive calls of THIS variant and caches as a
            //   second layer on top.
            // Both blocks use a 1-hour ephemeral TTL: 1h writes cost
            // 2× input (vs. 1.25× for 5m) but survive longer idle
            // gaps, so a chat picked up after a 10–30 min pause
            // reads the prefix at 0.1× instead of cold-writing it.
            // Caches are model-scoped — Opus 4.7 chat does NOT
            // share an entry with the cycle's Haiku 4.5 cache; each
            // pathway warms its own.
            system: [
              {
                type: 'text',
                text: systemParts.common,
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
              {
                type: 'text',
                text: systemParts.variant,
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
            messages: apiMessages,
            ...(tools ? { tools } : {}),
          },
          { signal: abort.signal },
        );

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            const delta = event.delta.text;
            assistantText += delta;
            this.emit({ type: 'text', delta });
          }
        }

        const final = await stream.finalMessage();
        stopReason = final.stop_reason ?? undefined;

        try {
          bumpChatUsage(usageFromResponse(final.usage), pathway);
        } catch (err) {
          console.warn('[anthropic] failed to record chat usage', err);
        }

        const toolUses = final.content.filter(
          (b): b is ToolUseBlock => b.type === 'tool_use',
        );
        if (
          stopReason === 'tool_use' &&
          toolUses.length > 0 &&
          round < MAX_TOOL_ROUNDS
        ) {
          apiMessages.push({ role: 'assistant', content: final.content });
          const results = await executeToolUses(toolUses, toolCtx, (label) => {
            this.emitToolActivity(label);
          });
          apiMessages.push({ role: 'user', content: results });
          if (abort.signal.aborted) throw new Error('cancelled during tool run');
          continue;
        }

        this.emitToolActivity(null);
        break;
      }

      const jaTrimmed = assistantText.trim();
      if (jaTrimmed.length > 0) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: jaTrimmed,
          createdAt: Date.now(),
        };
        this.history.push(assistantMsg);
        const assistantMessageId = appendMessage(sessionId, assistantMsg);
        void embedAndStoreMessage({
          messageId: assistantMessageId,
          sessionId,
          content: jaTrimmed,
          createdAt: assistantMsg.createdAt,
        });
        void runCompactionIfNeeded({
          sessionId,
          replayWindowSize: MAX_REPLAYED_TURNS * 2,
        });
      }

      this.emit({ type: 'end', stopReason });

      // Phase 7 — refresh the avatar's talking animation now that we
      // have the full reply text. Initial `avatar.setTalking` fired at
      // stream start carried no mood; this second emit lets the renderer
      // crossfade into a mood-matched clip for the audio-playback window.
      if (jaTrimmed.length > 0) {
        const mood: ReplyMood = detectReplyMood(jaTrimmed);
        const payload: AvatarTalkingPayload = { mood };
        eventBus.emit('avatar.setTalking', payload, this.meta());
      }

      if (jaTrimmed.length > 0 && slot && !slot.aborted) {
        await dispatchAssistantReply(jaTrimmed, slot, this.currentOrigin);
      }
    } catch (err) {
      const aborted =
        (err as { name?: string })?.name === 'AbortError' || abort.signal.aborted;
      if (aborted) {
        const partialContent = assistantText.trim();
        if (partialContent.length > 0) {
          const partial: ChatMessage = {
            role: 'assistant',
            content: partialContent,
            createdAt: Date.now(),
          };
          this.history.push(partial);
          const partialId = appendMessage(sessionId, partial);
          void embedAndStoreMessage({
            messageId: partialId,
            sessionId,
            content: partialContent,
            createdAt: partial.createdAt,
          });
        }
        this.emit({ type: 'end', stopReason: 'cancelled' });
      } else {
        const message =
          err instanceof Error ? err.message : 'Unknown streaming error.';
        console.error('[anthropic] stream error', err);
        this.emit({ type: 'error', message });
        this.emit({ type: 'end', stopReason: 'error' });
      }
    } finally {
      if (slot) slot.signal.removeEventListener('abort', onSlotAbort);
      if (this.currentAbort === abort) this.currentAbort = null;
      clearTaskGrants(taskId);
      // Drop the routing meta so unrelated bus emissions (greeting,
      // agent loop cycles, gesture-prefs broadcasts) once again fan to
      // every surface.
      this.currentOrigin = undefined;
    }
  }

  private emit(event: ChatStreamEvent): void {
    eventBus.emit('chat.stream', event, this.meta());
  }

  /** Push the dim "tool running" progress line (or null to clear it). */
  private emitToolActivity(text: string | null): void {
    const payload: ChatToolActivityPayload = { text };
    eventBus.emit('chat.toolActivity', payload, this.meta());
  }

  /**
   * Build the per-emit routing meta for the in-flight turn. The
   * `origin` lets each transport decide whether to forward — see
   * `transport/ws.ts` and `main/ipcShim.ts`.
   */
  private meta(): EventMeta {
    return this.currentOrigin ? { origin: this.currentOrigin } : {};
  }
}

export const chatService = new ChatService();
