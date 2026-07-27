import { app, BrowserWindow, globalShortcut } from 'electron';

import { IpcChannels } from '@shared/ipc';
import { showChatNearAvatar } from './windows';

// Hotkey choice: Ctrl+Enter is the agreed user shortcut. We register the
// Electron alias `Control+Return` (Electron normalises the Enter key to
// "Return" in accelerators). The chat surface itself lives permanently
// under the avatar's feet — this hotkey TOGGLES the input pill: first
// press summons it (with focus), second press dismisses it. We emit a
// `ChatToggleInput` IPC on every press; the renderer owns the
// visible-state decision because main has no view into the on-screen
// pill state and Electron's `chat.focus()` alone wouldn't re-fire the
// DOM `focus` event when the chat window is already focused.
const CHAT_TOGGLE_HOTKEY = 'Control+Return';

export function registerHotkeys(opts: {
  avatar: BrowserWindow;
  chat: BrowserWindow;
}): void {
  const ok = globalShortcut.register(CHAT_TOGGLE_HOTKEY, () => {
    const { chat, avatar } = opts;
    showChatNearAvatar(chat, avatar);
    if (!chat.isDestroyed()) {
      chat.webContents.send(IpcChannels.ChatToggleInput);
    }
  });

  if (!ok) {
    console.warn(
      `[hotkey] Failed to register ${CHAT_TOGGLE_HOTKEY}. ` +
        'Another app may already own it. Open chat via the tray icon.',
    );
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
