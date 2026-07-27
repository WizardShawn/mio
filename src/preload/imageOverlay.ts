import { contextBridge, ipcRenderer } from 'electron';

import {
  IpcChannels,
  type ImageOverlayApi,
  type ImageOverlayPayload,
} from '@shared/ipc';

const imageOverlayApi: ImageOverlayApi = {
  onShow(handler) {
    const listener = (_: unknown, payload: ImageOverlayPayload) => handler(payload);
    ipcRenderer.on(IpcChannels.ImageOverlayShow, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ImageOverlayShow, listener);
  },
  dismiss(): void {
    ipcRenderer.send(IpcChannels.ImageOverlayDismiss);
  },
  copy(absPath: string): void {
    ipcRenderer.send(IpcChannels.ImageOverlayCopy, absPath);
  },
  open(absPath: string): void {
    ipcRenderer.send(IpcChannels.ImageOverlayOpen, absPath);
  },
  reveal(absPath: string): void {
    ipcRenderer.send(IpcChannels.ImageOverlayReveal, absPath);
  },
  resize(width: number, height: number): void {
    ipcRenderer.send(IpcChannels.ImageOverlayResize, width, height);
  },
};

contextBridge.exposeInMainWorld('imageOverlayApi', imageOverlayApi);
