/**
 * Host-side HTTP route for the native web GUI.
 *
 * The standalone dashboard (`cli.js ui`) exists for any host; this route is what
 * the DSH web app's own settings tab talks to, so the UI lives inside the app
 * instead of a separate page.
 *
 * Registered through `ctx.inject(['webServer'], …)` rather than a hard
 * dependency: CLI and desktop profiles have no web server, and a plugin that
 * demands one would simply never activate there.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ImmuneStore } from '../../core/store/index.js';
import { applyAction, readState } from '../../core/ui/query.js';

/** The slice of the host's `webServer` service this needs. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

interface ContextWithInject {
  inject(deps: string[], callback: (ctx: { webServer?: WebServerLike }) => void): unknown;
}

export const UI_ROUTE_PREFIX = '/plugins/dsh-immune-system/api';

/**
 * Same-origin check for mutations.
 *
 * The GUI is served from the same origin, so a legitimate request either omits
 * `Origin` (same-origin GET) or presents it. Requiring JSON also forces a CORS
 * preflight for any cross-origin caller, which a hostile page cannot satisfy.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 4096) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function registerImmuneUiRoute(ctx: unknown, store: ImmuneStore): void {
  const injectable = ctx as Partial<ContextWithInject>;
  // A host without cordis-style optional injection (or a minimal test harness)
  // simply gets no web route; the plugin's core behaviour is unaffected.
  if (typeof injectable.inject !== 'function') return;

  injectable.inject(['webServer'], (web) => {
    const server = web.webServer;
    if (!server?.register) return;

    server.register({
      kind: 'prefix',
      path: UI_ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
          if (req.method === 'GET') {
            const view = url.searchParams.get('view') === 'shared' ? 'shared' : 'project';
            const query = url.searchParams.get('q') ?? '';
            sendJson(res, 200, readState(store, view, query));
            return;
          }

          if (req.method === 'POST') {
            if (!isSameOrigin(req)) {
              sendJson(res, 403, { error: 'cross-origin mutation refused' });
              return;
            }
            const type = String(req.headers['content-type'] ?? '');
            if (!type.includes('application/json')) {
              sendJson(res, 415, { error: 'content-type must be application/json' });
              return;
            }
            const body = await readBody(req);
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
            return;
          }

          sendJson(res, 405, { error: 'method not allowed' });
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  });
}
