import { app, net, Notification, safeStorage, screen } from 'electron';

import type {
  HostAdapter,
  HostNet,
  HostNotifier,
  HostPaths,
  PrimaryDisplayInfo,
  SecretStorage,
  SensorAdapter,
} from '@server/index';

import { getActiveWindowTitle } from './activeWindow';
import { captureAllScreens, capturePrimaryScreen } from './screenshot';

// Electron implementation of the brain's `HostAdapter` interface.
// Built once at boot and handed to `createServer({ host })`. Everything
// the brain calls on its host (paths, secrets, sensors, notifications,
// outbound HTTP, primary-display metrics) routes through this single
// adapter so the brain stays Electron-agnostic.

function buildPaths(): HostPaths {
  return {
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    tempPath: app.getPath('temp'),
    documents: app.getPath('documents'),
    isPackaged: app.isPackaged,
  };
}

const secrets: SecretStorage = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (blob) => safeStorage.decryptString(blob),
};

const sensors: SensorAdapter = {
  capturePrimaryScreen,
  captureAllScreens,
  getActiveWindowTitle,
};

const notifier: HostNotifier = {
  notify({ title, body }) {
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
    } catch (err) {
      console.warn('[host-notifier] notification failed', err);
    }
  },
};

const httpNet: HostNet = {
  fetch: (input, init) => net.fetch(input as string, init),
};

const computer = {
  getPrimaryDisplayInfo(): PrimaryDisplayInfo {
    const primary = screen.getPrimaryDisplay();
    return {
      width: primary.size.width,
      height: primary.size.height,
      scaleFactor: primary.scaleFactor,
    };
  },
};

/** Build the Electron-backed host adapter once. Call at boot. */
export function buildElectronHostAdapter(): HostAdapter {
  return {
    paths: buildPaths(),
    secrets,
    sensors,
    notifier,
    net: httpNet,
    computer,
  };
}
