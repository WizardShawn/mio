import { Bonjour, type Service } from 'bonjour-service';
import os from 'node:os';

// mDNS announcement so phones / other clients on the LAN can discover
// the assistant without configuration. Service type is `_mio._tcp.`;
// the TXT record carries the protocol version + a friendly device
// name (the OS hostname) so the discovering side can disambiguate
// multiple instances on the same network.

const SERVICE_TYPE = 'mio';
const SERVICE_NAME_PREFIX = 'Mio on';

let bonjour: Bonjour | null = null;
let service: Service | null = null;

export interface MdnsHandle {
  stop(): Promise<void>;
  serviceName: string;
}

/**
 * Announce the server on the LAN. Idempotent: a second call replaces
 * the previous announcement (useful when the bound port changes
 * between dev reloads).
 */
export async function startMdnsAnnounce(args: {
  port: number;
  version: string;
}): Promise<MdnsHandle> {
  await stopMdnsAnnounce();
  const hostname = os.hostname();
  const serviceName = `${SERVICE_NAME_PREFIX} ${hostname}`;
  bonjour = new Bonjour();
  service = bonjour.publish({
    name: serviceName,
    type: SERVICE_TYPE,
    port: args.port,
    txt: {
      version: args.version,
      protocol: '0',
      deviceName: hostname,
    },
  });
  console.log(`[mdns] announcing _${SERVICE_TYPE}._tcp.local as "${serviceName}" on port ${args.port}`);
  return {
    serviceName,
    stop: stopMdnsAnnounce,
  };
}

/** Tear down the announcement on app quit. */
export async function stopMdnsAnnounce(): Promise<void> {
  if (service) {
    try {
      service.stop?.();
    } catch (err) {
      console.warn('[mdns] stop service failed', err);
    }
    service = null;
  }
  if (bonjour) {
    try {
      bonjour.destroy();
    } catch (err) {
      console.warn('[mdns] destroy bonjour failed', err);
    }
    bonjour = null;
  }
}
