#!/usr/bin/env node
/**
 * Command-line surface for the immune database.
 *
 * Slash commands in this plugin are Markdown prompts, so they cannot call the
 * database themselves. They ask the model to run this CLI instead, which keeps
 * the logic testable and out of the prompt.
 *
 * Usage: node dist/zcode/src/cli.js <list|stats|export|prune|forget> [...]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ImmuneStore } from '../../core/store/index.js';
import { renderSkillMarkdown } from '../../core/export.js';
import { strings } from '../../core/i18n.js';
import { SNAPSHOT_FORMAT, exportLibrary, importLibrary } from '../../core/sync.js';
import { syncDoc } from '../../core/sync-doc.js';
import { backfill } from '../../core/backfill.js';
import { readLlmConfig } from '../../core/llm.js';
import { startUiServer } from '../../core/ui/server.js';
import { runDoctor } from './doctor.js';
import { dshDirOf, selfMarkers } from './root-marker.js';
import { drainJobs } from './drain.js';
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
/** Terminal columns a string occupies; CJK glyphs are double width. */
function width(text) {
    let total = 0;
    for (const ch of text)
        total += WIDE.test(ch) ? 2 : 1;
    return total;
}
function pad(value, columns) {
    const used = width(value);
    return used >= columns ? value : value + ' '.repeat(columns - used);
}
/** Clamp to a column budget without splitting a double-width glyph. */
function clamp(value, columns) {
    if (width(value) <= columns)
        return value;
    let out = '';
    let used = 0;
    for (const ch of value) {
        const w = WIDE.test(ch) ? 2 : 1;
        if (used + w > columns - 1)
            break;
        out += ch;
        used += w;
    }
    return `${out}…`;
}
function cmdList(store, includeRetired) {
    const t = strings();
    const rows = store.listAll(includeRetired);
    if (rows.length === 0) {
        process.stdout.write(`${t.noAntibodies}\n`);
        return;
    }
    const indent = ' '.repeat(27);
    const header = `${pad('#', 5)}${pad('hits', 6)}${pad('fails', 7)}${pad('status', 9)}${t.trigger}\n`;
    process.stdout.write(header);
    for (const ab of rows) {
        process.stdout.write(`${pad(String(ab.id), 5)}${pad(String(ab.hit_count), 6)}${pad(String(ab.fail_count), 7)}` +
            `${pad(ab.status, 9)}${clamp(ab.trigger_pattern, 64)}\n` +
            `${indent}${t.avoid}: ${clamp(ab.symptom, 90)}\n` +
            `${indent}${t.do}: ${clamp(ab.prescription, 90)}\n`);
    }
}
function cmdStats(store) {
    const all = store.listAll(true);
    const active = all.filter((a) => a.status === 'active');
    const retired = all.length - active.length;
    const hits = active.reduce((sum, a) => sum + a.hit_count, 0);
    process.stdout.write(`antibodies: ${all.length} (active ${active.length}, retired ${retired})\n` +
        `injections: ${hits}\n` +
        `queued distill jobs: ${store.pendingJobCount()}\n` +
        `database: ${store.dbPath}\n`);
}
function cmdExport(store, args) {
    const minHits = Number(args[0] ?? '');
    const threshold = Number.isFinite(minHits) && minHits > 0 ? minHits : 3;
    const rows = store.exportable(threshold);
    if (rows.length === 0) {
        process.stdout.write(`${strings().noExport}\n`);
        return;
    }
    const outPath = args[1]
        ? resolve(args[1])
        : join(dshDirOf(), 'skills', 'project-pitfalls', 'SKILL.md');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, renderSkillMarkdown(rows, { minHits: threshold }), 'utf8');
    process.stdout.write(`${strings().exported} ${rows.length} -> ${outPath}\n`);
}
function main(argv) {
    const [command = 'list', ...args] = argv;
    // Async commands that outlive main() own the store close themselves; the
    // shared finally below must not close theirs out from under them.
    let deferStoreClose = false;
    // `demo` needs no user database and runs the REAL pipeline (distill, recall,
    // render) on an in-memory store, so the quickstart cannot pollute anything.
    // main() is synchronous, so the async demo pins the process with a timer
    // until its promise settles — otherwise node exits before step [2].
    if (command === 'demo') {
        const keepAlive = setInterval(() => { }, 60_000);
        runDemo()
            .catch((error) => {
            process.stderr.write(`demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        })
            .finally(() => clearInterval(keepAlive));
        return 0;
    }
    // `ui` owns its own store (it lives for the whole server lifetime), so it is
    // handled before the short-lived store below is opened.
    if (command === 'ui') {
        const portArg = args.indexOf('--port');
        const wanted = portArg >= 0 ? Number(args[portArg + 1]) : 7788;
        const port = Number.isInteger(wanted) && wanted >= 0 ? wanted : 7788;
        startUiServer({ port })
            .then((handle) => {
            process.stdout.write(`免疫仪表盘 / Immune dashboard: ${handle.url}\n` +
                `仅本机可访问 / bound to 127.0.0.1 · Ctrl+C 停止 / press Ctrl+C to stop\n`);
            const stop = () => {
                handle.close().then(() => process.exit(0));
            };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
        })
            .catch((error) => {
            process.stderr.write(`failed to start UI: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exit(1);
        });
        // The server keeps the event loop alive; no exit code is set.
        return 0;
    }
    const store = new ImmuneStore();
    try {
        switch (command) {
            case 'list':
                cmdList(store, args.includes('--all'));
                return 0;
            case 'stats':
                cmdStats(store);
                return 0;
            case 'export':
                cmdExport(store, args);
                return 0;
            case 'backfill': {
                // Mine the host's own session history for failed-then-fixed episodes
                // and distil them with the deterministic rule (fast, no API calls).
                deferStoreClose = true;
                const dbArg = args.indexOf('--db');
                const daysArg = args.indexOf('--days');
                const sessionArg = args.indexOf('--session');
                const budgetArg = args.indexOf('--budget-ms');
                const maxArg = args.indexOf('--max');
                const report = backfill(store, {
                    sourceDb: dbArg >= 0 ? resolve(args[dbArg + 1] ?? '') : undefined,
                    days: daysArg >= 0 ? Number(args[daysArg + 1] ?? '120') : 120,
                    sessionId: sessionArg >= 0 ? args[sessionArg + 1] : undefined,
                    ...(maxArg >= 0 ? { max: Number(args[maxArg + 1] ?? '0') } : {}),
                    selfMarkers: selfMarkers(),
                });
                const budget = budgetArg >= 0 ? Number(args[budgetArg + 1] ?? '60000') : 60_000;
                // Backfill is the LLM path's best use case: hundreds of real episodes
                // with the repair evidence a deterministic echo cannot phrase. The
                // rule path runs when no LLM is configured or --no-llm is passed.
                const noLlm = args.includes('--no-llm');
                const llm = noLlm ? null : readLlmConfig();
                // main() is synchronous: pin the process with a timer while the async
                // drain loop settles (the same pattern the demo uses).
                const keepAlive = setInterval(() => { }, 60_000);
                let drained = 0;
                const drainLoop = (async () => {
                    for (;;) {
                        const r = await drainJobs(store, Number.isFinite(budget) ? budget : 60_000, {
                            llm,
                        });
                        drained += r.processed;
                        if (store.pendingJobCount() === 0 || r.processed === 0)
                            break;
                    }
                })();
                drainLoop
                    .then(() => {
                    const s = store.stats();
                    const path = llm === null
                        ? 'deterministic rule path'
                        : `${s.llmDistilled} by the model · ${s.llmFallbacks} degraded`;
                    process.stdout.write(`scanned ${report.scanned} calls · ${report.failures} failures · ` +
                        `${report.paired} paired (${report.superseded} superseded) · ` +
                        `${report.enqueued} enqueued (${report.skippedSelf} self-noise skipped)\n` +
                        `distilled ${drained} episode(s) — ${path} · ` +
                        `${store.pendingJobCount()} left queued\n`);
                })
                    .catch((error) => {
                    process.stderr.write(`backfill drain failed: ${error instanceof Error ? error.message : String(error)}\n`);
                    process.exitCode = 1;
                })
                    .finally(() => {
                    clearInterval(keepAlive);
                    store.close();
                });
                return 0;
            }
            case 'sync-doc': {
                // Write proven rules into AGENTS.md / CLAUDE.md as a managed section,
                // so agents WITHOUT our hooks still get the lessons.
                const outArg = args.indexOf('--out');
                const hitsArg = args.indexOf('--min-hits');
                const candidates = [
                    outArg >= 0 ? args[outArg + 1] ?? '' : '',
                    'AGENTS.md',
                    'CLAUDE.md',
                ].filter((v) => v.trim().length > 0);
                const target = resolve(candidates[0] ?? 'AGENTS.md');
                const minHits = hitsArg >= 0 ? Number(args[hitsArg + 1] ?? '3') : 3;
                const report = syncDoc(store, {
                    file: target,
                    minHits: Number.isFinite(minHits) && minHits >= 0 ? minHits : 3,
                });
                process.stdout.write(`${report.file}: ${report.rules} rule(s) written (${report.created ? 'section created' : report.replaced ? 'section replaced' : 'appended'})\n` +
                    'the section is fenced by immune:generated markers and fully managed - edit outside it, never inside.\n');
                return 0;
            }
            case 'prune':
                store.pruneStale();
                process.stdout.write('Pruned stale pending failures and injection records.\n');
                return 0;
            case 'search': {
                // Same read-only path as the dashboard: searching is not delivery.
                const query = args.join(' ').trim();
                if (!query) {
                    process.stderr.write('usage: immune search <query>\n');
                    return 2;
                }
                const rows = store.peek(query, 20);
                if (rows.length === 0) {
                    process.stdout.write('没有匹配 / no match\n');
                    return 0;
                }
                for (const ab of rows) {
                    process.stdout.write(`${pad(String(ab.id), 5)}${pad(String(ab.hit_count), 6)}${pad(ab.status, 9)}${clamp(ab.trigger_pattern, 64)}\n` +
                        `${' '.repeat(20)}  ${strings().avoid}: ${clamp(ab.symptom, 90)}\n` +
                        `${' '.repeat(20)}  ${strings().do}: ${clamp(ab.prescription, 90)}\n`);
                }
                return 0;
            }
            case 'learn': {
                // Manual capture, borrowed from pro-workflow's /learn-rule: some rules
                // should not wait for a failed-then-fixed episode to prove them.
                // Two forms: <trigger> <prescription> | <trigger> <symptom> <prescription>.
                // Free text cannot be positionally split reliably, so the DSH command
                // uses first/last tokens; here the shell already did the splitting.
                const trigger = args[0] ?? '';
                const prescription = args.length >= 3 ? args[args.length - 1] ?? '' : args[1] ?? '';
                const symptom = args.length >= 3 ? args.slice(1, -1).join(' ') : '';
                if (!trigger.trim() || !prescription.trim()) {
                    process.stderr.write('usage: immune learn <trigger> [symptom] <prescription>\n' +
                        'example: immune learn "pnpm-lock.yaml 这个仓库" "用 pnpm 不是 npm"\n');
                    return 2;
                }
                const id = store.insert({
                    trigger_pattern: trigger,
                    symptom: symptom || '(manual rule)',
                    prescription,
                    tool_name: null,
                });
                process.stdout.write(id === null ? `${strings().notFound}\n` : `${strings().learned} #${id}.\n`);
                return 0;
            }
            case 'export-json': {
                // Library snapshots are how a library moves between machines or to a
                // teammate without npm, a server, or a shared filesystem.
                const target = args[0];
                const snapshot = exportLibrary(store);
                const body = JSON.stringify(snapshot, null, 2) + '\n';
                if (target) {
                    writeFileSync(resolve(target), body, 'utf8');
                    process.stdout.write(`exported ${snapshot.count} antibodies -> ${resolve(target)}\n`);
                }
                else {
                    process.stdout.write(body);
                }
                return 0;
            }
            case 'import-json': {
                const source = args[0];
                if (!source) {
                    process.stderr.write('usage: immune import-json <snapshot.json>\n');
                    return 2;
                }
                let snapshot;
                try {
                    snapshot = JSON.parse(readFileSync(resolve(source), 'utf8'));
                }
                catch (error) {
                    process.stderr.write(`cannot read snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
                    return 2;
                }
                if (typeof snapshot === 'object' &&
                    snapshot !== null &&
                    snapshot.format !== SNAPSHOT_FORMAT) {
                    process.stderr.write(`not a ${SNAPSHOT_FORMAT} snapshot (missing format tag)\n`);
                    return 2;
                }
                const report = importLibrary(store, snapshot);
                process.stdout.write(`imported: ${report.added} added, ${report.merged} merged, ${report.invalid} invalid\n`);
                return 0;
            }
            case 'doctor': {
                // Own store: the shared one is closed by main's finally, and closing a
                // store twice throws "database is not open".
                const doctorStore = new ImmuneStore();
                const results = runDoctor(doctorStore);
                let failures = 0;
                for (const check of results) {
                    if (!check.ok)
                        failures += 1;
                    process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`);
                }
                doctorStore.close();
                process.stdout.write(`\n${results.length - failures}/${results.length} checks passed${failures ? ` — fix the ${failures} FAIL above` : ''}\n`);
                return failures === 0 ? 0 : 1;
            }
            case 'forget': {
                // --last  : undo the antibody the previous turn just learned
                // --prune : drop never-injected antibodies older than 14 days
                if (args.includes('--last')) {
                    const id = store.forgetLast();
                    process.stdout.write(id === null ? `${strings().notFound}\n` : `${strings().forgot} #${id}.\n`);
                    return 0;
                }
                if (args.includes('--prune') || args.includes('--purge')) {
                    // --prune retires (reversible, stops injection); --purge deletes.
                    // Deletion is not the default because zero hits only proves the
                    // trigger has not come up yet, not that the rule is worthless.
                    const purge = args.includes('--purge');
                    const window = 14 * 24 * 60 * 60 * 1000;
                    const changed = purge ? store.pruneZombies(window) : store.retireZombies(window);
                    const label = purge ? strings().purged : strings().pruned;
                    process.stdout.write(changed.length === 0
                        ? `${strings().noZombies}\n`
                        : `${label} ${changed.length}: ${changed.map((n) => `#${n}`).join(' ')}\n`);
                    return 0;
                }
                const id = Number(args[0]);
                if (!Number.isFinite(id)) {
                    process.stderr.write('usage: immune forget <id> | --last | --prune | --purge\n');
                    return 2;
                }
                process.stdout.write(store.remove(id) ? `${strings().forgot} #${id}.\n` : `${strings().notFound} #${id}.\n`);
                return 0;
            }
            default:
                process.stderr.write('usage: immune <list|stats|export|prune|forget> [...args]\n');
                return 2;
        }
    }
    finally {
        if (!deferStoreClose)
            store.close();
    }
}
process.exitCode = main(process.argv.slice(2));
/**
 * The 30-second quickstart: run the REAL pipeline (distill a fresh failure ->
 * success episode, recall it from a paraphrase prompt, render the exact block
 * the hooks inject) against an in-memory store. Nothing canned, nothing
 * persisted — the user's library is never touched.
 */
async function runDemo() {
    const { distillEpisode } = await import('../../core/distiller.js');
    const { formatImmuneContext } = await import('./format.js');
    const { targetSignature } = await import('../../core/pairing.js');
    const store = new ImmuneStore({ dbPath: ':memory:' });
    store.insert({
        trigger_pattern: 'vite.config.ts 环境变量 loadEnv',
        symptom: '直接用 process.env 读客户端变量得到 undefined',
        prescription: '在 vite.config.ts 用 loadEnv(mode, process.cwd(), 前缀) 再传给 define',
    });
    store.insert({
        trigger_pattern: 'EPERM 只读目录 mkdir',
        symptom: '在只读目录创建 .dsh 或文件报 EPERM',
        prescription: '换可写工作目录，或用 IMMUNE_DB_PATH 显式指定库路径',
    });
    console.log('\n[1] a tool call fails (this project: npm install under a peer conflict)\n');
    console.log('  $ npm install');
    console.log('  npm ERR! ERESOLVE Unable to resolve dependency tree: peer react@19 found react-dom@18');
    console.log('  [exit code: 1]\n');
    console.log('[2] the retry succeeds — turn end distils the episode through the REAL pipeline\n');
    const distilled = await distillEpisode('Bash', 'tool=Bash input={"command":"npm install"} result=npm ERR! ERESOLVE unable to resolve dependency tree [exit code: 1]', 'tool=Bash input={"command":"npm install --legacy-peer-deps"} result=added 312 packages in 14s [exit code: 0]');
    if (!distilled.ok) {
        console.log(`  the demo episode was skipped: ${distilled.detail ?? 'unknown'}`);
        return;
    }
    const id = store.insert(distilled.antibody);
    console.log(`  learned antibody #${id}:`);
    console.log(`    trigger: ${distilled.antibody.trigger_pattern}`);
    console.log(`    symptom: ${distilled.antibody.symptom.slice(0, 80)}`);
    console.log(`    do:      ${distilled.antibody.prescription.slice(0, 80)}\n`);
    console.log('[3] a NEW session hits the same wall with different words — recall + injection\n');
    const hits = store.match('npm 装依赖又冲突了，装不上怎么办', { limit: 3 });
    const block = formatImmuneContext(hits);
    console.log(block
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'));
    console.log('\n[try more] immune list · immune doctor · immune ui   (demo data was in-memory only)\n');
}
