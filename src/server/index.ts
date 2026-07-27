// Server boot — installs the host adapter, wires the permission
// prompt bridge, and exposes the singleton method surface + event bus.
//
// Phase 0: lives inside the Electron main process. A future headless
// build would call `createServer` with a different `HostAdapter` and
// stand up only the WS+HTTP transports.

import { agentLoop } from './brain/agent';
import { installHost, type HostAdapter } from './brain/host';
import {
  installPermissionPromptBridge,
  shutdownPermissionPromptBridge,
} from './brain/permissionResponses';
import { eventBus } from './eventBus';
import * as methods from './methods';

export interface ServerOptions {
  host: HostAdapter;
}

export interface MioServer {
  methods: typeof methods;
  eventBus: typeof eventBus;
  shutdown(): void;
}

/**
 * Build the server singleton. Call exactly once at boot. Returns the
 * method surface (transports route into this) and the event bus
 * (transports subscribe to this).
 */
export function createServer(opts: ServerOptions): MioServer {
  installHost(opts.host);
  installPermissionPromptBridge();
  agentLoop.init();
  return {
    methods,
    eventBus,
    shutdown(): void {
      agentLoop.shutdown();
      shutdownPermissionPromptBridge();
    },
  };
}

export { methods, eventBus };
export type {
  HostAdapter,
  HostPaths,
  SecretStorage,
  SensorAdapter,
  HostNotifier,
  HostNet,
  ComputerHost,
  PrimaryDisplayInfo,
  CapturedImage,
} from './brain/host';
