import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { ttsCacheDir } from '../brain/geminiTts';
import { getResolvedAssets } from '../methods';
import { issueToken } from './auth';

// Minimal HTTP server for off-process clients (mobile, websocat, etc.):
//
//   GET  /asset/local/<path>  — read-only mirror of `cortana-asset://local/...`
//   GET  /asset/audio/<file>  — read-only mirror of `cortana-asset://audio/...`
//   POST /pair                — body { deviceId, displayName? } -> { token }
//
// All requests bind to `0.0.0.0` so the LAN can reach the assistant;
// the auth layer (PROTOCOL: every WS frame after `auth.hello` carries
// a token) protects every other surface. Phase 0 ships /pair as a
// permissive endpoint in dev (any caller); Phase M-1 wraps it in a
// QR-code ritual in Settings.

const TEXT_MIME = 'text/plain; charset=utf-8';

interface HttpTransportHandle {
  port: number;
  close(): Promise<void>;
}

function mimeFor(absPath: string): string {
  const lower = absPath.toLowerCase();
  if (lower.endsWith('.vrm') || lower.endsWith('.vrma')) return 'model/gltf-binary';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function send(res: ServerResponse, status: number, body: string | Buffer, mime = TEXT_MIME): void {
  res.statusCode = status;
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(body);
}

function serveAsset(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Path shape: /asset/<host>/<rel>
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  if (parts.length < 3 || parts[0] !== 'asset') {
    send(res, 404, 'not found');
    return;
  }
  const host = parts[1];
  const rel = decodeURIComponent(parts.slice(2).join('/'));
  let rootDir: string;
  if (host === 'audio') {
    rootDir = ttsCacheDir();
  } else if (host === 'local') {
    rootDir = getResolvedAssets().rootDir;
  } else {
    send(res, 403, 'forbidden host');
    return;
  }
  const abs = path.normalize(path.join(rootDir, rel));
  const safeRoot = path.normalize(rootDir + path.sep);
  if (!abs.startsWith(safeRoot)) {
    send(res, 403, 'forbidden');
    return;
  }
  if (!fs.existsSync(abs)) {
    send(res, 404, 'not found');
    return;
  }
  try {
    const data = fs.readFileSync(abs);
    send(res, 200, data, mimeFor(abs));
  } catch (err) {
    console.error('[http] asset read failed', err);
    send(res, 500, 'internal error');
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function servePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    send(res, 400, 'invalid JSON');
    return;
  }
  if (!body || typeof body !== 'object') {
    send(res, 400, 'expected JSON object');
    return;
  }
  const obj = body as { deviceId?: unknown };
  const deviceId =
    typeof obj.deviceId === 'string' && obj.deviceId.trim().length > 0
      ? obj.deviceId.trim()
      : null;
  if (!deviceId) {
    send(res, 400, 'deviceId required');
    return;
  }
  try {
    const token = issueToken(deviceId);
    send(res, 200, JSON.stringify({ token, deviceId }), 'application/json');
  } catch (err) {
    console.error('[http] /pair failed', err);
    send(res, 500, 'pairing failed');
  }
}

/**
 * Start the HTTP transport on `port` (0 = OS picks). Returns a handle
 * with the bound port and a shutdown function.
 */
export async function startHttpTransport(args: { port?: number } = {}): Promise<HttpTransportHandle & { server: Server }> {
  const requestedPort = args.port ?? 0;
  const server = createHttpServer((req, res) => {
    if (!req.url || !req.method) {
      send(res, 400, 'bad request');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/pair') {
      void servePair(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/asset/')) {
      serveAsset(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, 'ok');
      return;
    }
    send(res, 404, 'not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(requestedPort, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : requestedPort;

  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
