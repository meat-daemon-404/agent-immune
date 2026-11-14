/**
 * `immune audit` — a health check over the history you already have.
 *
 * Cold start is the problem this solves: a fresh install has an empty
 * library and nothing to show. Every supported host keeps its history on
 * disk, and the failed-then-fixed episodes inside it are exactly what the
 * live pairing loop would have caught. The audit replays the same pairing
 * (core/backfill.ts's pairSession) over that history, reports per-tool
 * failure counts, top repeat offenders and the avoidable token cost when a
 * token median is available, then enqueues the episodes for distillation.
 *
 * Source status is reported honestly: the ZCode db and Codex rollout formats
 * were verified against real files; the Claude Code transcript parser is
 * fixture-tested only (no real transcripts existed on the dev machine).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BACKFILL_TOOLS, loadCalls, loadParts, pairSession } from './backfill.js';
import { isSelfEpisode } from './selfnoise.js';
import { redactAndClamp } from './redact.js';
import { ROUND_TRIPS_PER_REPEAT } from './value.js';
/** Trace strings are clamped before redaction, like the live loop. */
const TRACE_CLAMP = 1_200;
const TOP_FAMILIES = 5;
/** A family is only reportable when it repeated. */
const MIN_FAMILY_COUNT = 2;
/** Median needs enough of a distribution to mean anything (value.ts's bar). */
const MIN_TOKEN_SAMPLES = 30;
function clampText(text, max = 2_000) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
function medianOf(values) {
    if (values.length < MIN_TOKEN_SAMPLES)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return Number.isFinite(median) && median > 0
        ? { median: Math.round(median), samples: sorted.length }
        : null;
}
function emptySource(source, note) {
    return {
        source,
        present: false,
        ...(note !== undefined ? { note } : {}),
        scanned: 0,
        failures: 0,
        paired: 0,
        superseded: 0,
        enqueued: 0,
        skippedSelf: 0,
        byTool: [],
        topFailures: [],
        medianRequestTokens: null,
        medianSamples: 0,
    };
}
/**
 * Replay the pairing loop over one source's sessions and fold the results
 * into a per-source report. The emit path mirrors core/backfill.ts's enqueue
 * (redact -> self-noise gate -> enqueueJob), so a rule distilled from `audit`
 * is indistinguishable from one distilled live.
 */
function runSource(source, sessions, store, opts) {
    const report = emptySource(source);
    report.present = true;
    const toolIndex = new Map();
    const families = new Map();
    const bumpTool = (tool) => {
        const existing = toolIndex.get(tool);
        if (existing)
            return existing;
        const created = { tool, scanned: 0, failures: 0, paired: 0 };
        toolIndex.set(tool, created);
        return created;
    };
    for (const session of sessions) {
        const stats = pairSession(session.calls, session.parts, (fail, success, repairs) => {
            // Quota guard, same as backfill: a slow LLM channel needs an explicit cap.
            if (opts.cap !== null && report.enqueued >= opts.cap)
                return;
            const failPart = session.parts.get(fail.tool_call_id);
            const successPart = session.parts.get(success.tool_call_id);
            const failureTrace = redactAndClamp(`tool=${fail.tool_name} input=${JSON.stringify(failPart?.input ?? {})} error=${fail.error_message ?? 'unknown'}`, TRACE_CLAMP);
            const successTrace = redactAndClamp(`tool=${success.tool_name} input=${JSON.stringify(successPart?.input ?? {})} result=ok`, TRACE_CLAMP);
            if (isSelfEpisode(`${failureTrace} ${successTrace}`, opts.selfMarkers)) {
                report.skippedSelf += 1;
                return;
            }
            // In dry-run the episode is counted as "would be enqueued" but not stored.
            if (!opts.dryRun) {
                store.enqueueJob(success.tool_name, failureTrace, successTrace, [], '', repairs);
            }
            report.enqueued += 1;
            bumpTool(success.tool_name).paired += 1;
        });
        report.scanned += session.calls.length;
        report.failures += stats.failures;
        report.paired += stats.paired;
        report.superseded += stats.superseded;
        for (const call of session.calls) {
            // Same filter the pairing loop applies: protocol/MCP tools are out of
            // scope for rules, so they are out of scope for the stats too.
            if (!BACKFILL_TOOLS.has(call.tool_name))
                continue;
            const stat = bumpTool(call.tool_name);
            stat.scanned += 1;
            if (call.status !== 'error')
                continue;
            stat.failures += 1;
            const firstLine = (call.error_message ?? 'unknown').split('\n')[0] ?? 'unknown';
            const normalized = firstLine.replace(/\s+/g, ' ').trim();
            const key = `${call.tool_name}|${normalized.toLowerCase().slice(0, 80)}`;
            const family = families.get(key);
            if (family)
                family.count += 1;
            else
                families.set(key, { tool: call.tool_name, error: normalized.slice(0, 80), count: 1 });
        }
    }
    report.byTool = [...toolIndex.values()].sort((a, b) => b.failures - a.failures || b.scanned - a.scanned);
    report.topFailures = [...families.values()]
        .filter((family) => family.count >= MIN_FAMILY_COUNT)
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_FAMILIES);
    return report;
}
/**
 * ZCode source: the session database's tool_usage + part tables, through the
 * exact loaders core/backfill.ts uses. Format verified against a real db.
 */
function loadZcodeSessions(sourceDb, since) {
    const db = new DatabaseSync(sourceDb, { readOnly: true });
    try {
        const calls = loadCalls(db, since);
        const errorSessions = [
            ...new Set(calls
                .filter((call) => call.status === 'error' && BACKFILL_TOOLS.has(call.tool_name))
                .map((call) => call.session_id)),
        ];
        const parts = loadParts(db, errorSessions);
        const sessions = new Map();
        for (const call of calls) {
            const bucket = sessions.get(call.session_id) ?? { calls: [], parts, tokenSamples: [] };
            bucket.calls.push(call);
            sessions.set(call.session_id, bucket);
        }
        return [...sessions.values()];
    }
    finally {
        db.close();
    }
}
/** ZCode's model_usage rows give the token median for its own source. */
function zcodeTokenMedian(sourceDb) {
    let db = null;
    try {
        db = new DatabaseSync(sourceDb, { readOnly: true });
        const rows = db
            .prepare(`SELECT computed_total_tokens AS t FROM model_usage
          WHERE status = 'completed' AND computed_total_tokens > 0
          ORDER BY started_at DESC LIMIT 500`)
            .all();
        return medianOf(rows.map((row) => Number(row.t)));
    }
    catch {
        return null;
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // Read-only probe; a failed close is not worth an exception.
        }
    }
}
/**
 * Codex source: rollout files under ~/.codex/sessions/YYYY/MM/DD/. Format
 * verified against real rollouts: `response_item` payloads carry
 * function_call {call_id, name, arguments} and function_call_output
 * {call_id, output}, and shell output begins "Exit code: N".
 */
const CODEX_TOOL_MAP = {
    shell_command: 'Bash',
    exec_command: 'Bash',
    shell: 'Bash',
    local_shell: 'Bash',
    apply_patch: 'Edit',
};
/** Shell output starts "Exit code: N" — the same verdict the judge reads. */
function codexStatusOf(output) {
    const match = output.match(/^Exit code: (\d+)/);
    if (!match)
        return { status: 'completed' };
    if (Number(match[1]) === 0)
        return { status: 'completed' };
    // The exit-code header is the verdict, not the lesson: strip the boilerplate
    // (Exit code / Wall time / Output) so the error text — and the
    // repeat-offender families built from its first line — carries the actual
    // failure instead of 279 copies of "Exit code: 1".
    const body = output
        .slice(match[0].length)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !/^Wall time:/.test(line) && !/^Output:$/.test(line))
        .join('\n');
    return { status: 'error', error: clampText(body.length > 0 ? body : output) };
}
function loadCodexSessions(dir, since) {
    if (!existsSync(dir))
        return { sessions: [], present: false, note: 'no ~/.codex/sessions directory' };
    const sessions = [];
    // sessions/YYYY/MM/DD/rollout-*.jsonl — the path carries the date, so
    // day directories older than `since` are pruned without opening any file.
    for (const year of readdirSync(dir)) {
        for (const month of readdirSync(join(dir, year))) {
            for (const day of readdirSync(join(dir, year, month))) {
                const dayMs = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
                if (Number.isFinite(dayMs) && dayMs < since - 86_400_000)
                    continue;
                const dayDir = join(dir, year, month, day);
                for (const file of readdirSync(dayDir)) {
                    if (!file.startsWith('rollout-') || !file.endsWith('.jsonl'))
                        continue;
                    const parsed = parseCodexFile(join(dayDir, file));
                    if (parsed.calls.length > 0)
                        sessions.push(parsed);
                }
            }
        }
    }
    return { sessions, present: true, ...(sessions.length === 0 ? { note: 'no tool calls in rollouts' } : {}) };
}
function parseCodexFile(path) {
    const calls = [];
    const parts = new Map();
    const callIndex = new Map();
    let lines = [];
    try {
        lines = readFileSync(path, 'utf8').split('\n');
    }
    catch {
        return { calls, parts, tokenSamples: [] };
    }
    for (const line of lines) {
        if (!line.trim())
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            continue; // A partial trailing line is normal for an active file.
        }
        if (record.type !== 'response_item' || !record.payload)
            continue;
        const payload = record.payload;
        const timestamp = record.timestamp ? Date.parse(record.timestamp) : Date.now();
        if (payload.type === 'function_call' && payload.call_id) {
            callIndex.set(payload.call_id, {
                name: payload.name ?? 'unknown',
                arguments: payload.arguments ?? '',
                timestamp,
            });
        }
        else if (payload.type === 'function_call_output' && payload.call_id) {
            const call = callIndex.get(payload.call_id);
            if (!call)
                continue;
            const tool = CODEX_TOOL_MAP[call.name] ?? null;
            if (!tool)
                continue; // Unmapped protocol tools are out of scope.
            const output = typeof payload.output === 'string' ? payload.output : '';
            const verdict = codexStatusOf(output);
            const input = safeJson(call.arguments);
            calls.push({
                session_id: path,
                tool_call_id: payload.call_id,
                tool_name: tool,
                status: verdict.status,
                error_message: verdict.error ?? null,
                started_at: call.timestamp,
            });
            parts.set(payload.call_id, { input, output: clampText(output) });
        }
    }
    calls.sort((a, b) => a.started_at - b.started_at);
    return { calls, parts, tokenSamples: [] };
}
/**
 * Claude Code source: transcripts under ~/.claude/projects/<project>/ at any
 * nesting depth — flat session files, plus nested subagent transcripts
 * (e.g. <project>/<session>/subagents/*.jsonl on newer builds). Assistant
 * lines carry tool_use blocks; user lines carry tool_result blocks with
 * is_error; older lines omit is_error and only carry an "Exit code: N" text
 * marker, which the parser reads as a fallback verdict. FIXTURE-TESTED ONLY —
 * no real transcripts existed on the dev machine (only a per-project memory/
 * directory, which the scan deliberately skips), and the parser refuses
 * nothing it should not read.
 */
function listClaudeTranscripts(dir, depth = 0) {
    // Four levels is generous: <project>/<uuid>/subagents/<file> is three.
    if (depth > 4)
        return [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
        }));
    }
    catch {
        return [];
    }
    const files = [];
    for (const entry of entries) {
        if (entry.isDirectory) {
            // memory/ holds per-project agent notes, not transcripts.
            if (entry.name === 'memory')
                continue;
            files.push(...listClaudeTranscripts(join(dir, entry.name), depth + 1));
        }
        else if (entry.name.endsWith('.jsonl')) {
            files.push(join(dir, entry.name));
        }
    }
    return files;
}
function loadClaudeSessions(dir, since) {
    if (!existsSync(dir))
        return { sessions: [], present: false, note: 'no ~/.claude/projects directory' };
    const sessions = [];
    for (const project of readdirSync(dir)) {
        const projectDir = join(dir, project);
        for (const file of listClaudeTranscripts(projectDir)) {
            const parsed = parseClaudeFile(file, since);
            if (parsed.calls.length > 0)
                sessions.push(parsed);
        }
    }
    return { sessions, present: true, ...(sessions.length === 0 ? { note: 'no tool calls in transcripts' } : {}) };
}
function parseClaudeFile(path, since) {
    const calls = [];
    const callById = new Map();
    const parts = new Map();
    const tokenSamples = [];
    let lines = [];
    try {
        lines = readFileSync(path, 'utf8').split('\n');
    }
    catch {
        return { calls, parts, tokenSamples };
    }
    for (const line of lines) {
        if (!line.trim())
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            continue;
        }
        // Usage rides on assistant messages — the per-request token sample.
        if (record.type === 'assistant' && record.message?.usage) {
            const total = Number(record.message.usage.input_tokens ?? 0) + Number(record.message.usage.output_tokens ?? 0);
            if (total > 0)
                tokenSamples.push(total);
        }
        const timestamp = record.timestamp ? Date.parse(record.timestamp) : Date.now();
        const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
        for (const block of blocks) {
            if (block.type === 'tool_use' && typeof block.id === 'string') {
                calls.push({
                    session_id: path,
                    tool_call_id: block.id,
                    tool_name: String(block.name ?? 'unknown'),
                    status: 'completed', // The verdict arrives with the tool_result.
                    error_message: null,
                    started_at: timestamp,
                });
                parts.set(block.id, { input: block.input ?? null, output: '' });
                callById.set(block.id, calls[calls.length - 1]);
            }
            else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const text = claudeResultText(block.content);
                const call = callById.get(block.tool_use_id);
                if (call) {
                    const verdict = claudeVerdictOf(block, text);
                    call.status = verdict.status;
                    call.error_message = verdict.error ?? null;
                    call.started_at = timestamp;
                    call.session_id = path;
                }
                const part = parts.get(block.tool_use_id);
                if (part)
                    part.output = clampText(text);
            }
        }
    }
    calls.sort((a, b) => a.started_at - b.started_at);
    // Transcripts older than the audit window contribute nothing to pairing and
    // are dropped after parsing (the parser needs the whole file to pair).
    const inWindow = calls.filter((call) => call.started_at >= since);
    return { calls: inWindow, parts, tokenSamples };
}
function claudeResultText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((block) => typeof block === 'object' && block !== null && 'text' in block
            ? String(block.text)
            : '')
            .join('');
    }
    return '';
}
/**
 * Verdict for a Claude Code tool_result. The structured `is_error` flag is
 * authoritative (the same rank the judge gives a structured status); only a
 * record that carries NO flag falls back to the "Exit code: N" text marker —
 * the same verdict shape the Codex parser reads — because without a flag the
 * text is all the transcript says. A passing command that merely prints an
 * exit code is protected by reading the marker only near the start of the
 * text, where Claude Code's own wrapper puts it.
 */
function claudeVerdictOf(block, text) {
    if (block.is_error === true)
        return { status: 'error', error: clampText(text) };
    if (block.is_error === false)
        return { status: 'completed' };
    const head = text.slice(0, 300);
    const match = head.match(/^Exit code: (\d+)/m);
    if (match && Number(match[1]) !== 0) {
        return { status: 'error', error: clampText(text) };
    }
    return { status: 'completed' };
}
function safeJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
/**
 * Antigravity source: conversation transcripts under
 * ~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl.
 * PLANNER_RESPONSE steps carry tool_calls + token usage; subsequent GENERIC
 * steps carry status/error or `Command exited with code N.` for run_command.
 */
const ANTIGRAVITY_TOOL_MAP = {
    run_command: 'Bash',
    edit_file: 'Edit',
    replace_file_content: 'Edit',
    multi_replace_file_content: 'Edit',
    write_file: 'Write',
    write_to_file: 'Write',
    read_file: 'Read',
    view_file: 'Read',
    view_file_outline: 'Read',
    view_code_item: 'Read',
    grep_search: 'Grep',
    find_by_name: 'Glob',
    list_dir: 'Glob',
};
function unwrapAntigravityArgs(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        let decoded = value;
        if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
            try {
                decoded = JSON.parse(value);
            }
            catch {
                decoded = value;
            }
        }
        out[key] = decoded;
    }
    if (out.command === undefined && typeof out.CommandLine === 'string')
        out.command = out.CommandLine;
    if (out.file_path === undefined) {
        const pathCandidate = out.Path ??
            out.TargetFile ??
            out.AbsolutePath ??
            out.DirectoryPath ??
            out.SearchPath ??
            out.SearchDirectory;
        if (typeof pathCandidate === 'string')
            out.file_path = pathCandidate;
    }
    if (out.pattern === undefined) {
        const patCandidate = out.Query ?? out.Pattern;
        if (typeof patCandidate === 'string')
            out.pattern = patCandidate;
    }
    return out;
}
function antigravityErrorLine(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 &&
        !/^(Created At|Completed At|Command output|Showing lines|Partial read):?/i.test(line));
    const body = lines.join('\n').trim();
    return clampText(body || text.trim() || 'unknown error');
}
function antigravityVerdictOf(toolName, record) {
    const content = typeof record.content === 'string' ? record.content : '';
    const errField = typeof record.error === 'string' ? record.error.trim() : '';
    if (record.status === 'ERROR' || errField.length > 0) {
        const rawErr = errField || content;
        if (/tool call denied by pre-tool hook|editing tools are refused while plan mode|plan mode only allows|\[sandbox:\s*file access denied|was cancelled|was aborted/i.test(rawErr)) {
            return { ignore: true, status: 'completed', output: '' };
        }
        return { status: 'error', error: antigravityErrorLine(rawErr), output: clampText(content || rawErr) };
    }
    if (toolName === 'Bash') {
        const exitMatch = content.match(/^Command exited with code (-?\d+)\./m);
        if (exitMatch && Number(exitMatch[1]) !== 0) {
            const outputMarker = 'Command output:\n';
            const idx = content.indexOf(outputMarker);
            const after = idx >= 0 ? content.slice(idx + outputMarker.length) : content.slice((exitMatch.index ?? 0) + exitMatch[0].length);
            return {
                status: 'error',
                error: antigravityErrorLine(after) || `Command exited with code ${exitMatch[1]}`,
                output: clampText(content),
            };
        }
    }
    return { status: 'completed', output: clampText(content) };
}
function parseAntigravityFile(path, since) {
    const calls = [];
    const parts = new Map();
    const tokenSamples = [];
    let lines = [];
    try {
        lines = readFileSync(path, 'utf8').split('\n');
    }
    catch {
        return { calls, parts, tokenSamples };
    }
    const pendingCalls = [];
    let seq = 0;
    for (const line of lines) {
        if (!line.trim())
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            continue;
        }
        const timestamp = record.created_at ? Date.parse(record.created_at) : Date.now();
        if (record.type === 'USER_INPUT') {
            pendingCalls.length = 0;
            continue;
        }
        if (record.type === 'PLANNER_RESPONSE') {
            pendingCalls.length = 0;
            const total = Number(record.input_tokens ?? 0) +
                Number(record.cache_read_tokens ?? 0) +
                Number(record.output_tokens ?? 0);
            if (total > 0 && timestamp >= since)
                tokenSamples.push(total);
            if (Array.isArray(record.tool_calls)) {
                for (const tc of record.tool_calls) {
                    const rawName = typeof tc?.name === 'string' ? tc.name : '';
                    if (!rawName)
                        continue;
                    seq += 1;
                    pendingCalls.push({
                        tool: ANTIGRAVITY_TOOL_MAP[rawName] ?? rawName,
                        input: unwrapAntigravityArgs(tc.args),
                        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
                        callId: `agy-${record.step_index ?? 'x'}-${seq}`,
                    });
                }
            }
            continue;
        }
        if (record.type === 'GENERIC' && pendingCalls.length > 0) {
            const pending = pendingCalls.shift();
            const ts = Number.isFinite(timestamp) ? timestamp : pending.timestamp;
            if (ts < since)
                continue;
            const verdict = antigravityVerdictOf(pending.tool, record);
            if (verdict.ignore)
                continue;
            calls.push({
                session_id: path,
                tool_call_id: pending.callId,
                tool_name: pending.tool,
                status: verdict.status,
                error_message: verdict.error ?? null,
                started_at: ts,
            });
            parts.set(pending.callId, { input: pending.input, output: verdict.output });
        }
    }
    calls.sort((a, b) => a.started_at - b.started_at);
    return { calls, parts, tokenSamples };
}
function loadAntigravitySessions(dir, since) {
    if (!existsSync(dir))
        return { sessions: [], present: false, note: 'no ~/.gemini/antigravity/brain directory' };
    const sessions = [];
    let entries = [];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return { sessions: [], present: true, note: 'unreadable ~/.gemini/antigravity/brain directory' };
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const transcript = join(dir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcript))
            continue;
        try {
            if (statSync(transcript).mtimeMs < since - 86_400_000)
                continue;
        }
        catch {
            continue;
        }
        const parsed = parseAntigravityFile(transcript, since);
        if (parsed.calls.length > 0)
            sessions.push(parsed);
    }
    return { sessions, present: true, ...(sessions.length === 0 ? { note: 'no tool calls in transcripts' } : {}) };
}
/**
 * Scan every available source, replay pairing over its sessions, and enqueue
 * episodes for distillation (unless dryRun). Sources absent from this machine
 * are reported as absent rather than skipped silently.
 */
export function auditHistory(store, opts = {}) {
    const days = opts.days ?? 30;
    const since = Date.now() - days * 86_400_000;
    const cap = opts.max !== undefined && Number.isFinite(opts.max) && opts.max > 0 ? Math.trunc(opts.max) : null;
    const selfMarkers = opts.selfMarkers ?? [];
    const wanted = opts.source ?? 'auto';
    const dryRun = opts.dryRun === true;
    const zcodeDb = opts.sourceDb ?? `${homedir()}/.zcode/cli/db/db.sqlite`.replace(/\\/g, '/');
    const codexDir = opts.codexSessionsDir ?? join(homedir(), '.codex', 'sessions');
    const claudeDir = opts.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
    const antigravityDir = opts.antigravityBrainDir ?? join(homedir(), '.gemini', 'antigravity', 'brain');
    const sources = [];
    if (wanted === 'auto' || wanted === 'zcode') {
        if (existsSync(zcodeDb)) {
            const sessions = loadZcodeSessions(zcodeDb, since);
            const report = runSource('zcode', sessions, store, { cap, dryRun, selfMarkers });
            const median = zcodeTokenMedian(zcodeDb);
            report.medianRequestTokens = median?.median ?? null;
            report.medianSamples = median?.samples ?? 0;
            sources.push(report);
        }
        else {
            sources.push(emptySource('zcode', 'no ~/.zcode/cli/db/db.sqlite'));
        }
    }
    if (wanted === 'auto' || wanted === 'codex') {
        const { sessions, present, note } = loadCodexSessions(codexDir, since);
        if (present) {
            const report = runSource('codex', sessions, store, { cap, dryRun, selfMarkers });
            if (note)
                report.note = note;
            sources.push(report);
        }
        else {
            sources.push(emptySource('codex', note));
        }
    }
    if (wanted === 'auto' || wanted === 'claude-code') {
        const { sessions, present, note } = loadClaudeSessions(claudeDir, since);
        if (present) {
            const report = runSource('claude-code', sessions, store, { cap, dryRun, selfMarkers });
            // Provenance is part of the report: this parser is fixture-tested only.
            report.note = note ?? 'parser fixture-tested; not yet verified against a real install';
            const median = medianOf(sessions.flatMap((session) => session.tokenSamples));
            report.medianRequestTokens = median?.median ?? null;
            report.medianSamples = median?.samples ?? 0;
            sources.push(report);
        }
        else {
            sources.push(emptySource('claude-code', note));
        }
    }
    if (wanted === 'auto' || wanted === 'antigravity') {
        const { sessions, present, note } = loadAntigravitySessions(antigravityDir, since);
        if (present) {
            const report = runSource('antigravity', sessions, store, { cap, dryRun, selfMarkers });
            if (note)
                report.note = note;
            const median = medianOf(sessions.flatMap((session) => session.tokenSamples));
            report.medianRequestTokens = median?.median ?? null;
            report.medianSamples = median?.samples ?? 0;
            sources.push(report);
        }
        else {
            sources.push(emptySource('antigravity', note));
        }
    }
    const totals = sources.reduce((acc, source) => ({
        scanned: acc.scanned + source.scanned,
        failures: acc.failures + source.failures,
        paired: acc.paired + source.paired,
        enqueued: acc.enqueued + source.enqueued,
        skippedSelf: acc.skippedSelf + source.skippedSelf,
    }), { scanned: 0, failures: 0, paired: 0, enqueued: 0, skippedSelf: 0 });
    return { sources, totals };
}
/** Formatted tokens need value.ts's short form; CLI and MCP render identically. */
function formatTokensShort(tokens) {
    if (tokens >= 1_000_000_000)
        return `${(tokens / 1_000_000_000).toFixed(1)}B`;
    if (tokens >= 1_000_000)
        return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000)
        return `${(tokens / 1_000).toFixed(1)}K`;
    return String(tokens);
}
/**
 * Render the shareable audit summary. One renderer for every surface — the
 * CLI, the MCP tool and a pasted chat reply all show the same report, so a
 * number can never disagree between them.
 */
export function renderAuditReport(report, days, dryRun) {
    const lines = [`immune audit — last ${days} day(s)`];
    for (const source of report.sources) {
        if (!source.present) {
            lines.push(`[${source.source}] absent · ${source.note ?? 'no data'}`);
            continue;
        }
        lines.push(`[${source.source}] scanned ${source.scanned} · ${source.failures} failures · ` +
            `${source.paired} paired (${source.superseded} superseded) · ` +
            `${source.enqueued} enqueued (${source.skippedSelf} self-noise skipped)` +
            (source.note ? ` · ${source.note}` : ''));
        const tools = source.byTool.slice(0, 4);
        if (tools.length > 0) {
            lines.push(`  by tool: ${tools.map((stat) => `${stat.tool} ${stat.failures}f/${stat.scanned}`).join(' · ')}`);
        }
        if (source.topFailures.length > 0) {
            lines.push('  repeat offenders:');
            for (const family of source.topFailures) {
                lines.push(`    ${family.count}× [${family.tool}] ${family.error}`);
            }
        }
        if (source.medianRequestTokens !== null && source.paired > 0) {
            const waste = source.paired * source.medianRequestTokens * ROUND_TRIPS_PER_REPEAT;
            lines.push(`  tokens: median request ${formatTokensShort(source.medianRequestTokens)} ` +
                `(${source.medianSamples} samples) — ${source.paired} episodes ≈ ${formatTokensShort(waste)} tokens`);
        }
    }
    lines.push(`scan total: ${report.totals.scanned} calls · ${report.totals.failures} failures · ` +
        `${report.totals.paired} failed-then-fixed episodes`);
    if (dryRun) {
        lines.push('dry run: nothing enqueued, nothing distilled — drop --dry-run to apply');
    }
    return lines.join('\n');
}
