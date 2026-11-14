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
import { applyAction, dashboardStats, evolutionStats, readState, resolveBudgetMs } from './query.js';
import { exportLibrary, importLibrary } from '../sync.js';
import { renderSkillMarkdown } from '../export.js';
import { shareSanityCheck } from '../share-guard.js';

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
    return dashboardStats(store);
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
      res.end(
        renderPage({
          token,
          locale,
          dbPath: store.dbPath,
          budgetMs: resolveBudgetMs(),
          evolution: evolutionStats(store),
        }),
      );
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
      const query = url.searchParams.get('q') ?? '';
      sendJson(res, 200, readState(store, 'project', query));
      return;
    }

    if (path === '/api/export' && req.method === 'GET') {
      // Token-gated like every /api path: the download link carries it.
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
      const snapshot = format === 'json' ? exportLibrary(store) : null;
      const exportRows = snapshot ? snapshot.antibodies : store.exportable(3);
      const violations = shareSanityCheck(exportRows);
      if (violations.length > 0) {
        sendJson(res, 422, { error: 'export blocked by the share gate', violations });
        return;
      }
      res.writeHead(200, {
        'content-type':
          format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="immune-library.${format}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(
        snapshot ? JSON.stringify(snapshot, null, 2) : renderSkillMarkdown(store.exportable(3)),
      );
      return;
    }

    if (path === '/api/import' && req.method === 'POST') {
      readBody(req, res, (body) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        const report = importLibrary(store, parsed);
        sendJson(res, 200, { ok: true, added: report.added, merged: report.merged, invalid: report.invalid });
      }, 262144);
      return;
    }

    if (path === '/api/shared' && req.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      sendJson(res, 200, readState(store, 'shared', query));
      return;
    }

    if (path === '/api/action' && req.method === 'POST') {
      readBody(req, res, (body) => {
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
        const result = applyAction(store, op, id);
        sendJson(res, result.status, result.body);
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

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  done: (body: string) => void,
  max = 4096,
): void {
  let body = '';
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    body += chunk.toString('utf8');
    // Small action objects by default; import raises the cap for snapshots.
    if (body.length > max) {
      aborted = true;
      sendJson(res, 413, { error: 'body too large' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!aborted) done(body);
  });
}
