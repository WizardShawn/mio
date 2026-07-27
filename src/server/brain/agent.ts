import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  TextBlock,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

import type {
  AgentPrefs,
  AgentStatus,
  AgentState,
} from '@shared/protocol';

import { eventBus } from '../eventBus';
import { loadApiKey } from './apiKey';
import {
  runAssistantChatTurn,
  runInjectedAssistantChatTurn,
} from './chatTurn';
import {
  bumpCycle,
  bumpNotification,
  getDailyCounters,
  getEstimatedCostTodayUsd,
  getPathwayCountersToday,
  usageFromResponse,
  type UsageBreakdown,
} from './agentCounters';
import { getHost } from './host';
import { queryMemory, writeMemory } from './memory';
import { runReflectionIfDue } from './reflection';
import { getMostRecentActiveApp } from './mobileActiveApp';
import { collectImplicitPerception } from './perception';
import { loadPersonaMarkdown } from './persona';
import { replyCoordinator } from './replyCoordinator';
import { getLastUserActivityAt } from './replyContext';
import { beginCycle, endCycle, runGenerateImage } from './tools/generateImage';
import { cycleToolSpecs } from './tools/registry';
import type { ToolContext } from './tools/types';
import {
  getActiveSessionId,
  getAgentPrefs,
  getComfyUiPrefs,
  setAgentPrefs,
} from './userPreferences';

// Phase 5 — autonomous cycle.

// Cycle pathway model (Phase-12). Haiku 4.5 is ~5× cheaper per token
// than Opus 4.7 and is more than capable of the cycle's JSON-note
// task. Note: in active check-in mode (`notableCheckInChat: true`)
// the spoken Japanese line the operator hears is generated here too
// — if voice quality on those drops below your bar, swap this to
// 'claude-sonnet-4-6' (still ~1.7× cheaper than Opus, with solid
// Japanese). Keep `PATHWAY_MODEL['cycle']` in `agentCounters.ts` in
// sync with this constant, or the meter silently drifts.
const CYCLE_MODEL = 'claude-haiku-4-5';
const HOUR_MS = 60 * 60 * 1000;
const MAX_TOOL_ROUNDS = 4;
const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

// Phase-11 — cycle prompts trimmed but every rule preserved. The
// language rules for each field, the tool budget, and the JSON-only
// final-message contract all stay.
const CYCLE_INSTRUCTIONS_HEADER = [
  '',
  '---',
  '',
  '## Cycle mode (autonomous observation — no user is talking to you)',
  '',
  'JSON keys in English. Field language: `summary` / `reason` / `notify_user` body →',
  'Traditional Chinese (繁體中文, operator reads on screen). `message` → Japanese only',
  '(it feeds the chat check-in; TTS reads it, the app translates to 繁中).',
  '',
  'This turn rules:',
  '1. May call `query_memory` to recall recent notes.',
  '2. May call `write_memory` to record this observation.',
].join('\n');

const CYCLE_INSTRUCTIONS_SILENT_TAIL = [
  '3. May call `notify_user` once if the observation clears the bar in',
  '   `## What surfaces and what doesn\'t`. Otherwise stay silent.',
  '4. Final assistant message: a SINGLE JSON object matching `### The format of your',
  '   private notes`. No prose around it.',
].join('\n');

const CYCLE_INSTRUCTIONS_ACTIVE_TAIL = [
  '3. `## What surfaces and what doesn\'t` is OVERRIDDEN — the operator opted in to',
  '   proactive check-ins. Default `notable: true`; mark `false` only if he is clearly',
  '   mid-conversation with you, or literally nothing on screen gives you anything to',
  '   say (and even then prefer a soft check-in over silence).',
  '4. When `notable: true`, `message` is the actual line you would say — natural Japanese',
  '   only, no Chinese, no English. One or two short specific sentences (the kind you\'d',
  '   open with if you walked into the room and saw the screen). Specific beats generic:',
  '   "ねえ、Phase 5、もう二日も詰まってるでしょ。一回五分だけ離れてみない？" > "大丈夫？".',
  '5. Final assistant message: a SINGLE JSON object matching `### The format of your',
  '   private notes`. No prose around it.',
].join('\n');

function buildNotableCheckInUserLine(ctx: {
  summary: string;
  reason: string | null;
  message: string | null;
}): string {
  const summary = ctx.summary.trim() || '（觀察標記為值得關心，但未附帶摘要。）';
  const lines = [
    '[系統／背景觀察跟進 — notable]',
    '',
    '剛才的靜默觀察迴圈把這次情況標成「值得主動關心」。請你像平常他用聊天跟你說話一樣，用「自然な日本語」主動關心他、對他說話 — 不要寫中文，也不要混英文整段。回覆會被 Gemini TTS 用日語朗讀出來，字幕欄由 app 自動翻成繁中。這則訊息會帶上目前的螢幕截圖，你也可以沿用對話紀錄裡的脈絡。',
    '',
    `觀察摘要：${summary}`,
  ];
  if (ctx.reason && ctx.reason.trim()) {
    lines.push(`理由：${ctx.reason.trim()}`);
  }
  if (ctx.message && ctx.message.trim()) {
    lines.push(`（參考語氣／想提醒的點 — 不論這段是日文還是中文，你的回覆都用日本語）${ctx.message.trim()}`);
  }
  return lines.join('\n');
}

const CYCLE_BUILTIN_TOOLS: Tool[] = [
  {
    name: 'query_memory',
    description:
      'Retrieve recent observation notes. Optional `query` does a substring filter; ' +
      'omit it to get the most recent entries.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 25 },
      },
    },
  },
  {
    name: 'write_memory',
    description:
      'Record a note about what you observed this cycle. Make sure to adhere to the current Mode (Silent vs Active) ' +
      "when deciding if `notable: true` should be used. " +
      // Phase-10 — notable=true entries are the durable, long-term memory slot:
      // they show in the chat preamble's 「大切な瞬間」 block on every relevant
      // turn, even after the rolling summary has compressed the original
      // conversation. Bias toward flagging anything that anchors the
      // relationship: first meetings, names of people/places/pets in his life,
      // promises either side made, dates that mattered (birthdays, anniversaries,
      // milestones), confessions or emotionally heavy moments, recurring themes
      // that define how he is doing. Routine observations stay notable=false.
      'Set `notable: true` for moments that should never be forgotten: first meetings, ' +
      'names of people/places/pets, promises, important dates (birthdays, anniversaries, ' +
      'milestones), confessions, emotionally heavy exchanges, or recurring themes that ' +
      'define the relationship. Leave `notable: false` for routine ambient observations. ' +
      // Phase-11 M8 — importance signals "should this survive aging out".
      // Combined with notable=true, it controls how long an entry stays
      // surfaced in 「大切な瞬間」 before the age-decay curve dims it.
      'Set `importance` 0-10 (default 5). Use 9-10 for foundational ' +
      'milestones (first meetings, names, vows, life-defining events); 7-8 for ' +
      'meaningful but not foundational (preferences he is firm about, ongoing ' +
      "stresses, recurring relationships in his life); 4-6 for routine; 0-3 only " +
      'for trivia worth recording but not surfacing repeatedly.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        notable: { type: 'boolean' },
        reason: { type: 'string' },
        message: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        importance: { type: 'number', minimum: 0, maximum: 10 },
      },
      required: ['summary', 'notable'],
    },
  },
  {
    name: 'notify_user',
    description:
      'Surface a short message to the operator via a desktop toast. Use sparingly — ' +
      'a real partner does not interrupt every ten minutes.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['message'],
    },
  },
];

function cycleAnthropicTools(): Tool[] {
  return [...CYCLE_BUILTIN_TOOLS, ...cycleToolSpecs()];
}

interface CycleStats {
  /**
   * Phase-1 cost-meter — aggregate usage across every Anthropic round
   * within the cycle (initial call + each tool-result round). The
   * counter table consumes this exact shape via `bumpCycle`.
   */
  usage: UsageBreakdown;
  notable: boolean;
  message: string | null;
  checkInContext: {
    summary: string;
    reason: string | null;
    message: string | null;
  } | null;
}

interface NotifyTracker {
  windowStart: number;
  count: number;
}

class AgentLoop {
  private initialized = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private paused = false;
  private state: AgentState = 'disabled';
  private reason: string | null = null;
  private lastRunAt: number | null = null;
  private nextRunAt: number | null = null;
  private consecutiveErrors = 0;
  private cyclesThisHour: NotifyTracker = { windowStart: 0, count: 0 };
  private notifsThisHour: NotifyTracker = { windowStart: 0, count: 0 };
  private cycleToolNotable = false;
  private cycleToolCheckIn: {
    summary: string;
    reason: string | null;
    message: string | null;
  } | null = null;
  private offCoordinatorIdle: (() => void) | null = null;
  private deferredTickPending = false;
  /**
   * Phase-10 — cheap "did anything change?" fingerprint from the prior
   * tick (active window title + mobile app + screenshot byte length).
   * If the next tick produces the same fingerprint AND there's no
   * user activity to react to, we skip the Anthropic call entirely
   * and write a synthetic "no change" memory locally.
   */
  private lastTickFingerprint: string | null = null;
  /**
   * Phase-10 — wall-clock of the last keyboard/mouse signal we saw.
   * The notable-check-in gate uses this to skip when the operator
   * isn't actually at the machine.
   */
  private lastUserActivityAt = Date.now();

  init(): void {
    this.initialized = true;
    if (this.offCoordinatorIdle) this.offCoordinatorIdle();
    this.offCoordinatorIdle = replyCoordinator.onIdle(() => {
      if (this.deferredTickPending) {
        this.deferredTickPending = false;
        void this.tick();
        return;
      }
      this.scheduleNextTick(getAgentPrefs());
    });
    const prefs = getAgentPrefs();
    this.applyPrefs(prefs);
  }

  getStatus(): AgentStatus {
    const counters = getDailyCounters();
    const comfy = getComfyUiPrefs();
    const pathwayRows = getPathwayCountersToday();
    return {
      state: this.state,
      reason: this.reason,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      cyclesToday: counters.cycles,
      // Phase-12 — costed via the per-pathway / per-model meter
      // (`getEstimatedCostTodayUsd`) instead of the old model-blind
      // roll-up. Same field on the wire; mobile + desktop both see
      // the corrected number with no protocol change.
      estimatedCostUsdToday: getEstimatedCostTodayUsd(),
      consecutiveErrors: this.consecutiveErrors,
      imagesToday: counters.images,
      dailyImageCap: comfy.dailyImageCap,
      pathwayBreakdownToday: pathwayRows.map((r) => ({
        pathway: r.pathway,
        calls: r.calls,
        estimatedCostUsd: r.estimatedCostUsd,
      })),
    };
  }

  applyPrefs(prefs: AgentPrefs): AgentPrefs {
    const normalised = setAgentPrefs(prefs);
    this.reschedule(normalised);
    return normalised;
  }

  togglePause(): AgentStatus {
    this.paused = !this.paused;
    if (this.paused) {
      this.setState('paused', 'Paused from tray.');
    } else {
      this.consecutiveErrors = 0;
      this.reason = null;
      this.reschedule(getAgentPrefs());
    }
    return this.publishStatus();
  }

  isPaused(): boolean {
    return this.paused;
  }

  async runNow(): Promise<void> {
    await this.tick();
  }

  private reschedule(prefs: AgentPrefs): void {
    this.clearTimer();
    if (!prefs.enabled) {
      this.setState('disabled', null);
      this.nextRunAt = null;
      this.deferredTickPending = false;
      return;
    }
    if (this.paused) {
      this.setState('paused', this.reason ?? 'Paused from tray.');
      return;
    }
    this.scheduleNextTick(prefs);
    this.setState('idle', null);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextTick(prefs: AgentPrefs): void {
    if (!prefs.enabled || this.paused) return;
    this.clearTimer();
    const intervalMs = Math.max(1, prefs.intervalMinutes) * 60_000;
    this.nextRunAt = Date.now() + intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, intervalMs);
  }

  private setState(state: AgentState, reason: string | null): void {
    const previous = this.state;
    this.state = state;
    this.reason = reason;
    if (state !== previous) {
      if (state === 'capped') {
        this.surfaceWarning('capped');
      } else if (state === 'error' && this.paused) {
        this.surfaceWarning('error');
      }
    }
    this.publishStatus();
  }

  private surfaceWarning(kind: 'capped' | 'error'): void {
    const message =
      kind === 'capped'
        ? '⚠ Mio 的自動迴圈已達上限並暫停了 — 詳情請看設定頁的 Agent。'
        : '⚠ Mio 的自動迴圈連續出錯已暫停 — 詳情請看設定頁的 Agent。';
    eventBus.emit('chat.showWarning', { message });
  }

  /**
   * Public alias of `publishStatus` for modules outside the loop that
   * need to nudge renderers after mutating shared state — Phase 10
   * `generate_image` calls this after bumping the daily image counter
   * so the HUD reflects the new total without waiting for the next
   * cycle tick.
   */
  republishStatus(): AgentStatus {
    return this.publishStatus();
  }

  private publishStatus(): AgentStatus {
    const status = this.getStatus();
    if (this.initialized) {
      eventBus.emit('agent.status', status);
    }
    return status;
  }

  private withinHourlyCap(prefs: AgentPrefs): boolean {
    const now = Date.now();
    if (now - this.cyclesThisHour.windowStart >= HOUR_MS) {
      this.cyclesThisHour = { windowStart: now, count: 0 };
    }
    return this.cyclesThisHour.count < prefs.hourlyCycleCap;
  }

  private withinNotifyCap(prefs: AgentPrefs): boolean {
    const now = Date.now();
    if (now - this.notifsThisHour.windowStart >= HOUR_MS) {
      this.notifsThisHour = { windowStart: now, count: 0 };
    }
    return this.notifsThisHour.count < prefs.hourlyNotifyCap;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (this.paused) return;

    const prefs = getAgentPrefs();
    if (!prefs.enabled) return;

    if (replyCoordinator.isBusy()) {
      this.deferredTickPending = true;
      return;
    }

    const spentUsd = getEstimatedCostTodayUsd();
    if (spentUsd >= prefs.dailyCostCapUsd) {
      this.setState(
        'capped',
        `Daily cost cap reached ($${spentUsd.toFixed(2)} / $${prefs.dailyCostCapUsd}).`,
      );
      return;
    }

    if (!this.withinHourlyCap(prefs)) {
      this.setState(
        'capped',
        `Hourly cycle cap reached (${prefs.hourlyCycleCap}/h).`,
      );
      return;
    }

    this.running = this.runCycle().catch((err) => {
      console.error('[agent] cycle crashed', err);
    });
    try {
      await this.running;
    } finally {
      this.running = null;
      const fresh = getAgentPrefs();
      if (
        fresh.enabled &&
        !this.paused &&
        this.state !== 'capped' &&
        !replyCoordinator.isBusy()
      ) {
        this.scheduleNextTick(fresh);
      }
      this.publishStatus();
    }

    // Phase-11 M6 — reflection pass. Fires after the cycle settles
    // (so the cost meter and timing don't interleave with the
    // cycle's own Anthropic call). Gated internally on cooldown +
    // new-message count, so most ticks are a single SQL count and a
    // return; only ~every 1-2 hours of active chat does it actually
    // run a Flash call (~$0.001/pass). Fire-and-forget — a failure
    // here must never crash the agent loop.
    const activeSessionId = getActiveSessionId();
    void runReflectionIfDue(activeSessionId).catch((err) => {
      console.warn('[agent] reflection check crashed', err);
    });
  }

  private async runCycle(): Promise<void> {
    const apiKey = loadApiKey();
    if (!apiKey) {
      this.setState('error', 'No Anthropic API key configured.');
      return;
    }

    this.setState('running', null);
    this.cyclesThisHour.count += 1;

    const cycleId = `cycle-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    beginCycle(cycleId);

    try {
      const stats = await this.executeAnthropicCycle(apiKey, cycleId);
      bumpCycle(stats.usage);
      this.consecutiveErrors = 0;
      this.lastRunAt = Date.now();
      this.setState('idle', null);
      try {
        await this.maybeNotableCheckIn(stats);
      } catch (e) {
        console.error('[agent] notable chat check-in failed', e);
      }
    } catch (err) {
      this.consecutiveErrors += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[agent] cycle failed', err);
      const backoffMs = Math.min(
        MAX_BACKOFF_MS,
        MIN_BACKOFF_MS * 2 ** Math.min(this.consecutiveErrors - 1, 6),
      );
      if (this.consecutiveErrors >= 3) {
        this.paused = true;
        this.setState(
          'error',
          `Paused after ${this.consecutiveErrors} consecutive errors: ${message}`,
        );
      } else {
        this.setState('error', `Backoff ${Math.round(backoffMs / 1000)}s: ${message}`);
        this.nextRunAt = Date.now() + backoffMs;
      }
    } finally {
      endCycle(cycleId);
    }
  }

  private async executeAnthropicCycle(apiKey: string, cycleId: string): Promise<CycleStats> {
    this.cycleToolNotable = false;
    this.cycleToolCheckIn = null;

    const stats: CycleStats = {
      usage: {
        inTokens: 0,
        outTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
      notable: false,
      message: null,
      checkInContext: null,
    };

    const activeWindow = await getHost().sensors.getActiveWindowTitle().catch(() => null);

    const prefs = getAgentPrefs();
    const cycleInstructions = prefs.notableCheckInChat
      ? `${CYCLE_INSTRUCTIONS_HEADER}\n${CYCLE_INSTRUCTIONS_ACTIVE_TAIL}`
      : `${CYCLE_INSTRUCTIONS_HEADER}\n${CYCLE_INSTRUCTIONS_SILENT_TAIL}`;
    // Phase-11 — mode instructions trimmed; every rule kept.
    const modeInstructions = prefs.notableCheckInChat
      ? [
          '',
          '',
          '## ⚑ ACTIVE INTERACTION MODE (overrides the persona\'s silent-observer rules)',
          '',
          'Operator flipped "Notable → chat check-in" ON. For THIS cycle:',
          '- Invert `## What surfaces and what doesn\'t`: "he\'s working / opened a new app /',
          '  has been idle" all DO surface now.',
          '- The "real friend doesn\'t interrupt every ten minutes" rule is suspended — he',
          '  set the interval, he wants the company.',
          '- Default `notable: true`. Mark `false` only if he\'s mid-conversation with you',
          '  in chat already. Working alone on a file does NOT qualify.',
          '- `message` is the actual opener — short, specific, 自然な日本語. Prove you were',
          '  watching ("Phase 5 の docs まだ詰まってる？") instead of generic ("大丈夫？").',
        ].join('\n')
      : [
          '',
          '',
          '## Silent observer mode',
          '',
          'Bias hard `notable: false`. Default for every tick is silence. The bar is high:',
          'would he be GLAD you said something? If yes, surface. If no, write the note and',
          'stay quiet. A real friend who interrupts every ten minutes is a nuisance.',
        ].join('\n');

    // Two-layer system prompt: persona (common) + cycle-specific
    // tail (mode + JSON contract) as separate cache blocks. Both use
    // a 1-hour ephemeral TTL (Phase-12) so the persona layer
    // (~5,500 tokens) is read at 0.1× input rates instead of being
    // cold-written on every 10-minute cycle.
    //
    // Note: prompt caches are model-scoped. After Phase-12 the cycle
    // runs on Haiku 4.5 while chat stays on Opus 4.7, so the two
    // pathways no longer share a persona cache entry (pre-Phase-12,
    // both were Opus and a cross-pathway hit was possible). Each
    // model still caches the persona once per hour for its own
    // pathway — the saving is intra-pathway, not cross-pathway.
    const systemCommon = loadPersonaMarkdown();
    const systemVariant = `${cycleInstructions}${modeInstructions}`;

    const recent = queryMemory(undefined, 6);
    const recentSummary = recent.length === 0
      ? '(no prior observations on file)'
      : recent
          .map((m) => {
            const when = new Date(m.createdAt).toISOString();
            const flag = m.notable ? '★' : ' ';
            return `${flag} ${when} — ${m.summary}`;
          })
          .join('\n');

    // Implicit perception for this cycle. Centralised in
    // `perception.ts` so the agent loop, chat-turn auto-snapshot, and
    // gesture-turn auto-snapshot share identical timeout / fallback /
    // mode semantics. With the default `'both'` mode and a mobile
    // client paired, the model sees the desktop screenshot AND a
    // fresh phone back-cam frame on every observation tick. Either
    // leg may resolve to null — the model simply gets whichever
    // arrived. Both legs are *transient* (no DB write, no recall
    // store, no memory entry).
    // Phase-5 — fallback aligned with the new `'desktop-only'`
    // default in `userPreferences.ts`; the agent loop never needs
    // the mobile back-cam by default (the operator's screen is the
    // load-bearing visual for "what's he doing?"), and skipping it
    // saves one ~`2k-token` image per tick.
    const perceptionMode = prefs.perceptionMode ?? 'desktop-only';
    const perception = await collectImplicitPerception(
      perceptionMode,
      'agent-cycle',
    );

    // M-5.6 — surface the phone's foreground app next to the desktop
    // window when the mobile client has reported one recently. The
    // model sees both and judges which device the user is actually on.
    // The merge lives here in the brain (not in `HostAdapter`, whose
    // `getActiveWindowTitle` is also used by computer-use and must stay
    // desktop-only); a stale mobile sample resolves to null.
    const mobileApp = getMostRecentActiveApp();
    const activeContext = mobileApp
      ? `Active window: ${activeWindow || '(unknown)'}. ` +
        `The user's phone is in ${mobileApp.activityLabel || mobileApp.packageName} ` +
        `(seen ${Math.round((Date.now() - mobileApp.receivedAt) / 1000)}s ago).`
      : `Active window: ${activeWindow || '(unknown)'}.`;

    const introLines: string[] = [
      `Observation cycle. ${activeContext}`,
    ];
    if (perception.screen && perception.mobile) {
      const ageMs = perception.mobile.ageMs;
      introLines.push(
        'Two transient images are attached for this tick:',
        '  1) the desktop primary-monitor screenshot (what is on the user\'s screen right now);',
        `  2) a live back-camera frame from the user's phone (${perception.mobile.width}x${perception.mobile.height}, ` +
          `captured ${Math.round(ageMs / 1000)} s ago) — what they see in the physical world right now.`,
        'Neither image is written to chat history, memory_entries, or disk.',
      );
    } else if (perception.mobile) {
      const ageMs = perception.mobile.ageMs;
      introLines.push(
        `A live camera frame from the user's phone (back camera, ${perception.mobile.width}x${perception.mobile.height}, ` +
          `captured ${Math.round(ageMs / 1000)} s ago) is attached for this tick — what they see right now.`,
        'It is not written to chat history, memory_entries, or disk.',
      );
    } else if (perception.screen) {
      introLines.push(
        'A fresh primary-monitor screenshot is attached below for this tick only — transient context for the model.',
        'It is not written to chat history, not stored in memory_entries, and not saved to disk.',
      );
    } else if (perceptionMode === 'mobile-only') {
      introLines.push(
        'No fresh mobile camera frame is buffered. Treat this tick as a text-only check-in and bias hard toward `notable: false`.',
      );
    } else {
      introLines.push(
        'No visual context is available this tick (capture failed or no client paired). Reason from text alone.',
      );
    }
    introLines.push('Recent notes (most recent first):', recentSummary);

    // Phase-5 — split text vs. perception images so round-1+ can
    // re-issue the seed message without re-billing the screenshots.
    // Round 0 needs the visual to decide what the model wants to
    // record / surface; tool-result rounds (e.g. after `write_memory`)
    // just need the JSON response synthesised against the tool's
    // outcome.
    const introText: TextBlockParam = { type: 'text', text: introLines.join('\n') };
    const perceptionImageBlocks: ImageBlockParam[] = [];
    if (perception.screen) {
      perceptionImageBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: perception.screen.mediaType,
          data: perception.screen.data,
        },
      });
    }
    if (perception.mobile) {
      perceptionImageBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: perception.mobile.image.mediaType,
          data: perception.mobile.image.data,
        },
      });
    }

    const buildSeedMessage = (includePerceptionImages: boolean): MessageParam => {
      const blocks: Array<TextBlockParam | ImageBlockParam> = [introText];
      if (includePerceptionImages) blocks.push(...perceptionImageBlocks);
      return { role: 'user', content: blocks };
    };

    // Phase-10 — cheap "did anything change?" fingerprint. Combines
    // active window/app text (semantic state) with the screenshot
    // payload size (proxy for "did the pixels change?"). When the
    // fingerprint matches the previous tick AND the operator hasn't
    // opted into chat check-ins, the cycle is pure waste — write a
    // synthetic local note and skip the Anthropic call. Saves the
    // entire `~$0.12` cycle cost on every quiet tick. On hours where
    // the operator is idle (lunch break, meeting, AFK) this can
    // halve loop cost without losing any signal we'd surface anyway.
    const screenBytes = perception.screen?.data.length ?? 0;
    const mobileBytes = perception.mobile?.image.data.length ?? 0;
    const fingerprint = [
      activeContext,
      `screen=${screenBytes}`,
      `mobile=${mobileBytes}`,
    ].join('|');
    if (
      this.lastTickFingerprint !== null &&
      this.lastTickFingerprint === fingerprint &&
      !prefs.notableCheckInChat
    ) {
      console.log('[agent] Cycle skipped — fingerprint unchanged.');
      try {
        writeMemory({
          summary: '（無変化：active window / 画面サイズが前回と同じ。スキップ。）',
          notable: false,
          reason: null,
          message: null,
        });
      } catch (err) {
        console.warn('[agent] failed to record skip memory', err);
      }
      // Update fingerprint anyway so a one-off transient change
      // doesn't trip the skip again on its way back to baseline.
      this.lastTickFingerprint = fingerprint;
      return stats;
    }
    this.lastTickFingerprint = fingerprint;

    const messages: MessageParam[] = [buildSeedMessage(true)];
    const seedMessageIndex = 0;

    const client = new Anthropic({ apiKey });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      // Phase-5 — strip the auto-perception images from the seed
      // user message on tool-continuation rounds. Saves the cycle's
      // ~`$0.06–0.10` per-round image rebill when the model invokes
      // `write_memory` or `notify_user` (which always need a second
      // round to produce the final JSON note).
      if (round === 1 && perceptionImageBlocks.length > 0) {
        messages[seedMessageIndex] = buildSeedMessage(false);
      }

      const response = await client.messages.create({
        model: CYCLE_MODEL,
        max_tokens: 1024,
        // Two-layer system cache, 1-hour TTL (Phase-12). The 10-min
        // cycle interval used to outlive the default 5-min ephemeral
        // TTL, so the ~5.5k-token persona block was cold-written on
        // every single cycle and caching effectively did nothing for
        // this pathway. 1h-TTL writes are billed at 2× input (vs.
        // 1.25× for 5m) but amortise to near-zero once the entry is
        // warm — subsequent cycles in the same hour pay cache-read
        // rates (0.1× input) on the whole prefix.
        system: [
          {
            type: 'text',
            text: systemCommon,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            type: 'text',
            text: systemVariant,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        tools: cycleAnthropicTools(),
        messages,
      });

      const roundUsage = usageFromResponse(response.usage);
      stats.usage.inTokens += roundUsage.inTokens;
      stats.usage.outTokens += roundUsage.outTokens;
      stats.usage.cacheWriteTokens += roundUsage.cacheWriteTokens;
      stats.usage.cacheReadTokens += roundUsage.cacheReadTokens;

      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const finalText = response.content
          .filter((b): b is TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        const parsed = safeParseJson(finalText);
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          const summary = typeof obj['summary'] === 'string' ? (obj['summary'] as string) : null;
          if (summary) {
            const notable = obj['notable'] === true;
            console.log(`[agent] Cycle complete (JSON). Notable: ${notable} | Summary: ${summary}`);
            writeMemory({
              summary,
              notable,
              reason: typeof obj['reason'] === 'string' ? (obj['reason'] as string) : null,
              message: typeof obj['message'] === 'string' ? (obj['message'] as string) : null,
            });
            stats.notable = notable;
            stats.message = typeof obj['message'] === 'string' ? (obj['message'] as string) : null;
            if (notable) {
              stats.checkInContext = {
                summary,
                reason: typeof obj['reason'] === 'string' ? (obj['reason'] as string) : null,
                message: typeof obj['message'] === 'string' ? (obj['message'] as string) : null,
              };
            }
          }
        }
        stats.notable = stats.notable || this.cycleToolNotable;
        if (!stats.checkInContext && this.cycleToolCheckIn) {
          stats.checkInContext = this.cycleToolCheckIn;
        }
        return stats;
      }

      const toolResults: ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const result = await this.runTool(use, cycleId);
        const content = Array.isArray(result)
          ? result
          : typeof result === 'string'
            ? result
            : JSON.stringify(result);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    throw new Error(`Cycle exceeded ${MAX_TOOL_ROUNDS} tool rounds.`);
  }

  private async runTool(use: ToolUseBlock, cycleId: string): Promise<unknown> {
    const input = (use.input ?? {}) as Record<string, unknown>;
    try {
      switch (use.name) {
        case 'query_memory': {
          const q = typeof input['query'] === 'string' ? (input['query'] as string) : undefined;
          const limit = typeof input['limit'] === 'number' ? (input['limit'] as number) : 8;
          const entries = queryMemory(q, limit);
          return { entries };
        }
        case 'write_memory': {
          const summary = typeof input['summary'] === 'string' ? (input['summary'] as string).trim() : '';
          if (!summary) return { error: 'summary is required' };

          const notable = input['notable'] === true;
          console.log(`[agent] write_memory tool called. Notable: ${notable} | Summary: ${summary}`);

          const tagsInput = input['tags'];
          const tags = Array.isArray(tagsInput)
            ? tagsInput.filter((t): t is string => typeof t === 'string')
            : undefined;
          const importanceInput = input['importance'];
          const importance =
            typeof importanceInput === 'number' && Number.isFinite(importanceInput)
              ? importanceInput
              : undefined;
          const entry = writeMemory({
            summary,
            notable: input['notable'] === true,
            reason: typeof input['reason'] === 'string' ? (input['reason'] as string) : null,
            message: typeof input['message'] === 'string' ? (input['message'] as string) : null,
            tags,
            importance,
          });
          if (input['notable'] === true) {
            this.cycleToolNotable = true;
            this.cycleToolCheckIn = {
              summary,
              reason: typeof input['reason'] === 'string' ? (input['reason'] as string) : null,
              message: typeof input['message'] === 'string' ? (input['message'] as string) : null,
            };
          }
          return { ok: true, id: entry.id };
        }
        case 'notify_user': {
          const message = typeof input['message'] === 'string' ? (input['message'] as string).trim() : '';
          if (!message) return { error: 'message is required' };
          const title =
            typeof input['title'] === 'string' && input['title'] ? (input['title'] as string) : 'Mio';
          return this.dispatchNotification(title, message);
        }
        case 'generate_image': {
          return await this.runGenerateImageFromCycle(input, cycleId);
        }
        default:
          return { error: `Unknown tool: ${use.name}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async runGenerateImageFromCycle(
    input: Record<string, unknown>,
    cycleId: string,
  ): Promise<unknown> {
    const prompt = typeof input['prompt'] === 'string' ? (input['prompt'] as string) : '';
    if (!prompt.trim()) return { error: 'prompt is required' };
    const aspectRaw = input['aspect_ratio'];
    const intentRaw = input['intent'];
    const ctx: ToolContext = {
      taskId: cycleId,
      workspacePath: '',
      signal: new AbortController().signal,
      sourceKind: 'cycle',
    };
    const result = await runGenerateImage({
      prompt,
      aspectRatio:
        typeof aspectRaw === 'string' &&
        (['16:9', '1:1', '9:16', '4:3', '3:4'] as const).includes(aspectRaw as never)
          ? (aspectRaw as '16:9' | '1:1' | '9:16' | '4:3' | '3:4')
          : undefined,
      intent: typeof intentRaw === 'string' ? intentRaw : undefined,
      ctx,
    });
    if (!result.ok) {
      return { error: result.reason };
    }
    this.cycleToolNotable = true;
    if (!this.cycleToolCheckIn) {
      const intentLine = result.intent ?? prompt;
      this.cycleToolCheckIn = {
        summary: `自分で絵を描いた: ${intentLine}`,
        reason: result.intent ?? null,
        message: null,
      };
    }
    const captionPieces = [
      `生成成功 (path=${result.absPath})`,
      result.cached ? '(キャッシュ済み)' : null,
    ].filter((s): s is string => s !== null);
    return [
      { type: 'text', text: captionPieces.join(' ') },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: dataUrlToBase64Cycle(result.dataUrl),
        },
      },
    ];
  }

  private async maybeNotableCheckIn(stats: CycleStats): Promise<void> {
    const prefs = getAgentPrefs();
    if (!prefs.notableCheckInChat || !stats.notable) return;
    if (replyCoordinator.isBusy()) {
      console.warn(
        `[agent] skip notable check-in — coordinator busy with ${replyCoordinator.currentKind()}`,
      );
      return;
    }

    // Phase-10 — gate the check-in on the operator having shown signs
    // of life recently. The "last user activity" timestamp comes
    // from the most recent non-system user-role chat row (typed
    // turns + gestures qualify; welcome-back / check-in / cycle
    // synthetic rows do not). If the operator hasn't touched the
    // machine in over an hour, firing a `~$0.45` check-in into a
    // closed laptop or an empty seat is pure waste — the model
    // talks to itself, the operator never hears it, and on the next
    // wake the cached greeting will cover the welcome anyway.
    const NOTABLE_CHECK_IN_ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
    const sessionId = getActiveSessionId();
    const lastActivity = getLastUserActivityAt(sessionId);
    if (lastActivity !== null) {
      const gap = Date.now() - lastActivity;
      if (gap > NOTABLE_CHECK_IN_ACTIVITY_WINDOW_MS) {
        console.log(
          `[agent] skip notable check-in — operator inactive for ${Math.round(gap / 60_000)}m`,
        );
        return;
      }
    }

    const ctx = stats.checkInContext ?? {
      summary: '（觀察標記為 notable。）',
      reason: null,
      message: stats.message,
    };

    const text = buildNotableCheckInUserLine(ctx);

    // Phase-2 cost-saver — the cycle that produced this `ctx` already
    // ran a full Claude call against the screenshot + observation
    // notes, and the active-mode prompt told the model to write the
    // Japanese check-in line up front into `message`. If we have that
    // line, deliver it directly through the injected path: zero
    // additional Anthropic call, zero history replay, zero fresh
    // image rebill. The bracketed `[系統／背景觀察跟進 — notable]`
    // user-side block is still persisted so future chat turns can
    // reference the moment ("さっき言ってた…") just like before.
    //
    // Only fall back to the old `runAssistantChatTurn` (which spends
    // ~$0.45 to regenerate the same sentence) when the cycle didn't
    // emit a usable `message` field — e.g. an older `write_memory`
    // tool call that set `notable: true` without supplying the line,
    // or the `generate_image` cycle path that flags notable from the
    // image generation itself. In that case the chat call genuinely
    // does need to produce the spoken line.
    const preGenerated = ctx.message?.trim() ?? '';
    if (preGenerated.length > 0) {
      await runInjectedAssistantChatTurn({
        userText: text,
        assistantText: preGenerated,
      });
      return;
    }

    await runAssistantChatTurn({
      text,
      options: { includeAutoScreenshot: true },
      kind: 'auto',
      pathway: 'check_in',
    });
  }

  private dispatchNotification(title: string, body: string): {
    ok: boolean;
    suppressed?: string;
  } {
    const prefs = getAgentPrefs();
    if (!this.withinNotifyCap(prefs)) {
      return { ok: false, suppressed: 'hourly_notify_cap' };
    }
    this.notifsThisHour.count += 1;
    bumpNotification();
    getHost().notifier.notify({ title, body });
    // Phase M-6 — the same emission point that fires the desktop OS
    // toast now also fans out to any paired mobile clients as a
    // heads-up notification. The WS transport's bus subscriber picks
    // the event up automatically; the desktop renderers deliberately
    // ignore it (the OS toast above already covers the local user).
    // Rate limiting is unified via `withinNotifyCap` above — there is
    // no separate mobile counter, so the §6 plan's "rate cap mirrored
    // to the desktop's existing cap" is automatic.
    eventBus.emit('notification.surface', {
      title,
      body,
      priority: 'high',
      id: randomUUID(),
      emittedAt: Date.now(),
    });
    return { ok: true };
  }

  shutdown(): void {
    this.clearTimer();
    if (this.offCoordinatorIdle) {
      this.offCoordinatorIdle();
      this.offCoordinatorIdle = null;
    }
  }
}

function dataUrlToBase64Cycle(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function safeParseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const agentLoop = new AgentLoop();
