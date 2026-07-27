import { contextBridge, ipcRenderer } from 'electron';

import {
  IpcChannels,
  type AssetManifest,
  type AvatarApi,
  type AvatarOutfitPayload,
  type AvatarTalkingPayload,
  type GestureEvent,
  type GesturePrefs,
} from '@shared/ipc';

const avatarApi: AvatarApi = {
  requestAssets(): Promise<AssetManifest> {
    return ipcRenderer.invoke(IpcChannels.AvatarRequestAssets);
  },
  onSetTalking(handler) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload?: AvatarTalkingPayload,
    ) => handler(payload ?? {});
    ipcRenderer.on(IpcChannels.AvatarSetTalking, listener);
    return () => ipcRenderer.removeListener(IpcChannels.AvatarSetTalking, listener);
  },
  onSetIdle(handler) {
    const listener = () => handler();
    ipcRenderer.on(IpcChannels.AvatarSetIdle, listener);
    return () => ipcRenderer.removeListener(IpcChannels.AvatarSetIdle, listener);
  },
  sendGesture(event: GestureEvent): void {
    ipcRenderer.send(IpcChannels.AvatarGesture, event);
  },
  moveWindowBy(dx: number, dy: number): void {
    ipcRenderer.send(IpcChannels.AvatarMoveWindowBy, dx, dy);
  },
  onSetGesturePrefs(handler) {
    const listener = (_event: Electron.IpcRendererEvent, prefs: GesturePrefs) =>
      handler(prefs);
    ipcRenderer.on(IpcChannels.AvatarSetGesturePrefs, listener);
    return () => ipcRenderer.removeListener(IpcChannels.AvatarSetGesturePrefs, listener);
  },
  getGesturePrefs(): Promise<GesturePrefs> {
    return ipcRenderer.invoke(IpcChannels.GesturePrefsGet);
  },
  setMouseIgnore(ignore: boolean): void {
    ipcRenderer.send(IpcChannels.WindowSetMouseIgnore, ignore);
  },
  onSetOutfit(handler) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: AvatarOutfitPayload,
    ) => handler(payload);
    ipcRenderer.on(IpcChannels.AvatarSetOutfit, listener);
    return () => ipcRenderer.removeListener(IpcChannels.AvatarSetOutfit, listener);
  },
};

contextBridge.exposeInMainWorld('avatarApi', avatarApi);
