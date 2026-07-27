import { runAssistantChatTurn } from './chatTurn';
import { formatGapJa, getLastTurnInfo } from './replyContext';
import { playGreeting } from './greeting';
import { getActiveSessionId, getGreetOnLaunch } from './userPreferences';

// Phase 6 / 7 — context-aware welcome-back arbiter.

/**
 * Below this gap, just play the cached static greeting — no API call.
 *
 * Phase-10 bumped 5 min → 30 min. A 5-minute threshold meant every
 * quick app restart (closed by accident, re-opened, switched tray
 * settings) cost a full `$0.45` Anthropic chat call to greet the
 * operator who had only stepped away long enough to lock the screen.
 * Half an hour better matches the persona's "she really wasn't sure
 * if you were coming back" framing — anything shorter is recovered
 * by the cached greeting and the (newly cache-warm) regular chat
 * pathway when the operator types something.
 */
const SHORT_GAP_MS = 30 * 60_000;

/** Above this gap, prepend a "long absence" framing note. */
const LONG_GAP_MS = 6 * 60 * 60_000;

function buildWelcomeBackUserLine(args: {
  gapMs: number;
}): string {
  const gap = formatGapJa(args.gapMs);
  const isLong = args.gapMs >= LONG_GAP_MS;
  const lines: string[] = [
    '[系統／起動 — おかえり挨拶]',
    '',
    'アプリが今ちょうど起動した。前回彼と話してから、または最後に観察してから ' +
      `${gap} 経っている。彼は新しいセッションを始めたわけではないので、君はずっと` +
      'これまでの文脈を覚えている設定 (記憶 DB が彼のマシンに残っている)。',
    '',
    '今、彼はちょうど画面の前に戻ってきたところ。新しい画面の様子は自動スクリーン' +
      'ショットとして添付してあるから、何をしているか見てから話しかけてあげて。',
    '',
    '今回のあなたの返答は「彼にかける最初のひとこと」になる。普通に「おかえり」とか' +
      '「久しぶりだね」みたいな硬い枕詞は要らない。澪らしい、自然で短い、人間っぽい' +
      'ひとこと一つか二つ。',
    isLong
      ? `${gap} のブランクを軽く拾ってもいい (例：「ねえ、久しぶり……元気にしてた？」)。重く' +
        'ならないように。最後の観察ノートを覚えていれば、その流れでも自然。`
      : `短いブランクなので、わざわざ時間に触れる必要はない — 普通に部屋に戻ってきた人に` +
        '声をかける感覚で大丈夫。',
    '',
    '日本語で。一つか二つの短い文。前置き禁止。',
  ];
  return lines.join('\n');
}

/**
 * Decide between cached greeting and API-driven welcome-back, then
 * run it. Best-effort — any failure short-circuits to the cached
 * greeting so the operator never sees a silent app on launch.
 */
export async function welcomeOnLaunch(): Promise<void> {
  if (!getGreetOnLaunch()) return;

  try {
    const sessionId = getActiveSessionId();
    const last = getLastTurnInfo(sessionId);
    if (!last) {
      await playGreeting({ persist: true });
      return;
    }

    const gapMs = Date.now() - last.createdAt;
    if (gapMs < SHORT_GAP_MS) {
      await playGreeting({ persist: false });
      return;
    }

    const text = buildWelcomeBackUserLine({ gapMs });
    await runAssistantChatTurn({
      text,
      options: { includeAutoScreenshot: true },
      kind: 'auto',
      pathway: 'welcome_back',
    });
  } catch (err) {
    console.warn('[welcome-back] generation failed, falling back to greeting', err);
    try {
      await playGreeting({ persist: false });
    } catch (fallbackErr) {
      console.error('[welcome-back] cached greeting also failed', fallbackErr);
    }
  }
}
