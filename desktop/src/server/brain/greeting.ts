import type { ChatMessage, UtterancePayload } from '@shared/protocol';

import { eventBus } from '../eventBus';
import { chatService } from './chatService';
import { appendMessage } from './chatStore';
import {
  parseStartupLinesFromPersona,
  type StartupLines,
} from './persona';
import { synthesizeSpeech } from './geminiTts';
import { getGreetingOverride } from './userPreferences';
import { embedAndStoreMessage } from './recall';

// The greeting is the single line Mio speaks on every fresh session.

const PROTOCOL = 'cortana-asset';
const PROTOCOL_HOST_AUDIO = 'audio';

interface GreetingPair {
  spoken: string;
  caption: string;
}

function effectiveGreetingPair(): GreetingPair {
  const override = getGreetingOverride().trim();
  if (override.length > 0) {
    return { spoken: override, caption: override };
  }
  const lines: StartupLines = parseStartupLinesFromPersona();
  const ja = lines.ja.trim();
  const zh = lines.zh.trim();
  if (ja && zh) return { spoken: ja, caption: zh };
  if (ja) return { spoken: ja, caption: ja };
  if (zh) return { spoken: zh, caption: zh };
  return { spoken: '', caption: '' };
}

export function effectiveGreetingText(): string {
  return effectiveGreetingPair().caption;
}

function audioUrlFor(fileName: string): string {
  return `${PROTOCOL}://${PROTOCOL_HOST_AUDIO}/${encodeURIComponent(fileName)}`;
}

/**
 * Synthesize (or look up) the greeting audio for the spoken (Japanese)
 * half, then emit a play-utterance event carrying the caption (Chinese)
 * text and the audio URL. Every subscribed transport forwards the event
 * to its connected client(s).
 */
export async function playGreeting(
  options: { persist?: boolean } = {},
): Promise<void> {
  const pair = effectiveGreetingPair();
  if (!pair.caption && !pair.spoken) return;

  const cached = pair.spoken ? await synthesizeSpeech(pair.spoken) : null;
  const payload: UtterancePayload = {
    text: pair.caption,
    audioUrl: cached ? audioUrlFor(cached.fileName) : null,
  };
  eventBus.emit('chat.playUtterance', payload);

  if (!options.persist) return;
  const ja = pair.spoken.trim();
  if (ja.length > 0) {
    try {
      const sessionId = chatService.ensureSession();
      const message: ChatMessage = {
        role: 'assistant',
        content: ja,
        createdAt: Date.now(),
      };
      const messageId = appendMessage(sessionId, message);
      chatService.appendToHistoryCache(message);
      void embedAndStoreMessage({
        messageId,
        sessionId,
        content: ja,
        createdAt: message.createdAt,
      });
    } catch (err) {
      console.warn('[greeting] failed to persist greeting line', err);
    }
  }
}
