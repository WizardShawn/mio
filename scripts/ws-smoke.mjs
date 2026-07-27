#!/usr/bin/env node
// Phase 0 WS smoke test.
//
// Usage:
//   node scripts/ws-smoke.mjs                  # auto-discovers via mDNS
//   node scripts/ws-smoke.mjs --host 192.168.1.5 --port 51234
//   node scripts/ws-smoke.mjs --text "你好"
//
// What it does:
//   1. Pairs over HTTP (POST /pair) to obtain a token.
//   2. Opens a WS connection to ws://host:port/ws.
//   3. Sends `auth.hello` with the token.
//   4. Sends `chat.send` with --text.
//   5. Prints every event frame received until the chat.stream `end`
//      arrives, then waits 3 s for trailing reply chunks and exits.
//
// Run the desktop app first (`npm run dev`). The desktop chat pill
// should mirror the reply caption / chunks streamed below — that
// proves the brain is shared.

import { Bonjour } from 'bonjour-service';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const args = parseArgs(process.argv.slice(2));
const TEXT = args.text ?? 'ping from ws-smoke';
const TIMEOUT_MS = Number(args.timeout ?? 30_000);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function discover() {
  if (args.host) {
    return { host: args.host, port: Number(args.port ?? 0) };
  }
  console.log('[smoke] discovering _mio._tcp via mDNS...');
  const bonjour = new Bonjour();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      bonjour.destroy();
      reject(new Error('mDNS discovery timed out after 5s; pass --host/--port to skip'));
    }, 5_000);
    const browser = bonjour.find({ type: 'mio' }, (svc) => {
      clearTimeout(t);
      browser.stop();
      bonjour.destroy();
      const host = (svc.referer && svc.referer.address) || svc.host || '127.0.0.1';
      resolve({ host, port: svc.port });
    });
  });
}

async function pair(host, port) {
  const url = `http://${host}:${port}/pair`;
  const deviceId = `ws-smoke-${process.pid}`;
  console.log(`[smoke] POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) throw new Error(`/pair failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.token) throw new Error('/pair returned no token');
  console.log(`[smoke] paired (deviceId=${deviceId}, token=${body.token.slice(0, 8)}…)`);
  return { token: body.token, deviceId };
}

function openSocket(host, port) {
  const url = `ws://${host}:${port}/ws`;
  console.log(`[smoke] connecting ${url}`);
  return new WebSocket(url);
}

async function run() {
  const target = await discover();
  if (!target.port) throw new Error('discovery returned port=0; pass --port');
  console.log(`[smoke] target: ${target.host}:${target.port}`);

  const { token, deviceId } = await pair(target.host, target.port);
  const ws = openSocket(target.host, target.port);

  const callId = randomUUID();
  let streamEnded = false;
  let trailingTimer = null;
  let exitCode = 0;

  const closeAfter = (ms) => {
    if (trailingTimer) clearTimeout(trailingTimer);
    trailingTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, ms);
  };

  const hardTimeout = setTimeout(() => {
    console.error(`[smoke] hard timeout after ${TIMEOUT_MS}ms`);
    exitCode = 2;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }, TIMEOUT_MS);

  ws.on('open', () => {
    console.log('[smoke] ws open; sending auth.hello');
    ws.send(
      JSON.stringify({
        kind: 'hello',
        token,
        deviceId,
        clientVersion: 'ws-smoke/0.1',
        protocolVersion: 0,
      }),
    );
  });

  ws.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      console.warn('[smoke] non-JSON frame', err);
      return;
    }

    if (frame.kind === 'welcome') {
      console.log(`[smoke] welcome (server v${frame.serverVersion}); sending chat.send "${TEXT}"`);
      ws.send(
        JSON.stringify({
          kind: 'call',
          callId,
          method: 'chat.send',
          args: { text: TEXT },
        }),
      );
      return;
    }

    if (frame.kind === 'authFailed') {
      console.error('[smoke] auth failed:', frame.reason);
      exitCode = 3;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (frame.kind === 'event') {
      const summary = summariseEvent(frame.event, frame.payload);
      console.log(`[evt ] ${frame.event}: ${summary}`);
      if (frame.event === 'chat.stream' && frame.payload && frame.payload.type === 'end') {
        streamEnded = true;
        closeAfter(3_000);
      }
      return;
    }

    if (frame.kind === 'callResult') {
      if (frame.ok) {
        console.log(`[call] ${callId.slice(0, 8)} ok`);
      } else {
        console.error(`[call] ${callId.slice(0, 8)} ERR`, frame.error);
        exitCode = 4;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      // chat.send resolves AFTER the TTS hold window, so the call
      // result coming back is itself a signal that we're done.
      if (streamEnded) closeAfter(500);
      else closeAfter(1_000);
    }
  });

  ws.on('error', (err) => {
    console.error('[smoke] ws error', err);
    exitCode = 5;
  });

  ws.on('close', () => {
    clearTimeout(hardTimeout);
    if (trailingTimer) clearTimeout(trailingTimer);
    console.log('[smoke] ws closed');
    process.exit(exitCode);
  });
}

function summariseEvent(eventName, payload) {
  if (!payload) return '<no payload>';
  switch (eventName) {
    case 'chat.stream':
      if (payload.type === 'text') return `text +${payload.delta?.length ?? 0} chars`;
      return `type=${payload.type}${payload.message ? ` "${payload.message}"` : ''}`;
    case 'chat.replyCaption':
      return `lang=${payload.language} text="${(payload.text ?? '').slice(0, 60)}"`;
    case 'chat.replyChunk':
      return `${payload.chunkIndex + 1}/${payload.totalChunks} zh="${(payload.zhText ?? '').slice(0, 40)}" audio=${payload.audioUrl ? 'yes' : 'no'}`;
    case 'chat.toolActivity':
      return payload.text ?? '<cleared>';
    case 'avatar.setTalking':
      return `mood=${payload.mood ?? 'neutral'}`;
    case 'agent.status':
      return `state=${payload.state} reason=${payload.reason ?? '-'}`;
    case 'permission.request':
      return `tool=${payload.tool} title="${payload.title}"`;
    case 'permission.status':
      return `active=${payload.active} step=${payload.step}/${payload.maxSteps}`;
    case 'imageOverlay.show':
      return `src=${payload.sourceKind} path=${payload.absPath}`;
    default:
      return JSON.stringify(payload).slice(0, 80);
  }
}

run().catch((err) => {
  console.error('[smoke] fatal', err);
  process.exit(1);
});
