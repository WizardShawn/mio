import { getPermissionWindowBounds } from '../computerUseStatus';
import { getHost } from '../host';
import { getPermissionPrefs } from '../userPreferences';
import { toScreen } from './executor';

// The in-session watchdog.

export interface WatchdogVerdict {
  verdict: 'ok' | 'prompt' | 'block';
  reason: string;
}

export async function screenAction(
  target: { x: number; y: number } | null,
): Promise<WatchdogVerdict> {
  // 1. Hard block — never click Mio's own approval popup.
  if (target) {
    const bounds = getPermissionWindowBounds();
    if (bounds) {
      const p = toScreen(target.x, target.y);
      if (
        p.x >= bounds.x &&
        p.x <= bounds.x + bounds.width &&
        p.y >= bounds.y &&
        p.y <= bounds.y + bounds.height
      ) {
        return {
          verdict: 'block',
          reason: "That action would land on Mio's own approval window — refused.",
        };
      }
    }
  }

  // 2. Sensitive foreground app — re-prompt.
  const title = (await getHost().sensors.getActiveWindowTitle().catch(() => null)) ?? '';
  if (title) {
    const lower = title.toLowerCase();
    for (const word of getPermissionPrefs().sensitiveApps) {
      if (word && lower.includes(word.toLowerCase())) {
        return {
          verdict: 'prompt',
          reason: `The active window "${title}" looks sensitive (matched "${word}").`,
        };
      }
    }
  }

  return { verdict: 'ok', reason: '' };
}
