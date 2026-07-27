import type {
  AgentPrefs,
  AgentStatus,
  ApiKeyStatus,
  AuditEntry,
  ChatSession,
  ComfyUiPrefs,
  GesturePrefs,
  PermissionPrefs,
  SettingsApi,
} from '@shared/ipc';

declare global {
  interface Window {
    settingsApi: SettingsApi;
  }
}

// ─── Sidebar page nav ────────────────────────────────────────────────
const navItems = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.nav-item'),
);
const pages = Array.from(document.querySelectorAll<HTMLElement>('.page'));

function showPage(name: string): void {
  for (const item of navItems) {
    item.classList.toggle('active', item.dataset['page'] === name);
  }
  for (const page of pages) {
    page.classList.toggle('active', page.dataset['page'] === name);
  }
}

for (const item of navItems) {
  item.addEventListener('click', () => {
    const target = item.dataset['page'];
    if (target) showPage(target);
  });
}

// ─── Element handles ─────────────────────────────────────────────────
const nameInputEl = document.getElementById('display-name-input') as HTMLInputElement;
const saveNameBtn = document.getElementById('save-name-btn') as HTMLButtonElement;
const nameFeedbackEl = document.getElementById('name-feedback') as HTMLSpanElement;

const statusEl = document.getElementById('status-line') as HTMLDivElement;
const inputEl = document.getElementById('api-key-input') as HTMLInputElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
const feedbackEl = document.getElementById('feedback') as HTMLSpanElement;

const geminiStatusEl = document.getElementById('gemini-status-line') as HTMLDivElement;
const geminiInputEl = document.getElementById('gemini-key-input') as HTMLInputElement;
const geminiSaveBtn = document.getElementById('gemini-save-btn') as HTMLButtonElement;
const geminiClearBtn = document.getElementById('gemini-clear-btn') as HTMLButtonElement;
const geminiFeedbackEl = document.getElementById('gemini-feedback') as HTMLSpanElement;

const sessionPickerEl = document.getElementById('session-picker') as HTMLSelectElement;
const sessionRenameInputEl = document.getElementById('session-rename-input') as HTMLInputElement;
const sessionRenameBtn = document.getElementById('session-rename-btn') as HTMLButtonElement;
const sessionNewBtn = document.getElementById('session-new-btn') as HTMLButtonElement;
const sessionDeleteBtn = document.getElementById('session-delete-btn') as HTMLButtonElement;
const sessionClearAllBtn = document.getElementById('session-clear-all-btn') as HTMLButtonElement;
const sessionFeedbackEl = document.getElementById('session-feedback') as HTMLSpanElement;

const greetingInputEl = document.getElementById('greeting-input') as HTMLTextAreaElement;
const greetingEffectiveEl = document.getElementById('greeting-effective') as HTMLSpanElement;
const greetingSaveBtn = document.getElementById('greeting-save-btn') as HTMLButtonElement;
const greetingPlayBtn = document.getElementById('greeting-play-btn') as HTMLButtonElement;
const greetingFeedbackEl = document.getElementById('greeting-feedback') as HTMLSpanElement;
const greetingLaunchEl = document.getElementById('greeting-launch') as HTMLInputElement;

const agentEnabledEl = document.getElementById('agent-enabled') as HTMLInputElement;
const agentIntervalEl = document.getElementById('agent-interval') as HTMLInputElement;
const agentCostCapEl = document.getElementById('agent-cost-cap') as HTMLInputElement;
const agentCycleCapEl = document.getElementById('agent-cycle-cap') as HTMLInputElement;
const agentNotifyCapEl = document.getElementById('agent-notify-cap') as HTMLInputElement;
const agentNotableChatEl = document.getElementById('agent-notable-chat') as HTMLInputElement;
const agentSaveBtn = document.getElementById('agent-save-btn') as HTMLButtonElement;
const agentRunNowBtn = document.getElementById('agent-run-now-btn') as HTMLButtonElement;
const agentPauseBtn = document.getElementById('agent-pause-btn') as HTMLButtonElement;
const agentFeedbackEl = document.getElementById('agent-feedback') as HTMLSpanElement;
const agentStateEl = document.getElementById('agent-state') as HTMLElement;
const agentReasonEl = document.getElementById('agent-reason') as HTMLElement;
const agentLastRunEl = document.getElementById('agent-last-run') as HTMLElement;
const agentNextRunEl = document.getElementById('agent-next-run') as HTMLElement;
const agentCyclesTodayEl = document.getElementById('agent-cycles-today') as HTMLElement;
const agentImagesTodayEl = document.getElementById('agent-images-today') as HTMLElement;
const agentCostTodayEl = document.getElementById('agent-cost-today') as HTMLElement;
const agentErrorsEl = document.getElementById('agent-errors') as HTMLElement;
const agentContextTokensEl = document.getElementById('agent-context-tokens') as HTMLElement;

const gesturesEnabledEl = document.getElementById('gestures-enabled') as HTMLInputElement;
const gesturePrefsFeedbackEl = document.getElementById('gesture-prefs-feedback') as HTMLSpanElement;

// ─── Helpers ─────────────────────────────────────────────────────────
function setFeedback(
  el: HTMLSpanElement,
  msg: string,
  kind: 'success' | 'error' | 'neutral',
): void {
  el.textContent = msg;
  el.className = `feedback ${kind === 'neutral' ? '' : kind}`;
  if (msg) {
    setTimeout(() => {
      el.textContent = '';
      el.className = 'feedback';
    }, 2400);
  }
}

function applyApiKeyStatus(target: HTMLDivElement, status: ApiKeyStatus, label: string): void {
  target.className = 'status';
  if (!status.encryptionAvailable) {
    target.classList.add('no-encryption');
    target.textContent = `OS encryption unavailable — use env var for ${label}.`;
    return;
  }
  if (status.hasKey) {
    target.classList.add('has-key');
    target.textContent = `A ${label} key is stored (encrypted via Windows DPAPI).`;
  } else {
    target.classList.add('no-key');
    target.textContent = `No ${label} key stored yet.`;
  }
}

// ─── User display name ───────────────────────────────────────────────
saveNameBtn.addEventListener('click', async () => {
  await window.settingsApi.userDisplayName.set(nameInputEl.value);
  nameInputEl.value = (await window.settingsApi.userDisplayName.get()) ?? '';
  setFeedback(nameFeedbackEl, 'Saved.', 'success');
});

nameInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveNameBtn.click();
  } else if (e.key === 'Escape') {
    window.settingsApi.close();
  }
});

async function loadDisplayName(): Promise<void> {
  nameInputEl.value = (await window.settingsApi.userDisplayName.get()) ?? '';
}

// ─── Anthropic API key ───────────────────────────────────────────────
async function refreshApiStatus(): Promise<void> {
  applyApiKeyStatus(statusEl, await window.settingsApi.apiKey.status(), 'Anthropic');
}

saveBtn.addEventListener('click', async () => {
  const key = inputEl.value.trim();
  if (!key) {
    setFeedback(feedbackEl, 'Enter a key first.', 'error');
    return;
  }
  const result = await window.settingsApi.apiKey.set(key);
  if (result.ok) {
    inputEl.value = '';
    setFeedback(feedbackEl, 'Saved.', 'success');
    void refreshApiStatus();
  } else {
    setFeedback(feedbackEl, result.error ?? 'Save failed.', 'error');
  }
});

clearBtn.addEventListener('click', async () => {
  await window.settingsApi.apiKey.clear();
  setFeedback(feedbackEl, 'Cleared.', 'success');
  void refreshApiStatus();
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveBtn.click();
  } else if (e.key === 'Escape') {
    window.settingsApi.close();
  }
});

// ─── Gemini API key ──────────────────────────────────────────────────
async function refreshGeminiStatus(): Promise<void> {
  applyApiKeyStatus(geminiStatusEl, await window.settingsApi.geminiKey.status(), 'Gemini');
}

geminiSaveBtn.addEventListener('click', async () => {
  const key = geminiInputEl.value.trim();
  if (!key) {
    setFeedback(geminiFeedbackEl, 'Enter a key first.', 'error');
    return;
  }
  const result = await window.settingsApi.geminiKey.set(key);
  if (result.ok) {
    geminiInputEl.value = '';
    setFeedback(geminiFeedbackEl, 'Saved.', 'success');
    void refreshGeminiStatus();
  } else {
    setFeedback(geminiFeedbackEl, result.error ?? 'Save failed.', 'error');
  }
});

geminiClearBtn.addEventListener('click', async () => {
  await window.settingsApi.geminiKey.clear();
  setFeedback(geminiFeedbackEl, 'Cleared.', 'success');
  void refreshGeminiStatus();
});

geminiInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    geminiSaveBtn.click();
  } else if (e.key === 'Escape') {
    window.settingsApi.close();
  }
});

// ─── ComfyUI (image generation) ──────────────────────────────────────
const comfyEnabledEl = document.getElementById('comfyui-enabled') as HTMLInputElement;
const comfyServerUrlEl = document.getElementById('comfyui-server-url') as HTMLInputElement;
const comfyDailyCapEl = document.getElementById('comfyui-daily-cap') as HTMLInputElement;
const comfyOverlaySecsEl = document.getElementById('comfyui-overlay-secs') as HTMLInputElement;
const comfySaveBtn = document.getElementById('comfyui-save-btn') as HTMLButtonElement;
const comfyTestBtn = document.getElementById('comfyui-test-btn') as HTMLButtonElement;
const comfyFeedbackEl = document.getElementById('comfyui-feedback') as HTMLSpanElement;

// Comfy Cloud API key — Partner-Node credential, separate slot from
// the local server URL. Same paste-once / status / clear pattern as
// the Anthropic + Gemini key cards.
const comfyCloudStatusEl = document.getElementById('comfy-cloud-status-line') as HTMLDivElement;
const comfyCloudInputEl = document.getElementById('comfy-cloud-key-input') as HTMLInputElement;
const comfyCloudSaveBtn = document.getElementById('comfy-cloud-save-btn') as HTMLButtonElement;
const comfyCloudClearBtn = document.getElementById('comfy-cloud-clear-btn') as HTMLButtonElement;
const comfyCloudFeedbackEl = document.getElementById('comfy-cloud-feedback') as HTMLSpanElement;

function applyComfyUiPrefs(prefs: ComfyUiPrefs): void {
  comfyEnabledEl.checked = prefs.enabled;
  comfyServerUrlEl.value = prefs.serverUrl;
  comfyDailyCapEl.value = String(prefs.dailyImageCap);
  comfyOverlaySecsEl.value = String(prefs.imageOverlayAutoDismissSec);
}

function readComfyUiForm(): ComfyUiPrefs {
  return {
    enabled: comfyEnabledEl.checked,
    serverUrl: comfyServerUrlEl.value.trim() || 'http://127.0.0.1:8000',
    dailyImageCap: Math.max(1, Number(comfyDailyCapEl.value) || 50),
    imageOverlayAutoDismissSec: Math.max(5, Number(comfyOverlaySecsEl.value) || 60),
  };
}

async function loadComfyUi(): Promise<void> {
  applyComfyUiPrefs(await window.settingsApi.comfyui.prefsGet());
}

comfySaveBtn.addEventListener('click', async () => {
  const saved = await window.settingsApi.comfyui.prefsSet(readComfyUiForm());
  applyComfyUiPrefs(saved);
  setFeedback(comfyFeedbackEl, 'Saved.', 'success');
});

comfyTestBtn.addEventListener('click', async () => {
  setFeedback(comfyFeedbackEl, 'Testing…', 'neutral');
  try {
    // Persist current edits first so the probe uses what's on screen
    // (the probe reads userPreferences). Skip the save toast — the
    // probe result is the user-facing feedback for this button.
    await window.settingsApi.comfyui.prefsSet(readComfyUiForm());
    const result = await window.settingsApi.comfyui.testConnection();
    setFeedback(
      comfyFeedbackEl,
      result.detail,
      result.ok ? 'success' : 'error',
    );
  } catch (err) {
    setFeedback(
      comfyFeedbackEl,
      err instanceof Error ? err.message : 'Probe failed.',
      'error',
    );
  }
});

[comfyServerUrlEl, comfyDailyCapEl, comfyOverlaySecsEl].forEach((el) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      comfySaveBtn.click();
    } else if (e.key === 'Escape') {
      window.settingsApi.close();
    }
  });
});

// ─── Comfy Cloud API key ─────────────────────────────────────────────
async function refreshComfyCloudStatus(): Promise<void> {
  applyApiKeyStatus(
    comfyCloudStatusEl,
    await window.settingsApi.comfyCloudKey.status(),
    'Comfy Cloud',
  );
}

comfyCloudSaveBtn.addEventListener('click', async () => {
  const key = comfyCloudInputEl.value.trim();
  if (!key) {
    setFeedback(comfyCloudFeedbackEl, 'Enter a key first.', 'error');
    return;
  }
  const result = await window.settingsApi.comfyCloudKey.set(key);
  if (result.ok) {
    comfyCloudInputEl.value = '';
    setFeedback(comfyCloudFeedbackEl, 'Saved.', 'success');
    void refreshComfyCloudStatus();
  } else {
    setFeedback(comfyCloudFeedbackEl, result.error ?? 'Save failed.', 'error');
  }
});

comfyCloudClearBtn.addEventListener('click', async () => {
  await window.settingsApi.comfyCloudKey.clear();
  setFeedback(comfyCloudFeedbackEl, 'Cleared.', 'success');
  void refreshComfyCloudStatus();
});

comfyCloudInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    comfyCloudSaveBtn.click();
  } else if (e.key === 'Escape') {
    window.settingsApi.close();
  }
});

// ─── Sessions ────────────────────────────────────────────────────────
// Phase-10 — the stamp shown next to the title is now the session's
// *first message* time (= `created_at`, pinned by `appendMessage`'s
// MIN(created_at, ?) write-side invariant), not the most recent
// activity. Operators read the dropdown as a session identity ("the
// 初対話 I started on May 20"), not a "last touched" feed; the prior
// updatedAt behavior made every session look like it had started today.
function formatSessionLabel(s: ChatSession): string {
  const d = new Date(s.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${s.title} · ${stamp}`;
}

async function loadSessions(): Promise<void> {
  const [sessions, activeId] = await Promise.all([
    window.settingsApi.sessions.list(),
    window.settingsApi.sessions.getActive(),
  ]);
  sessionPickerEl.innerHTML = '';
  if (sessions.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No sessions yet — start one with "New session".';
    sessionPickerEl.appendChild(opt);
    sessionPickerEl.disabled = true;
    sessionDeleteBtn.disabled = true;
    sessionRenameInputEl.disabled = true;
    sessionRenameBtn.disabled = true;
    sessionRenameInputEl.value = '';
    return;
  }
  sessionPickerEl.disabled = false;
  sessionDeleteBtn.disabled = false;
  sessionRenameInputEl.disabled = false;
  sessionRenameBtn.disabled = false;
  for (const s of sessions) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.dataset.title = s.title;
    opt.textContent = formatSessionLabel(s);
    if (s.id === activeId) opt.selected = true;
    sessionPickerEl.appendChild(opt);
  }
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  sessionRenameInputEl.value = active?.title ?? '';
}

sessionPickerEl.addEventListener('change', async () => {
  const id = sessionPickerEl.value;
  if (!id) return;
  await window.settingsApi.sessions.activate(id);
  const sel = sessionPickerEl.selectedOptions[0];
  sessionRenameInputEl.value = sel?.dataset.title ?? '';
  setFeedback(sessionFeedbackEl, 'Activated.', 'success');
});

sessionRenameBtn.addEventListener('click', async () => {
  const id = sessionPickerEl.value;
  if (!id) return;
  const result = await window.settingsApi.sessions.rename(id, sessionRenameInputEl.value);
  if (result.ok) {
    await loadSessions();
    setFeedback(sessionFeedbackEl, 'Renamed.', 'success');
  } else {
    setFeedback(sessionFeedbackEl, result.error ?? 'Rename failed.', 'error');
  }
});

sessionRenameInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sessionRenameBtn.click();
  } else if (e.key === 'Escape') {
    window.settingsApi.close();
  }
});

sessionNewBtn.addEventListener('click', async () => {
  await window.settingsApi.sessions.create();
  await loadSessions();
  setFeedback(sessionFeedbackEl, 'New session started.', 'success');
});

sessionDeleteBtn.addEventListener('click', async () => {
  const id = sessionPickerEl.value;
  if (!id) return;
  await window.settingsApi.sessions.remove(id);
  await loadSessions();
});

sessionClearAllBtn.addEventListener('click', async () => {
  await window.settingsApi.sessions.clearAll();
  await loadSessions();
});

// ─── Greeting ────────────────────────────────────────────────────────
async function loadGreeting(): Promise<void> {
  const [data, playOnLaunch] = await Promise.all([
    window.settingsApi.greeting.get(),
    window.settingsApi.greeting.getPlayOnLaunch(),
  ]);
  greetingInputEl.value = data.override;
  greetingEffectiveEl.textContent = data.effective || '(none — set one in persona.md)';
  greetingLaunchEl.checked = playOnLaunch;
}

greetingSaveBtn.addEventListener('click', async () => {
  await window.settingsApi.greeting.setOverride(greetingInputEl.value);
  await loadGreeting();
  setFeedback(greetingFeedbackEl, 'Saved.', 'success');
});

greetingPlayBtn.addEventListener('click', async () => {
  await window.settingsApi.greeting.trigger();
  setFeedback(greetingFeedbackEl, 'Playing…', 'neutral');
});

greetingLaunchEl.addEventListener('change', async () => {
  await window.settingsApi.greeting.setPlayOnLaunch(greetingLaunchEl.checked);
  setFeedback(greetingFeedbackEl, 'Saved.', 'success');
});

// ─── Agent ───────────────────────────────────────────────────────────
function formatTimestamp(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function applyAgentStatus(status: AgentStatus): void {
  agentStateEl.textContent = status.state;
  agentReasonEl.textContent = status.reason ?? '—';
  agentLastRunEl.textContent = formatTimestamp(status.lastRunAt);
  agentNextRunEl.textContent = formatTimestamp(status.nextRunAt);
  agentCyclesTodayEl.textContent = String(status.cyclesToday);
  agentImagesTodayEl.textContent = `${status.imagesToday} / ${status.dailyImageCap}`;
  // Phase 10 — auto-surface a cap warning in the same cell when the
  // daily image cap is hit. The status HUD is the operator's only
  // ambient view of how close Mio is to running out of draws.
  if (status.imagesToday >= status.dailyImageCap && status.dailyImageCap > 0) {
    agentImagesTodayEl.title = 'Daily image cap reached — generation pauses until midnight.';
    agentImagesTodayEl.style.color = 'var(--error)';
  } else {
    agentImagesTodayEl.removeAttribute('title');
    agentImagesTodayEl.style.color = '';
  }
  agentCostTodayEl.textContent = `$${status.estimatedCostUsdToday.toFixed(2)}`;
  agentErrorsEl.textContent = String(status.consecutiveErrors);
}

function readAgentForm(): AgentPrefs {
  return {
    enabled: agentEnabledEl.checked,
    intervalMinutes: Math.max(1, Number(agentIntervalEl.value) || 10),
    dailyCostCapUsd: Math.max(0, Number(agentCostCapEl.value) || 0),
    hourlyCycleCap: Math.max(1, Number(agentCycleCapEl.value) || 12),
    hourlyNotifyCap: Math.max(0, Number(agentNotifyCapEl.value) || 0),
    notableCheckInChat: agentNotableChatEl.checked,
  };
}

function writeAgentForm(prefs: AgentPrefs): void {
  agentEnabledEl.checked = prefs.enabled;
  agentIntervalEl.value = String(prefs.intervalMinutes);
  agentCostCapEl.value = String(prefs.dailyCostCapUsd);
  agentCycleCapEl.value = String(prefs.hourlyCycleCap);
  agentNotifyCapEl.value = String(prefs.hourlyNotifyCap);
  agentNotableChatEl.checked = prefs.notableCheckInChat;
}

async function loadAgentContextStats(): Promise<void> {
  try {
    const stats = await window.settingsApi.agent.contextStats();
    agentContextTokensEl.textContent =
      `~${stats.estimatedTokens.toLocaleString()} tokens · ` +
      `${stats.messageCount} messages, ${stats.observationCount} observations`;
  } catch {
    agentContextTokensEl.textContent = '—';
  }
}

async function loadAgent(): Promise<void> {
  const [prefs, status] = await Promise.all([
    window.settingsApi.agent.prefsGet(),
    window.settingsApi.agent.statusGet(),
  ]);
  writeAgentForm(prefs);
  applyAgentStatus(status);
  await loadAgentContextStats();
}

agentSaveBtn.addEventListener('click', async () => {
  const prefs = await window.settingsApi.agent.prefsSet(readAgentForm());
  writeAgentForm(prefs);
  applyAgentStatus(await window.settingsApi.agent.statusGet());
  setFeedback(agentFeedbackEl, 'Saved.', 'success');
});

agentRunNowBtn.addEventListener('click', async () => {
  setFeedback(agentFeedbackEl, 'Running…', 'neutral');
  await window.settingsApi.agent.runNow();
  applyAgentStatus(await window.settingsApi.agent.statusGet());
  await loadAgentContextStats();
  setFeedback(agentFeedbackEl, 'Cycle finished.', 'success');
});

agentPauseBtn.addEventListener('click', async () => {
  const status = await window.settingsApi.agent.pauseToggle();
  applyAgentStatus(status);
});

window.settingsApi.agent.onStatus(applyAgentStatus);

// ─── Gesture prefs ───────────────────────────────────────────────────
let gesturePrefsLoaded = false;

function applyGesturePrefs(prefs: GesturePrefs): void {
  gesturesEnabledEl.checked = prefs.gesturesEnabled;
}

async function loadGesturePrefs(): Promise<void> {
  const prefs = await window.settingsApi.gesturePrefs.get();
  applyGesturePrefs(prefs);
  gesturePrefsLoaded = true;
}

async function writeGesturePrefs(): Promise<void> {
  if (!gesturePrefsLoaded) return;
  const next: GesturePrefs = {
    gesturesEnabled: gesturesEnabledEl.checked,
  };
  await window.settingsApi.gesturePrefs.set(next);
  applyGesturePrefs(next);
  setFeedback(gesturePrefsFeedbackEl, 'Saved.', 'success');
}

gesturesEnabledEl.addEventListener('change', () => void writeGesturePrefs());

// ─── Tools + Permissions ─────────────────────────────────────────────
const toolsEnabledEl = document.getElementById('tools-enabled') as HTMLInputElement;
const permissionModeEl = document.getElementById('permission-mode') as HTMLSelectElement;
const workspacePathEl = document.getElementById('workspace-path') as HTMLElement;
const workspacePickBtn = document.getElementById('workspace-pick-btn') as HTMLButtonElement;
const toolsFeedbackEl = document.getElementById('tools-feedback') as HTMLSpanElement;
const sensitiveAppsEl = document.getElementById('sensitive-apps') as HTMLTextAreaElement;
const sensitiveSaveBtn = document.getElementById('sensitive-save-btn') as HTMLButtonElement;
const sensitiveFeedbackEl = document.getElementById('sensitive-feedback') as HTMLSpanElement;
const denylistExtrasEl = document.getElementById('denylist-extras') as HTMLTextAreaElement;
const denylistSaveBtn = document.getElementById('denylist-save-btn') as HTMLButtonElement;
const grantsClearBtn = document.getElementById('grants-clear-btn') as HTMLButtonElement;
const denylistFeedbackEl = document.getElementById('denylist-feedback') as HTMLSpanElement;
const auditRefreshBtn = document.getElementById('audit-refresh-btn') as HTMLButtonElement;
const auditLogEl = document.getElementById('audit-log') as HTMLDivElement;

let permissionPrefs: PermissionPrefs | null = null;

function applyPermissionPrefs(prefs: PermissionPrefs): void {
  permissionPrefs = prefs;
  toolsEnabledEl.checked = prefs.toolsEnabled;
  permissionModeEl.value = prefs.mode;
  workspacePathEl.textContent = prefs.workspacePath;
  sensitiveAppsEl.value = prefs.sensitiveApps.join('\n');
  denylistExtrasEl.value = prefs.denylistExtras.join('\n');
}

async function savePermission(patch: Partial<PermissionPrefs>): Promise<void> {
  const base = permissionPrefs ?? (await window.settingsApi.permission.prefsGet());
  const next = await window.settingsApi.permission.prefsSet({ ...base, ...patch });
  applyPermissionPrefs(next);
}

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

toolsEnabledEl.addEventListener('change', () => {
  void savePermission({ toolsEnabled: toolsEnabledEl.checked }).then(() => {
    setFeedback(toolsFeedbackEl, 'Saved.', 'success');
  });
});

permissionModeEl.addEventListener('change', () => {
  const mode = permissionModeEl.value as PermissionPrefs['mode'];
  void savePermission({ mode }).then(() => {
    setFeedback(toolsFeedbackEl, 'Saved.', 'success');
  });
});

workspacePickBtn.addEventListener('click', async () => {
  const picked = await window.settingsApi.permission.pickWorkspace();
  if (!picked) return;
  await savePermission({ workspacePath: picked });
  setFeedback(toolsFeedbackEl, 'Workspace updated.', 'success');
});

sensitiveSaveBtn.addEventListener('click', async () => {
  await savePermission({ sensitiveApps: parseLines(sensitiveAppsEl.value) });
  setFeedback(sensitiveFeedbackEl, 'Saved.', 'success');
});

denylistSaveBtn.addEventListener('click', async () => {
  await savePermission({ denylistExtras: parseLines(denylistExtrasEl.value) });
  setFeedback(denylistFeedbackEl, 'Saved.', 'success');
});

grantsClearBtn.addEventListener('click', async () => {
  await savePermission({ allowlist: [] });
  setFeedback(denylistFeedbackEl, 'Standing grants cleared.', 'success');
});

function renderAudit(entries: AuditEntry[]): void {
  auditLogEl.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'audit-empty';
    empty.textContent = 'No tool activity yet.';
    auditLogEl.appendChild(empty);
    return;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'audit-row';

    const time = document.createElement('span');
    time.className = 'audit-time';
    const d = new Date(entry.at);
    time.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const decision = document.createElement('span');
    decision.className = `audit-decision ${entry.decision}`;
    decision.textContent = entry.decision;

    const summary = document.createElement('span');
    summary.className = 'audit-summary';
    summary.textContent = entry.summary;

    row.append(time, decision, summary);
    auditLogEl.appendChild(row);
  }
}

async function loadAudit(): Promise<void> {
  renderAudit(await window.settingsApi.permission.auditGet());
}

auditRefreshBtn.addEventListener('click', () => void loadAudit());

async function loadPermission(): Promise<void> {
  applyPermissionPrefs(await window.settingsApi.permission.prefsGet());
  await loadAudit();
}

// ─── Mobile pairing (Phase M-1) ──────────────────────────────────────
const pairingIssueBtn = document.getElementById('pairing-issue-btn') as HTMLButtonElement;
const pairingCopyBtn = document.getElementById('pairing-copy-btn') as HTMLButtonElement;
const pairingFeedbackEl = document.getElementById('pairing-feedback') as HTMLSpanElement;
const pairingOutputEl = document.getElementById('pairing-output') as HTMLDivElement;
const pairingQrEl = document.getElementById('pairing-qr') as HTMLImageElement;
const pairingHostEl = document.getElementById('pairing-host') as HTMLElement;
const pairingPortEl = document.getElementById('pairing-port') as HTMLElement;
const pairingDeviceEl = document.getElementById('pairing-device') as HTMLElement;
const pairingIssuedEl = document.getElementById('pairing-issued') as HTMLElement;
const pairingUriEl = document.getElementById('pairing-uri') as HTMLElement;
const pairingDeviceListEl = document.getElementById('pairing-device-list') as HTMLUListElement;
const pairingRefreshBtn = document.getElementById('pairing-refresh-btn') as HTMLButtonElement;

let lastPairingPayload: string | null = null;

function formatPairingTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

pairingIssueBtn.addEventListener('click', async () => {
  pairingIssueBtn.disabled = true;
  setFeedback(pairingFeedbackEl, 'Generating…', 'success');
  try {
    const payload = await window.settingsApi.pairing.issueQr();
    pairingQrEl.src = payload.qrPngDataUri;
    pairingHostEl.textContent = payload.host;
    pairingPortEl.textContent = String(payload.port);
    pairingDeviceEl.textContent = payload.deviceId;
    pairingIssuedEl.textContent = formatPairingTimestamp(payload.issuedAt);
    pairingUriEl.textContent = payload.payload;
    lastPairingPayload = payload.payload;
    pairingOutputEl.hidden = false;
    pairingCopyBtn.disabled = false;
    setFeedback(pairingFeedbackEl, 'New token issued. Scan to pair.', 'success');
    void loadPairedDevices();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate QR';
    setFeedback(pairingFeedbackEl, message, 'error');
  } finally {
    pairingIssueBtn.disabled = false;
  }
});

pairingCopyBtn.addEventListener('click', async () => {
  if (!lastPairingPayload) return;
  try {
    await navigator.clipboard.writeText(lastPairingPayload);
    setFeedback(pairingFeedbackEl, 'Payload copied.', 'success');
  } catch {
    setFeedback(pairingFeedbackEl, 'Clipboard unavailable.', 'error');
  }
});

async function loadPairedDevices(): Promise<void> {
  const ids = await window.settingsApi.pairing.listDevices();
  pairingDeviceListEl.replaceChildren();
  if (ids.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No paired devices yet.';
    pairingDeviceListEl.appendChild(li);
    return;
  }
  for (const id of ids) {
    const li = document.createElement('li');
    li.textContent = id;
    pairingDeviceListEl.appendChild(li);
  }
}

pairingRefreshBtn.addEventListener('click', () => void loadPairedDevices());

// ─── Bootstrap ───────────────────────────────────────────────────────
void loadDisplayName();
void refreshApiStatus();
void refreshGeminiStatus();
void refreshComfyCloudStatus();
void loadComfyUi();
void loadSessions();
void loadGreeting();
void loadAgent();
void loadGesturePrefs();
void loadPermission();
void loadPairedDevices();
nameInputEl.focus();
