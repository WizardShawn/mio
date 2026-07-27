import type { ReplyMood } from '@shared/protocol';

// Best-effort mood detection over Mio's Japanese reply text.

interface MoodSignal {
  mood: ReplyMood;
  weight: number;
  pattern: RegExp;
}

const SIGNALS: readonly MoodSignal[] = [
  { mood: 'playful', weight: 3, pattern: /(?:ふ|う|に)(?:ふ|ふっ|っ|や|ゃ)+/u },
  { mood: 'playful', weight: 2, pattern: /っていうのはどう|どうかな|どうでしょう/u },
  { mood: 'playful', weight: 2, pattern: /^もう[…、]/mu },
  { mood: 'playful', weight: 3, pattern: /てへ|えへへ|えへ/u },

  { mood: 'amused', weight: 4, pattern: /あはは|ははは|くすっ|ふふっ|笑っ|笑い/u },
  { mood: 'amused', weight: 3, pattern: /www+|笑w/u },

  { mood: 'shy', weight: 4, pattern: /恥ずか|照れ|赤くな|顔が熱/u },
  { mood: 'shy', weight: 2, pattern: /^(?:あ|え|う|そ)っと[…、]/mu },
  { mood: 'shy', weight: 2, pattern: /[／／]{2,}/u },
  { mood: 'shy', weight: 2, pattern: /ちょ、ちょっと|ちょっ、/u },
  { mood: 'shy', weight: 1, pattern: /反則|ずるい/u },

  { mood: 'warm', weight: 4, pattern: /嬉しい|大好き|愛して|大切/u },
  { mood: 'warm', weight: 4, pattern: /よしよし|いい子|偉い/u },
  { mood: 'warm', weight: 1, pattern: /ありがとう|ありがと/u },
  { mood: 'warm', weight: 2, pattern: /^そっか[。…]?$/mu },

  { mood: 'concerned', weight: 4, pattern: /大丈夫\?|大丈夫？|心配|疲れ|休んで|ちゃんと食べ/u },
  { mood: 'concerned', weight: 3, pattern: /無理(?:しない|だけは|しちゃ)|頑張りすぎ/u },
  { mood: 'concerned', weight: 2, pattern: /また[…、]?同じ|もう[一いち]時間/u },

  { mood: 'thinking', weight: 4, pattern: /ちょっと待って|うーん|そうだね[…、]|考えて|なるほど/u },
  { mood: 'thinking', weight: 2, pattern: /えっと[…、]|ええと[…、]/u },

  { mood: 'firm', weight: 4, pattern: /それは違う|違うでしょ|違うよ|ダメ(?:だ|だよ|でしょ)/u },
  { mood: 'firm', weight: 3, pattern: /(?:良|よ)くない(?:よ|ね|でしょ)?[。、]?/u },
  { mood: 'firm', weight: 3, pattern: /やめた方がいい|止めた方がいい|危ない/u },
  { mood: 'firm', weight: 2, pattern: /^待って[。！]/mu },
];

const QUESTION_HINT = /[?？]/u;

export function detectReplyMood(jaText: string): ReplyMood {
  if (!jaText) return 'neutral';

  const scores = new Map<ReplyMood, number>();
  for (const signal of SIGNALS) {
    if (!signal.pattern.test(jaText)) continue;
    const prev = scores.get(signal.mood) ?? 0;
    scores.set(signal.mood, prev + signal.weight);
  }

  if (scores.size === 0) {
    if (QUESTION_HINT.test(jaText) && jaText.length < 60) {
      return 'thinking';
    }
    return 'neutral';
  }

  let best: ReplyMood = 'neutral';
  let bestScore = -1;
  for (const [mood, score] of scores) {
    if (score > bestScore) {
      best = mood;
      bestScore = score;
    }
  }
  return best;
}

export function moodFromGestureToneList(
  toneList: readonly string[],
): ReplyMood {
  if (toneList.includes('shy')) return 'shy';
  if (toneList.includes('ticklish')) return 'amused';
  if (toneList.includes('affectionate')) return 'warm';
  return 'playful';
}
