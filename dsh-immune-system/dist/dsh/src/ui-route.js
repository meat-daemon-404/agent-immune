import { applyAction, evolutionStats, readState, resolveBudgetMs } from '../../core/ui/query.js';
import { exportLibrary, importLibrary } from '../../core/sync.js';
import { renderSkillMarkdown } from '../../core/export.js';
export const UI_ROUTE_PREFIX = '/plugins/dsh-immune-system/api';
/**
 * Same-origin check for mutations.
 *
 * The GUI is served from the same origin, so a legitimate request either omits
 * `Origin` (same-origin GET) or presents it. Requiring JSON also forces a CORS
 * preflight for any cross-origin caller, which a hostile page cannot satisfy.
 */
function isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin)
        return true;
    try {
        return new URL(origin).host === req.headers.host;
    }
    catch {
        return false;
    }
}
function sendJson(res, status, payload) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}
function readBody(req, max = 4096) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString('utf8');
            if (body.length > max) {
                reject(new Error('body too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
/**
 * `getBudgetMs` lets the host half report the *session's* effective budget
 * (which `/immune --budget` can override) instead of just the env default.
 */
export function registerImmuneUiRoute(ctx, store, getBudgetMs) {
    const injectable = ctx;
    // A host without cordis-style optional injection (or a minimal test harness)
    // simply gets no web route; the plugin's core behaviour is unaffected.
    if (typeof injectable.inject !== 'function')
        return;
    injectable.inject(['webServer'], (web) => {
        const server = web.webServer;
        if (!server?.register)
            return;
        server.register({
            kind: 'prefix',
            path: UI_ROUTE_PREFIX,
            handler: async (req, res) => {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                const path = url.pathname.replace(/\/+$/, '');
                try {
                    if (req.method === 'GET' && path.endsWith('/export')) {
                        const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
                        res.writeHead(200, {
                            'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
                            'content-disposition': `attachment; filename="immune-library.${format}"`,
                            'cache-control': 'no-store',
                            'x-content-type-options': 'nosniff',
                        });
                        res.end(format === 'json'
                            ? JSON.stringify(exportLibrary(store), null, 2)
                            : renderSkillMarkdown(store.exportable(3)));
                        return;
                    }
                    if (req.method === 'GET') {
                        const view = url.searchParams.get('view') === 'shared' ? 'shared' : 'project';
                        const query = url.searchParams.get('q') ?? '';
                        // evolution rides on top of the shared readState payload so BOTH
                        // UIs render the strip from one query layer (AGENTS.md #14).
                        sendJson(res, 200, {
                            ...readState(store, view, query, getBudgetMs?.() ?? resolveBudgetMs()),
                            evolution: evolutionStats(store),
                        });
                        return;
                    }
                    if (req.method === 'POST' && path.endsWith('/import')) {
                        if (!isSameOrigin(req)) {
                            sendJson(res, 403, { error: 'cross-origin mutation refused' });
                            return;
                        }
                        const type = String(req.headers['content-type'] ?? '');
                        if (!type.includes('application/json')) {
                            sendJson(res, 415, { error: 'content-type must be application/json' });
                            return;
                        }
                        const body = await readBody(req, 262144);
                        let parsed;
                        try {
                            parsed = JSON.parse(body);
                        }
                        catch {
                            sendJson(res, 400, { error: 'invalid json' });
                            return;
                        }
                        const report = importLibrary(store, parsed);
                        sendJson(res, 200, {
                            ok: true,
                            added: report.added,
                            merged: report.merged,
                            invalid: report.invalid,
                        });
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
                        let parsed;
                        try {
                            parsed = JSON.parse(body);
                        }
                        catch {
                            sendJson(res, 400, { error: 'invalid json' });
                            return;
                        }
                        const obj = (parsed ?? {});
                        const op = typeof obj.op === 'string' ? obj.op : '';
                        const id = typeof obj.id === 'number' ? obj.id : Number.NaN;
                        const result = applyAction(store, op, id);
                        sendJson(res, result.status, result.body);
                        return;
                    }
                    sendJson(res, 405, { error: 'method not allowed' });
                }
                catch (error) {
                    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        });
    });
}
