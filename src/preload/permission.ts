import { contextBridge, ipcRenderer } from 'electron';

import {
  IpcChannels,
  type ComputerUseStatus,
  type PermissionApi,
  type PermissionRequest,
  type PermissionResponse,
} from '@shared/ipc';

const permissionApi: PermissionApi = {
  onRequest(handler) {
    const listener = (_: unknown, req: PermissionRequest) => handler(req);
    ipcRenderer.on(IpcChannels.PermissionRequestEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.PermissionRequestEvent, listener);
  },
  onStatus(handler) {
    const listener = (_: unknown, status: ComputerUseStatus) => handler(status);
    ipcRenderer.on(IpcChannels.PermissionStatusEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.PermissionStatusEvent, listener);
  },
  respond(response: PermissionResponse): void {
    ipcRenderer.send(IpcChannels.PermissionRespond, response);
  },
  stop(): void {
    ipcRenderer.send(IpcChannels.PermissionStop);
  },
  resize(height: number): void {
    ipcRenderer.send(IpcChannels.PermissionResize, height);
  },
};

contextBridge.exposeInMainWorld('permissionApi', permissionApi);
