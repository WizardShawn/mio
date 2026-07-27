import { contextBridge, ipcRenderer } from 'electron';

import {
  IpcChannels,
  type ApiKeyStatus,
  type ChatApi,
  type ChatMessage,
  type ChatSendOptions,
  type ChatStreamEvent,
  type ChatToolActivityPayload,
  type ReplyCaptionPayload,
  type ReplyChunkPayload,
  type UtterancePayload,
} from '@shared/ipc';

const chatApi: ChatApi = {
  sendMessage(text: string, options?: ChatSendOptions): Promise<void> {
    return ipcRenderer.invoke(IpcChannels.ChatSendMessage, text, options);
  },
  cancelStream(): void {
    ipcRenderer.send(IpcChannels.ChatCancel);
  },
  onStreamEvent(handler) {
    const listener = (_: unknown, event: ChatStreamEvent) => handler(event);
    ipcRenderer.on(IpcChannels.ChatStreamEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatStreamEvent, listener);
  },
  onToggleInput(handler) {
    const listener = () => handler();
    ipcRenderer.on(IpcChannels.ChatToggleInput, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatToggleInput, listener);
  },
  onPlayUtterance(handler) {
    const listener = (_: unknown, payload: UtterancePayload) => handler(payload);
    ipcRenderer.on(IpcChannels.ChatPlayUtterance, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatPlayUtterance, listener);
  },
  onReplyCaption(handler) {
    const listener = (_: unknown, payload: ReplyCaptionPayload) => handler(payload);
    ipcRenderer.on(IpcChannels.ChatReplyCaption, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatReplyCaption, listener);
  },
  onReplyChunk(handler) {
    const listener = (_: unknown, payload: ReplyChunkPayload) => handler(payload);
    ipcRenderer.on(IpcChannels.ChatReplyChunk, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatReplyChunk, listener);
  },
  onShowWarning(handler) {
    const listener = (_: unknown, message: string) => handler(message);
    ipcRenderer.on(IpcChannels.ChatShowWarning, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatShowWarning, listener);
  },
  onToolActivity(handler) {
    const listener = (_: unknown, payload: ChatToolActivityPayload) => handler(payload);
    ipcRenderer.on(IpcChannels.ChatToolActivity, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatToolActivity, listener);
  },
  getHistory(): Promise<ChatMessage[]> {
    return ipcRenderer.invoke(IpcChannels.ChatGetHistory);
  },
  clearHistory(): Promise<void> {
    return ipcRenderer.invoke(IpcChannels.ChatClearHistory);
  },
  dismiss(): void {
    ipcRenderer.send(IpcChannels.ChatDismiss);
  },
  openSettings(): void {
    ipcRenderer.send(IpcChannels.SettingsOpen);
  },
  setMouseIgnore(ignore: boolean): void {
    ipcRenderer.send(IpcChannels.WindowSetMouseIgnore, ignore);
  },
  apiKey: {
    status(): Promise<ApiKeyStatus> {
      return ipcRenderer.invoke(IpcChannels.ApiKeyGetStatus);
    },
  },
};

contextBridge.exposeInMainWorld('chatApi', chatApi);
