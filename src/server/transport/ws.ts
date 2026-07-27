import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import type {
  ServerEventName,
  ServerEventPayload,
  ServerMethodName,
  WsClientFrame,
  WsServerFrame,
} from '@shared/protocol';
import {
  PROTOCOL_VERSION,
  methodUsesBinaryAfterCall,
} from '@shared/protocol';

import type { MioServer } from '../index';
import { getResolvedAssets } from '../methods';
import { verifyToken } from './auth';

// WebSocket transport. One server, many clients. Each client must
// send `auth.hello` (with a token issued at /pair) before any other
// frame is accepted. After auth, every brain event is JSON-framed and
// pushed; client → server frames carry a `{ method, args }` payload
// that we route through `server.methods[method](args)`.

const SERVER_VERSION = '0.1.0';
const AUTH_TIMEOUT_MS = 5_000;
/**
 * How long the server waits between a JSON `call` frame for a
 * binary-after-call method and the matching binary frame before
 * rejecting the call as a protocol violation. 5 s is plenty for any
 * LAN-side mobile upload of a sub-MB JPEG.
 */
const BINARY_UPLOAD_TIMEOUT_MS = 5_000;

interface PendingBinaryUpload {
  callId: string;
  method: ServerMethodName;
  args: unknown;
  /** `setTimeout` handle that rejects the call if no binary arrives. */
  timer: NodeJS.Timeout;
}

interface ClientState {
  ws: WebSocket;
  deviceId: string | null;
  authenticated: boolean;
  /**
   * The `Host:` header value captured at WS-upgrade time
   * (e.g. `192.168.1.5:38461`). Used to rewrite outgoing `cortana-asset://`
   * URLs into transport-relative `http://<host>/asset/...` URLs that the
   * mobile client can actually fetch. Falls back to `null` when the
   * upgrade request didn't carry a host header, in which case the brain's
   * URLs pass through verbatim and the client is expected to rewrite.
   */
  hostHeader: string | null;
  /**
   * Set when a binary-after-call method (`perception.upload`) has
   * sent its JSON `call` frame and we're waiting for the following
   * binary frame on the same socket. Only one upload can be in
   * flight per client at a time — the wire pattern requires strict
   * JSON-then-binary ordering, so any second `call` while this is
   * non-null is a protocol violation.
   */
  pendingUpload: PendingBinaryUpload | null;
}

// The brain emits internal `cortana-asset://<host>/<rel>` URLs (the Electron
// custom scheme). The WS transport mirrors these via the sibling HTTP
// server at `/asset/<host>/<rel>` (see `transport/http.ts > serveAsset`).
// Rewrites happen per-client because each client connected via a possibly
// different LAN IP and we want to hand them URLs that resolve from where
// they are. No-op when the URL isn't a `cortana-asset://` URL (e.g. an
// already-rewritten HTTP URL, or `null` when TTS synthesis was skipped).
const CORTANA_ASSET_RE = /^cortana-asset:\/\/([^/]+)\/(.*)$/;

function rewriteAssetUrlForClient(url: string | null | undefined, hostHeader: string | null): string | null {
  if (typeof url !== 'string' || url.length === 0) return url ?? null;
  const match = CORTANA_ASSET_RE.exec(url);
  if (!match) return url;
  if (!hostHeader) return url;
  const [, host, rel] = match;
  return `http://${hostHeader}/asset/${host}/${rel}`;
}

/**
 * Rewrite an *absolute filesystem* asset path (e.g. the brain's raw
 * `C:\\…\\Mio_Kimono.vrm`) into a `http://<host>/asset/local/<rel>`
 * URL the mobile client can fetch through the HTTP transport's
 * `/asset/local/*` route. Used for `avatar.setOutfit`, which carries
 * a raw filesystem path the brain hands over verbatim. Falls back to
 * the input when we can't compute a relative path (different drive,
 * etc.) so a misconfigured asset root degrades to a no-op on mobile
 * instead of crashing the WS payload.
 */
function rewriteAbsoluteAssetPath(
  absPath: string | null | undefined,
  hostHeader: string | null,
): string | null {
  if (typeof absPath !== 'string' || absPath.length === 0) return absPath ?? null;
  if (!hostHeader) return absPath;
  try {
    const { rootDir } = getResolvedAssets();
    const rel = path.relative(rootDir, absPath);
    if (!rel || rel.startsWith('..')) return absPath;
    const encoded = rel.split(path.sep).map(encodeURIComponent).join('/');
    return `http://${hostHeader}/asset/local/${encoded}`;
  } catch {
    return absPath;
  }
}

/**
 * Per-event payload rewriter. We mutate a shallow copy so the bus listener
 * stays pure for every other transport subscribed to the same event. Most
 * events pass through untouched; only the audio-bearing ones need work.
 */
function rewritePayloadForClient<E extends ServerEventName>(
  event: E,
  payload: ServerEventPayload<E>,
  hostHeader: string | null,
): ServerEventPayload<E> {
  if (event === 'chat.replyChunk') {
    const p = payload as ServerEventPayload<'chat.replyChunk'>;
    const rewritten = rewriteAssetUrlForClient(p.audioUrl, hostHeader);
    if (rewritten === p.audioUrl) return payload;
    return { ...p, audioUrl: rewritten } as ServerEventPayload<E>;
  }
  if (event === 'chat.playUtterance') {
    const p = payload as ServerEventPayload<'chat.playUtterance'>;
    const rewritten = rewriteAssetUrlForClient(p.audioUrl, hostHeader);
    if (rewritten === p.audioUrl) return payload;
    return { ...p, audioUrl: rewritten } as ServerEventPayload<E>;
  }
  if (event === 'avatar.setOutfit') {
    const p = payload as ServerEventPayload<'avatar.setOutfit'>;
    const rewritten = rewriteAbsoluteAssetPath(p.vrmPath, hostHeader);
    if (rewritten === p.vrmPath) return payload;
    return { ...p, vrmPath: rewritten ?? p.vrmPath } as ServerEventPayload<E>;
  }
  return payload;
}

interface WsTransportHandle {
  close(): Promise<void>;
}

function sendFrame(ws: WebSocket, frame: WsServerFrame): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    console.warn('[ws] send failed', err);
  }
}

function methodNames(server: MioServer): Set<string> {
  // Methods are exported by `server.methods` as snake-to-camel
  // functions: `chatSend`, `chatGetHistory`, etc. The wire uses the
  // protocol's dot-separated names (chat.send). The `dispatch` helper
  // does the mapping at call time.
  return new Set(Object.keys(server.methods));
}

/** Map a wire method name (`chat.send`) to its exported function name (`chatSend`). */
function methodFnName(method: string): string {
  return method.replace(/\.(.)/g, (_, c: string) => c.toUpperCase());
}

async function dispatchCall(
  server: MioServer,
  method: ServerMethodName,
  args: unknown,
  binary: Buffer | null = null,
): Promise<unknown> {
  const fnName = methodFnName(method);
  const known = methodNames(server);
  if (!known.has(fnName)) {
    throw new Error(`Unknown method: ${method}`);
  }
  const fn = (server.methods as unknown as Record<string, (a: unknown, b?: Buffer | null) => unknown>)[fnName]!;
  // Binary-after-call methods take a second `Buffer` argument; the
  // rest receive `args` alone (passing extra args to existing methods
  // is a no-op since they're declared as single-arg functions).
  const result = await Promise.resolve(
    methodUsesBinaryAfterCall(method) ? fn(args, binary) : fn(args),
  );
  return result ?? null;
}

function isHello(frame: WsClientFrame): frame is Extract<WsClientFrame, { kind: 'hello' }> {
  return frame.kind === 'hello';
}

function isCall(frame: WsClientFrame): frame is Extract<WsClientFrame, { kind: 'call' }> {
  return frame.kind === 'call';
}

/**
 * Stand up the WebSocket server attached to an existing HTTP listener
 * (we reuse the same port as the asset / pair HTTP server). Returns a
 * shutdown handle. The brain's event bus is subscribed once and
 * forwards every event to every authenticated client.
 */
export function startWsTransport(args: {
  server: MioServer;
  httpServer: HttpServer;
}): WsTransportHandle {
  const { server, httpServer } = args;
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set<ClientState>();

  wss.on('connection', (ws, request: IncomingMessage) => {
    const rawHost = request.headers.host;
    const hostHeader = typeof rawHost === 'string' && rawHost.length > 0 ? rawHost : null;
    const state: ClientState = {
      ws,
      deviceId: null,
      authenticated: false,
      hostHeader,
      pendingUpload: null,
    };
    clients.add(state);

    const authTimer = setTimeout(() => {
      if (!state.authenticated) {
        sendFrame(ws, { kind: 'authFailed', reason: 'auth timeout' });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, AUTH_TIMEOUT_MS);

    const failPendingUpload = (reason: string): void => {
      const p = state.pendingUpload;
      if (!p) return;
      clearTimeout(p.timer);
      state.pendingUpload = null;
      sendFrame(ws, {
        kind: 'callResult',
        callId: p.callId,
        ok: false,
        error: { message: reason, code: 'binary_upload_failed' },
      });
    };

    // `ws.on('message', (data, isBinary))` — the second argument tells
    // us whether the frame was a WS binary frame or a text frame. We
    // route binary frames to the pending-upload state machine and
    // everything else through the JSON parser.
    ws.on('message', (raw, isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw as ArrayBuffer);
        const pending = state.pendingUpload;
        if (!pending) {
          console.warn('[ws] unexpected binary frame; no pending upload');
          return;
        }
        clearTimeout(pending.timer);
        state.pendingUpload = null;
        void dispatchCall(server, pending.method, pending.args, buf)
          .then((result) => {
            sendFrame(ws, {
              kind: 'callResult',
              callId: pending.callId,
              ok: true,
              result,
            });
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            sendFrame(ws, {
              kind: 'callResult',
              callId: pending.callId,
              ok: false,
              error: { message },
            });
          });
        return;
      }

      let frame: WsClientFrame;
      try {
        frame = JSON.parse(raw.toString('utf8')) as WsClientFrame;
      } catch {
        sendFrame(ws, {
          kind: 'callResult',
          callId: 'unknown',
          ok: false,
          error: { message: 'invalid JSON', code: 'bad_frame' },
        });
        return;
      }

      if (!state.authenticated) {
        if (!isHello(frame)) {
          sendFrame(ws, { kind: 'authFailed', reason: 'auth.hello expected first' });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        if (frame.protocolVersion !== PROTOCOL_VERSION) {
          sendFrame(ws, {
            kind: 'authFailed',
            reason: `protocol mismatch (got ${frame.protocolVersion}, want ${PROTOCOL_VERSION})`,
          });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        const deviceId = verifyToken(frame.token);
        if (!deviceId || (frame.deviceId && deviceId !== frame.deviceId)) {
          sendFrame(ws, { kind: 'authFailed', reason: 'invalid token' });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        state.authenticated = true;
        state.deviceId = deviceId;
        clearTimeout(authTimer);
        sendFrame(ws, {
          kind: 'welcome',
          serverVersion: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }

      if (!isCall(frame)) {
        sendFrame(ws, {
          kind: 'callResult',
          callId: 'unknown',
          ok: false,
          error: { message: 'expected `call` frame', code: 'bad_frame' },
        });
        return;
      }

      // M-3.2 — binary-after-call methods (perception.upload) must
      // arrive as a JSON call frame immediately followed by exactly
      // one binary WS frame on the same socket. The server enters
      // "pending upload" state on the JSON frame; a second JSON call
      // arriving with an upload pending is a protocol violation that
      // fails the pending call. If the binary never arrives, the
      // timeout below fails the call too.
      if (methodUsesBinaryAfterCall(frame.method)) {
        if (state.pendingUpload) {
          failPendingUpload('replaced by another binary-after-call frame');
        }
        const upload: PendingBinaryUpload = {
          callId: frame.callId,
          method: frame.method,
          args: frame.args,
          timer: setTimeout(() => {
            failPendingUpload('binary upload timeout (no binary frame received)');
          }, BINARY_UPLOAD_TIMEOUT_MS),
        };
        state.pendingUpload = upload;
        return;
      }

      // A non-binary call landing while an upload is pending means
      // the client jumped the gun. Fail the pending upload to keep
      // wire ordering invariants honest and let the new call proceed.
      if (state.pendingUpload) {
        failPendingUpload('JSON call arrived before expected binary frame');
      }

      void dispatchCall(server, frame.method, frame.args)
        .then((result) => {
          sendFrame(ws, {
            kind: 'callResult',
            callId: frame.callId,
            ok: true,
            result,
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          sendFrame(ws, {
            kind: 'callResult',
            callId: frame.callId,
            ok: false,
            error: { message },
          });
        });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (state.pendingUpload) {
        clearTimeout(state.pendingUpload.timer);
        state.pendingUpload = null;
      }
      clients.delete(state);
    });
    ws.on('error', (err) => {
      console.warn('[ws] client error', err);
    });
  });

  // Forward every brain event to every authenticated client.
  const eventNames: ServerEventName[] = [
    'chat.stream',
    'chat.replyCaption',
    'chat.replyChunk',
    'chat.toolActivity',
    'chat.playUtterance',
    'chat.showWarning',
    'chat.toggleInput',
    'avatar.setTalking',
    'avatar.setIdle',
    'avatar.setGesturePrefs',
    'avatar.setOutfit',
    'agent.status',
    'trayMenu.state',
    'permission.request',
    'permission.status',
    'imageOverlay.show',
    // M-3.1 — push to the mobile client asking it to ship a fresh
    // perception frame. The client replies with `perception.upload`.
    'perception.requestFrame',
  ];

  const offFns: Array<() => void> = [];
  for (const eventName of eventNames) {
    const off = server.eventBus.on(eventName, (payload, meta) => {
      // Surface-routed events (chat stream, caption, chunk, talking
      // animation) carry `meta.origin = 'desktop'` when the originating
      // turn was typed/touched on the desktop chat pill. Mobile clients
      // should NOT see the reply stream of a desktop-driven turn — the
      // user is sitting at the desktop, not at the phone — so drop those
      // here. Events with no origin (greeting, agent cycles, gesture
      // prefs push, agent status) keep broadcasting to every paired
      // phone, matching the pre-Phase-0 behaviour.
      if (meta.origin === 'desktop') return;
      for (const c of clients) {
        if (!c.authenticated) continue;
        const rewritten = rewritePayloadForClient(
          eventName,
          payload as ServerEventPayload<typeof eventName>,
          c.hostHeader,
        );
        const frame: WsServerFrame = meta.origin
          ? {
              kind: 'event',
              event: eventName,
              payload: rewritten,
              origin: meta.origin,
            }
          : {
              kind: 'event',
              event: eventName,
              payload: rewritten,
            };
        sendFrame(c.ws, frame);
      }
    });
    offFns.push(off);
  }

  return {
    close: async () => {
      for (const off of offFns) off();
      for (const c of clients) {
        try {
          c.ws.close();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
