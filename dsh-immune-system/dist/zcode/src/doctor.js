/**
 * `immune doctor` — installation health checks.
 *
 * Borrowed from pro-workflow's /doctor: "confirms SQLite store, hooks, skills
 * load". Support begins with the machine answering its own questions, so each
 * check names the concrete fix instead of just failing.
 *
 * Every check returns a row; the CLI prints them and exits non-zero when any
 * check failed, so it can gate a script.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImmuneStore } from '../../core/store/index.js';
import { GlobalStore, globalDbPathFor } from '../../core/store/global.js';
import { resolveDbPath } from '../../core/store/path.js';
import { dshDirOf, ROOT_MARKER } from './root-marker.js';
function nodeVersionOk() {
    const [major = '0'] = process.versions.node.split('.');
    const ok = Number(major) >= 22;
    return {
        name: 'node >= 22 (node:sqlite)',
        ok,
        detail: `running ${process.versions.node}`,
    };
}
function ftsProbe() {
    try {
        const store = new ImmuneStore({ dbPath: ':memory:' });
        const id = store.insert({
            trigger_pattern: '跨域 CORS probe',
            symptom: 'probe 跨域',
            prescription: 'probe fix',
        });
        const found = id !== null && store.match('跨域').length > 0;
        store.close();
        return found
            ? { name: 'FTS5 trigram + CJK fallback', ok: true, detail: 'probe matched' }
            : { name: 'FTS5 trigram + CJK fallback', ok: false, detail: 'inserted rule was not recalled' };
    }
    catch (error) {
        return {
            name: 'FTS5 trigram + CJK fallback',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}
function databaseChecks(store) {
    const results = [];
    results.push({ name: 'database opens', ok: true, detail: store.dbPath });
    try {
        const shared = new GlobalStore(globalDbPathFor(store.dbPath));
        shared.listAll(true);
        shared.close();
        results.push({ name: 'shared library readable', ok: true, detail: globalDbPathFor(store.dbPath) });
    }
    catch (error) {
        results.push({
            name: 'shared library readable',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
        });
    }
    return results;
}
function markerChecks() {
    const results = [];
    const marker = join(dshDirOf(), ROOT_MARKER);
    if (!existsSync(marker)) {
        results.push({
            name: 'plugin marker (.dsh/immune-root.txt)',
            ok: false,
            detail: 'missing — the plugin has not run in this project yet; run any command once',
        });
        return results;
    }
    const { readFileSync } = require('node:fs');
    const lines = readFileSync(marker, 'utf8').split('\n');
    const root = lines[0]?.trim() ?? '';
    const db = lines[1]?.trim() ?? '';
    results.push({
        name: 'plugin marker (.dsh/immune-root.txt)',
        ok: root.length > 0 && existsSync(root),
        detail: root || '(empty)',
    });
    results.push({
        name: 'database path from marker',
        ok: db.length > 0 && existsSync(db),
        detail: db || '(missing)',
    });
    return results;
}
function mcpCheck() {
    // doctor.js and mcp-server.js compile into the same directory, so the check
    // is a sibling lookup. The earlier three-levels-up walk produced
    // dist/dsh-immune-system/dist/... — a path that can never exist.
    const here = fileURLToPath(import.meta.url);
    const server = join(here, '..', 'mcp-server.js');
    const ok = existsSync(server);
    return {
        name: 'MCP server script',
        ok,
        detail: ok ? server : `missing: ${server}`,
    };
}
/** Run every check. `store` is the caller's live store (its DB is probed). */
export function runDoctor(store, options = {}) {
    const results = [nodeVersionOk(), ftsProbe()];
    results.push(...databaseChecks(store));
    if (!options.pluginRoot)
        results.push(...markerChecks());
    results.push(mcpCheck());
    results.push({
        name: 'counts',
        ok: true,
        detail: `${store.listAll(false).length} active / ${store.listAll(true).length - store.listAll(false).length} retired / ${store.pendingJobCount()} queued jobs`,
    });
    return results;
}
/** Resolve the database the same way hooks do, for doctor's own store. */
export function doctorDbPath() {
    return resolveDbPath();
}
