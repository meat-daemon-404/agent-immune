/**
 * Local dashboard server.
 *
 * Deliberate constraints, because this exposes a database that contains text
 * captured from the user's own tool calls:
 *
 *  - binds `127.0.0.1` only, never `0.0.0.0`;
 *  - every `/api` call must present a random per-run token, so another page in
 *    the same browser cannot read or mutate the library (a simple cross-origin
 *    POST needs no preflight, so origin checking alone would not be enough);
 *  - responses carry a strict CSP and `nosniff`, and the page loads nothing
 *    external — it works offline and phones nowhere;
 *  - only three mutations exist, all on this project's rules, and a delete is
 *    confirmed in the page.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ImmuneStore } from '../store/index.js';
import { renderPage } from './page.js';
import { resolveLocale } from '../i18n.js';

export interface UiServerOptions {
  /** Database to open. Defaults to the host's resolution. */
  dbPath?: string;
  /** Preferred port; falls forward to the next free one. */
  port?: number;
  /** How many ports to try before giving up. */
  portAttempts?: number;
}

export interface UiServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_QUERY = 200;
const ACTIONS = new Set(['retire', 'restore', 'delete']);

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const store = new ImmuneStore(options.dbPath ? { dbPath: options.dbPath } : {});
  const token = randomBytes(24).toString('hex');
  const locale = resolveLocale() === 'en' ? 'en' : 'zh-CN';

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  function authorized(req: IncomingMessage, url: URL): boolean {
    const given = url.searchParams.get('t') ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function stats(): { active: number; retired: number; hits: number; shared: number } {
    const all = store.listAll(true);
    return {
      active: all.filter((a) => a.status === 'active').length,
      retired: all.filter((a) => a.status === 'retired').length,
      hits: all.reduce((sum, a) => sum + a.hit_count, 0),
      shared: store.sharedAntibodies(1000).length,
    };
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(renderPage({ token, locale, dbPath: store.dbPath }));
      return;
    }

    if (!path.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    if (!authorized(req, url)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    if (path === '/api/list' && req.method === 'GET') {
      const query = (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY);
      sendJson(res, 200, { stats: stats(), antibodies: store.peek(query, 200) });
      return;
    }

    if (path === '/api/shared' && req.method === 'GET') {
      sendJson(res, 200, { stats: stats(), antibodies: store.sharedAntibodies(200) });
      return;
    }

    if (path === '/api/action' && req.method === 'POST') {
      readBody(req, (body) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        const obj = (parsed ?? {}) as Record<string, unknown>;
        const op = typeof obj.op === 'string' ? obj.op : '';
        const id = typeof obj.id === 'number' ? obj.id : Number.NaN;
        if (!ACTIONS.has(op) || !Number.isInteger(id) || id <= 0) {
          sendJson(res, 400, { error: 'invalid action' });
          return;
        }

        if (op === 'delete') {
          const ok = store.remove(id);
          sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
          return;
        }
        const ok = store.setStatus(id, op === 'retire' ? 'retired' : 'active');
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  const port = await listen(server, options.port ?? 7788, options.portAttempts ?? 8);
  const url = `http://127.0.0.1:${port}/`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}

/** Try successive ports until one binds, so a busy 7788 is not fatal. */
function listen(server: Server, start: number, attempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let current = start;
    let left = attempts;

    const attempt = (): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        if (error.code === 'EADDRINUSE' && left > 0) {
          left -= 1;
          current += 1;
          attempt();
          return;
        }
        reject(error);
      };
      server.once('error', onError);
      server.listen(current, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    };

    attempt();
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readBody(req: IncomingMessage, done: (body: string) => void): void {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
    // The only accepted body is a tiny action object.
    if (body.length > 4096) {
      req.destroy();
    }
  });
  req.on('end', () => done(body));
}
