import type { MenuApi, TrayMenuState } from '@shared/ipc';

declare global {
  interface Window {
    menuApi: MenuApi;
  }
}

const menuApi = window.menuApi;

const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const avatarToggleLabel = document.getElementById('avatar-toggle-label');
const agentToggleLabel = document.getElementById('agent-toggle-label');
const agentIcon = document.getElementById('agent-icon');

function applyState(state: TrayMenuState): void {
  if (statusDot) {
    statusDot.setAttribute('data-tone', state.statusTone);
  }
  if (statusLabel) {
    statusLabel.textContent = state.statusLabel;
  }
  if (avatarToggleLabel) {
    avatarToggleLabel.textContent = state.avatarVisible ? 'Hide avatar' : 'Show avatar';
  }
  if (agentToggleLabel) {
    agentToggleLabel.textContent = state.agentPaused ? 'Resume agent' : 'Pause agent';
  }
  // Swap the agent icon between || (pause) and ▶ (resume).
  if (agentIcon) {
    if (state.agentPaused) {
      agentIcon.innerHTML =
        '<path d="M6 4.5 14.5 10 6 15.5z" />';
    } else {
      agentIcon.innerHTML =
        '<rect x="6" y="5" width="2.5" height="10" rx="0.6" />' +
        '<rect x="11.5" y="5" width="2.5" height="10" rx="0.6" />';
    }
  }
}

menuApi.onState(applyState);

document.querySelectorAll<HTMLButtonElement>('.item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset['action'];
    switch (action) {
      case 'toggle-avatar':
        menuApi.toggleAvatar();
        break;
      case 'toggle-pause-agent':
        menuApi.togglePauseAgent();
        break;
      case 'open-settings':
        menuApi.openSettings();
        break;
      case 'quit':
        menuApi.quit();
        break;
    }
  });
});

// Close on Escape — main also auto-hides on blur, but Esc is the
// muscle-memory dismiss for keyboard users.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    menuApi.close();
  }
});

// Tell main the renderer is ready to receive state. We just leave a
// hook for now — the main process pushes a state snapshot synchronously
// right before it shows the window, so by the time `onState` is wired
// (above) the first event has either already arrived or will arrive
// before paint.
