import { contextBridge, ipcRenderer } from 'electron';

import {
  IpcChannels,
  type AgentPrefs,
  type AgentStatus,
  type ApiKeyStatus,
  type AuditEntry,
  type ChatSession,
  type ComfyUiPrefs,
  type GesturePrefs,
  type MemoryContextStats,
  type MobilePairingPayload,
  type PermissionPrefs,
  type SettingsApi,
} from '@shared/ipc';

const settingsApi: SettingsApi = {
  apiKey: {
    status(): Promise<ApiKeyStatus> {
      return ipcRenderer.invoke(IpcChannels.ApiKeyGetStatus);
    },
    set(key: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IpcChannels.ApiKeySet, key);
    },
    clear(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke(IpcChannels.ApiKeyClear);
    },
  },
  geminiKey: {
    status(): Promise<ApiKeyStatus> {
      return ipcRenderer.invoke(IpcChannels.GeminiKeyGetStatus);
    },
    set(key: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IpcChannels.GeminiKeySet, key);
    },
    clear(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke(IpcChannels.GeminiKeyClear);
    },
  },
  comfyCloudKey: {
    status(): Promise<ApiKeyStatus> {
      return ipcRenderer.invoke(IpcChannels.ComfyCloudKeyGetStatus);
    },
    set(key: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IpcChannels.ComfyCloudKeySet, key);
    },
    clear(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke(IpcChannels.ComfyCloudKeyClear);
    },
  },
  userDisplayName: {
    get(): Promise<string> {
      return ipcRenderer.invoke(IpcChannels.UserPrefsGetDisplayName);
    },
    set(name: string): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.UserPrefsSetDisplayName, name);
    },
  },
  gesturePrefs: {
    get(): Promise<GesturePrefs> {
      return ipcRenderer.invoke(IpcChannels.GesturePrefsGet);
    },
    set(prefs: GesturePrefs): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.GesturePrefsSet, prefs);
    },
  },
  sessions: {
    list(): Promise<ChatSession[]> {
      return ipcRenderer.invoke(IpcChannels.SessionsList);
    },
    getActive(): Promise<string | null> {
      return ipcRenderer.invoke(IpcChannels.SessionsGetActive);
    },
    create(): Promise<ChatSession> {
      return ipcRenderer.invoke(IpcChannels.SessionsCreate);
    },
    activate(id: string): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.SessionsActivate, id);
    },
    rename(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IpcChannels.SessionsRename, id, title);
    },
    remove(id: string): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.SessionsDelete, id);
    },
    clearAll(): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.SessionsClearAll);
    },
  },
  greeting: {
    get(): Promise<{ effective: string; override: string }> {
      return ipcRenderer.invoke(IpcChannels.GreetingGet);
    },
    setOverride(text: string): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.GreetingSetOverride, text);
    },
    getPlayOnLaunch(): Promise<boolean> {
      return ipcRenderer.invoke(IpcChannels.GreetingGetPlayOnLaunch);
    },
    setPlayOnLaunch(value: boolean): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.GreetingSetPlayOnLaunch, value);
    },
    trigger(): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.GreetingTrigger);
    },
  },
  agent: {
    prefsGet(): Promise<AgentPrefs> {
      return ipcRenderer.invoke(IpcChannels.AgentPrefsGet);
    },
    prefsSet(prefs: AgentPrefs): Promise<AgentPrefs> {
      return ipcRenderer.invoke(IpcChannels.AgentPrefsSet, prefs);
    },
    statusGet(): Promise<AgentStatus> {
      return ipcRenderer.invoke(IpcChannels.AgentStatusGet);
    },
    runNow(): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.AgentRunNow);
    },
    pauseToggle(): Promise<AgentStatus> {
      return ipcRenderer.invoke(IpcChannels.AgentPauseToggle);
    },
    onStatus(handler) {
      const listener = (_: unknown, status: AgentStatus) => handler(status);
      ipcRenderer.on(IpcChannels.AgentStatusEvent, listener);
      return () => ipcRenderer.removeListener(IpcChannels.AgentStatusEvent, listener);
    },
    contextStats(): Promise<MemoryContextStats> {
      return ipcRenderer.invoke(IpcChannels.AgentContextStatsGet);
    },
  },
  permission: {
    prefsGet(): Promise<PermissionPrefs> {
      return ipcRenderer.invoke(IpcChannels.PermissionPrefsGet);
    },
    prefsSet(prefs: PermissionPrefs): Promise<PermissionPrefs> {
      return ipcRenderer.invoke(IpcChannels.PermissionPrefsSet, prefs);
    },
    pickWorkspace(): Promise<string | null> {
      return ipcRenderer.invoke(IpcChannels.PermissionPickWorkspace);
    },
    auditGet(): Promise<AuditEntry[]> {
      return ipcRenderer.invoke(IpcChannels.AuditLogGet);
    },
  },
  comfyui: {
    prefsGet(): Promise<ComfyUiPrefs> {
      return ipcRenderer.invoke(IpcChannels.ComfyUiPrefsGet);
    },
    prefsSet(prefs: ComfyUiPrefs): Promise<ComfyUiPrefs> {
      return ipcRenderer.invoke(IpcChannels.ComfyUiPrefsSet, prefs);
    },
    testConnection(): Promise<{ ok: boolean; detail: string }> {
      return ipcRenderer.invoke(IpcChannels.ComfyUiTestConnection);
    },
  },
  pairing: {
    issueQr(): Promise<MobilePairingPayload> {
      return ipcRenderer.invoke(IpcChannels.PairingIssueQr);
    },
    listDevices(): Promise<string[]> {
      return ipcRenderer.invoke(IpcChannels.PairingListDevices);
    },
  },
  close(): void {
    ipcRenderer.send(IpcChannels.SettingsClose);
  },
};

contextBridge.exposeInMainWorld('settingsApi', settingsApi);
