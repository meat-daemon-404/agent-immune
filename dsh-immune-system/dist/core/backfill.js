/**
 * History backfill: mine a ZCode session database for failed-then-fixed tool
 * episodes and enqueue them for distillation.
 *
 * The host records every tool call (`tool_usage`) and its full input/output
 * (`part` rows of type "tool", keyed by callID). That is everything the live
 * pairing loop sees, so the same logic can be REPLAYED over months of
 * history: the library does not have to wait for each pitfall to be
 * re-encountered — months of real lessons are already on disk.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { canCloseEpisode, targetSignature } from './pairing.js';
import { isSelfEpisode } from './selfnoise.js';
import { redactAndClamp } from './redact.js';
import { REPAIR_TOOLS } from './repair-tools.js';
function defaultSourceDb() {
    return `${homedir()}/.zcode/cli/db/db.sqlite`.replace(/\\/g, '/');
}
function loadCalls(db, since, sessionId) {
    const filter = sessionId ? 'AND session_id = ?' : '';
    const params = [since];
    if (sessionId)
        params.push(sessionId);
    return db
        .prepare(`SELECT session_id, tool_call_id, tool_name, status, error_message, started_at
        FROM tool_usage
        WHERE started_at >= ? AND status IN ('completed','error') ${filter}
        ORDER BY session_id ASC, started_at ASC`)
        .all(...params);
}
/** Tools whose episodes can produce a meaningful rule; protocol tools are excluded. */
const BACKFILL_TOOLS = new Set([
    'Bash', 'bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'NotebookEdit',
]);
function loadParts(db) {
    const map = new Map();
    const rows = db
        .prepare(`SELECT data FROM part WHERE json_extract(data, '$.type') = 'tool' ORDER BY time_created ASC`)
        .all();
    for (const row of rows) {
        try {
            const d = JSON.parse(row.data);
            if (typeof d.callID === 'string') {
                map.set(d.callID, {
                    input: d.state?.input ?? null,
                    output: typeof d.state?.output === 'string' ? d.state.output : '',
                });
            }
        }
        catch {
            // A malformed part is skipped; the error_message path still works.
        }
    }
    return map;
}
/** Replay the live pairing loop over one session's ordered calls. */
function pairSession(calls, parts, emit) {
    const signatureOf = (c) => targetSignature(c.tool_name, parts.get(c.tool_call_id)?.input ?? null);
    // Pending failures keyed by program family + tool, mirroring the live
    // pending_failures table's (session, tool) key.
    const pending = new Map();
    let failures = 0;
    let paired = 0;
    let superseded = 0;
    for (const call of calls) {
        if (!BACKFILL_TOOLS.has(call.tool_name))
            continue;
        if (call.status === 'error') {
            failures += 1;
            const signature = signatureOf(call);
            // A second error on the same family supersedes the pending one.
            for (const [key, entry] of pending) {
                if (canCloseEpisode(entry.signature.signature, signature)) {
                    pending.delete(key);
                    superseded += 1;
                }
            }
            pending.set(`${signature.signature}`, { call, signature, repairs: [] });
            continue;
        }
        if (REPAIR_TOOLS.has(call.tool_name)) {
            const part = parts.get(call.tool_call_id);
            const raw = (part?.input ?? {});
            const target = String(raw.file_path ?? raw.path ?? call.tool_name);
            const entry = `${call.tool_name} ${target.split(/[\\/]/).pop() ?? target}`;
            for (const p of pending.values())
                p.repairs.push(entry);
            continue;
        }
        // A success closes every pending failure of the same family.
        const signature = signatureOf(call);
        for (const [key, entry] of pending) {
            if (canCloseEpisode(entry.signature.signature, signature)) {
                pending.delete(key);
                paired += 1;
                emit(entry.call, call, entry.repairs.slice(-3));
            }
        }
    }
    return { failures, paired, superseded };
}
export function backfill(store, opts = {}) {
    const source = opts.sourceDb ?? defaultSourceDb();
    const days = opts.days ?? 120;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const db = new DatabaseSync(source, { readOnly: true });
    try {
        const calls = loadCalls(db, since, opts.sessionId);
        const parts = loadParts(db);
        const report = {
            scanned: calls.length,
            failures: 0,
            paired: 0,
            enqueued: 0,
            superseded: 0,
            skippedSelf: 0,
        };
        let currentSession = '';
        let sessionCalls = [];
        const flush = () => {
            if (sessionCalls.length === 0)
                return;
            const stats = pairSession(sessionCalls, parts, (fail, success, repairs) => {
                const failPart = parts.get(fail.tool_call_id);
                const successPart = parts.get(success.tool_call_id);
                const failureTrace = redactAndClamp(`tool=${fail.tool_name} input=${JSON.stringify(failPart?.input ?? {})} error=${fail.error_message ?? 'unknown'}`);
                const successTrace = redactAndClamp(`tool=${success.tool_name} input=${JSON.stringify(successPart?.input ?? {})} result=ok`);
                if (isSelfEpisode(`${failureTrace} ${successTrace}`, opts.selfMarkers ?? [])) {
                    report.skippedSelf += 1;
                    return;
                }
                store.enqueueJob(success.tool_name, failureTrace, successTrace, [], '', repairs);
                report.enqueued += 1;
            });
            report.failures += stats.failures;
            report.paired += stats.paired;
            report.superseded += stats.superseded;
        };
        for (const call of calls) {
            if (call.session_id !== currentSession) {
                flush();
                currentSession = call.session_id;
                sessionCalls = [];
            }
            sessionCalls.push(call);
        }
        flush();
        return report;
    }
    finally {
        db.close();
    }
}
