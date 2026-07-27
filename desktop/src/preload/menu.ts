import { contextBridge, ipcRenderer } from 'electron';

import {
  IpcChannels,
  type MenuApi,
  type TrayMenuState,
} from '@shared/ipc';

const menuApi: MenuApi = {
  onState(handler) {
    const listener = (_: unknown, state: TrayMenuState) => handler(state);
    ipcRenderer.on(IpcChannels.TrayMenuStateEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.TrayMenuStateEvent, listener);
  },
  toggleAvatar(): void {
    ipcRenderer.send(IpcChannels.TrayMenuToggleAvatar);
  },
  openSettings(): void {
    ipcRenderer.send(IpcChannels.TrayMenuOpenSettings);
  },
  togglePauseAgent(): void {
    ipcRenderer.send(IpcChannels.TrayMenuTogglePauseAgent);
  },
  quit(): void {
    ipcRenderer.send(IpcChannels.TrayMenuQuit);
  },
  close(): void {
    ipcRenderer.send(IpcChannels.TrayMenuClose);
  },
};

contextBridge.exposeInMainWorld('menuApi', menuApi);
