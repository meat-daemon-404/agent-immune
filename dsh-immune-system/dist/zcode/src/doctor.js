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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
/** Check the native web-UI wiring declared by the plugin manifests. */
function nativeUiCheck() {
    const name = 'Native UI contract';
    try {
        const here = fileURLToPath(import.meta.url);
        // Compiles to <plugin>/dist/zcode/src/doctor.js, so the package root is
        // FOUR levels up: src -> zcode -> dist -> <plugin>.
        const pluginRoot = join(here, '..', '..', '..', '..');
        const manifests = [
            join(pluginRoot, 'package.json'),
            // When run from the repo instead of an installed copy, the manifest that
            // actually declares the client lives one level down.
            join(pluginRoot, 'dsh-immune-system', 'package.json'),
        ];
        for (const manifestPath of manifests) {
            if (!existsSync(manifestPath))
                continue;
            const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
            const dsh = (raw.dsh ?? {});
            const client = (dsh.client ?? null);
            const exportsField = (raw.exports ?? {});
            const clientExport = exportsField['./client'];
            if (!client)
                return { name, ok: false, detail: `${manifestPath}: dsh.client missing` };
            if (typeof clientExport !== 'string') {
                return { name, ok: false, detail: `${manifestPath}: exports["./client"] missing` };
            }
            // Resolve the declared bundle and prove it is a loader-registered module.
            const bundlePath = join(dirname(manifestPath), clientExport.replace(/^\.\//, ''));
            if (!existsSync(bundlePath)) {
                return { name, ok: false, detail: `client bundle not found: ${bundlePath}` };
            }
            const source = readFileSync(bundlePath, 'utf8');
            if (!source.includes('__ModuleLoader__')) {
                return { name, ok: false, detail: `client bundle lacks __ModuleLoader__: ${bundlePath}` };
            }
            return {
                name,
                ok: true,
                detail: `dsh.client + exports["./client"] -> ${clientExport} (loader-registered)`,
            };
        }
        return { name, ok: false, detail: 'no plugin manifest found next to the build' };
    }
    catch (error) {
        return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
}
/** One row of storage-footprint telemetry: file size plus live row counts. */
function storageRow(store) {
    const s = store.stats();
    const kb = s.dbBytes === null ? 'n/a' : `${Math.max(1, Math.round(s.dbBytes / 1024))} KiB`;
    return {
        name: 'storage',
        ok: true,
        detail: `${kb} db · ${s.pendingFailures} pending · ${s.sessions} sessions · ${s.jobsTotal} jobs (${s.jobsPending} queued)`,
    };
}
export function runDoctor(store, options = {}) {
    const results = [nodeVersionOk(), ftsProbe()];
    results.push(...databaseChecks(store));
    if (!options.pluginRoot)
        results.push(...markerChecks());
    results.push(mcpCheck(), nativeUiCheck());
    results.push({
        name: 'counts',
        ok: true,
        detail: `${store.listAll(false).length} active / ${store.listAll(true).length - store.listAll(false).length} retired / ${store.pendingJobCount()} queued jobs / ${store.stats().suppressedRepeats} repeats suppressed`,
    });
    results.push(storageRow(store));
    return results;
}
/** Resolve the database the same way hooks do, for doctor's own store. */
export function doctorDbPath() {
    return resolveDbPath();
}
