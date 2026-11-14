/**
 * ZCode hook I/O.
 *
 * Contract (verified against the local runtime and the shipped
 * `diagnosing-hooks` guide):
 *  - read exactly one JSON event object from stdin;
 *  - write at most one JSON object to stdout, and it must match a strict
 *    schema (an unknown key makes the whole hook fail);
 *  - put diagnostics on stderr only, never on stdout.
 *
 * Every hook therefore goes through `runHook`, which guarantees a zero exit
 * code and never lets a bug in this plugin break the user's turn.
 */
import { rememberPluginRoot } from './root-marker.js';
import { appendFileSync } from 'node:fs';
/**
 * Optional execution trace, enabled with IMMUNE_DEBUG_LOG=<path>.
 *
 * Useful because the runtime's own log does not always make it obvious which
 * plugin hook actually fired.
 */
function traceRun(eventName, sessionId) {
    const target = process.env.IMMUNE_DEBUG_LOG;
    if (!target)
        return;
    try {
        appendFileSync(target, `${new Date().toISOString()}\t${eventName}\t${sessionId}\n`);
    }
    catch {
        // Diagnostics must never break a hook.
    }
}
const MAX_CONTEXT = 10_000;
let activeAntigravityEvent = false;
let deniedByHook = false;
export function log(message) {
    try {
        process.stderr.write(`[immune] ${message}\n`);
    }
    catch {
        // stderr failures must never surface.
    }
}
/**
 * The only stdout write this plugin performs. Kept to the single documented
 * shape so strict schema validation cannot fail on an extra key.
 */
export function emitContext(eventName, additionalContext) {
    const text = additionalContext.slice(0, MAX_CONTEXT);
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
    }));
}
/**
 * Deny a tool call (PreToolUse only).
 *
 * Uses the one additional shape the schema allows for this event. Only the
 * three documented keys are emitted — an extra key fails validation and the
 * whole hook is discarded, which would silently turn a deny into an allow.
 */
export function emitDeny(eventName, reason) {
    deniedByHook = true;
    if (activeAntigravityEvent) {
        process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: reason.slice(0, MAX_CONTEXT) })}\n`);
        return;
    }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: eventName,
            permissionDecision: 'deny',
            permissionDecisionReason: reason.slice(0, MAX_CONTEXT),
        },
    }));
}
export function isAntigravityEvent(event) {
    return (typeof event.conversationId === 'string' ||
        Array.isArray(event.workspacePaths) ||
        (typeof event.toolCall === 'object' && event.toolCall !== null));
}
/**
 * Normalise host-specific parameter names (e.g. Antigravity's CommandLine /
 * Path / TargetFile) into the canonical fields core/ expects while preserving
 * all original keys.
 */
export function normaliseToolInput(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return raw;
    const obj = { ...raw };
    if (obj.command === undefined && typeof obj.CommandLine === 'string') {
        obj.command = obj.CommandLine;
    }
    if (obj.file_path === undefined) {
        const pathCandidate = obj.Path ?? obj.TargetFile ?? obj.AbsolutePath ?? obj.DirectoryPath;
        if (typeof pathCandidate === 'string')
            obj.file_path = pathCandidate;
    }
    if (obj.pattern === undefined) {
        const patCandidate = obj.Query ?? obj.Pattern;
        if (typeof patCandidate === 'string')
            obj.pattern = patCandidate;
    }
    if (obj.old_string === undefined && typeof obj.Target === 'string') {
        obj.old_string = obj.Target;
    }
    if (obj.new_string === undefined && typeof obj.Replacement === 'string') {
        obj.new_string = obj.Replacement;
    }
    if (obj.content === undefined && typeof obj.Content === 'string') {
        obj.content = obj.Content;
    }
    return obj;
}
/** Fold Antigravity camelCase fields into the shared HookEvent shape. */
export function normaliseHookEvent(event) {
    if (!event.session_id && typeof event.conversationId === 'string' && event.conversationId) {
        event.session_id = event.conversationId;
    }
    if (!event.cwd &&
        Array.isArray(event.workspacePaths) &&
        typeof event.workspacePaths[0] === 'string' &&
        event.workspacePaths[0]) {
        event.cwd = event.workspacePaths[0];
    }
    if (event.prompt === undefined && typeof event.lastUserInput === 'string') {
        event.prompt = event.lastUserInput;
    }
    if (typeof event.toolCall === 'object' && event.toolCall !== null) {
        if (!event.tool_name && typeof event.toolCall.name === 'string') {
            event.tool_name = event.toolCall.name;
        }
        if (event.tool_input === undefined && event.toolCall.args !== undefined) {
            event.tool_input = event.toolCall.args;
        }
    }
    if (event.tool_input !== undefined) {
        event.tool_input = normaliseToolInput(event.tool_input);
    }
    if (typeof event.modelName === 'string' &&
        event.modelName.trim() &&
        !process.env.IMMUNE_MODEL_NAME) {
        process.env.IMMUNE_MODEL_NAME = event.modelName.trim();
    }
    return event;
}
export async function readEvent() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return {};
        const event = parsed;
        activeAntigravityEvent = isAntigravityEvent(event);
        return normaliseHookEvent(event);
    }
    catch {
        log('ignoring malformed stdin');
        return {};
    }
}
export function eventNameOf(event, fallback) {
    return event.hook_event_name ?? event.hookEventName ?? fallback;
}
export function sessionIdOf(event) {
    const id = event.session_id ?? event.sessionId ?? event.conversationId;
    return typeof id === 'string' && id ? id : 'unknown-session';
}
/**
 * Host tool names, normalised to the vocabulary the engine speaks.
 *
 * Codex emits `shell_command` / `exec_command` / `apply_patch`; Antigravity
 * emits `run_command` / `edit_file` / `replace_file_content` / `write_file` /
 * `read_file` / `view_file` / `grep_search` / `find_by_name` / `list_dir`.
 * The pairing loop, REPAIR_TOOLS and program-family matching all key on ZCode's
 * Bash/Edit names. Keep the map here — one entry point every hook already
 * calls — so no adapter code is duplicated per host.
 */
const HOST_TOOL_ALIASES = {
    shell_command: 'Bash',
    exec_command: 'Bash',
    shell: 'Bash',
    local_shell: 'Bash',
    apply_patch: 'Edit',
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
export function normaliseToolName(name) {
    return HOST_TOOL_ALIASES[name.toLowerCase()] ?? name;
}
export function toolNameOf(event) {
    const name = event.tool_name ?? event.toolName ?? event.toolCall?.name;
    return typeof name === 'string' && name
        ? normaliseToolName(name)
        : 'unknown-tool';
}
function emitAntigravityResult(fallbackName, context) {
    const trimmed = context?.trim() ?? '';
    switch (fallbackName) {
        case 'SessionStart':
        case 'UserPromptSubmit': {
            if (trimmed) {
                process.stdout.write(`${JSON.stringify({
                    injectSteps: [{ systemMessage: { systemMessage: trimmed.slice(0, MAX_CONTEXT) } }],
                })}\n`);
            }
            else {
                process.stdout.write('{}\n');
            }
            return;
        }
        case 'PreToolUse': {
            const payload = trimmed
                ? { decision: 'allow', reason: trimmed.slice(0, MAX_CONTEXT) }
                : { decision: 'allow' };
            process.stdout.write(`${JSON.stringify(payload)}\n`);
            return;
        }
        case 'Stop':
            process.stdout.write(`${JSON.stringify({ decision: 'allow' })}\n`);
            return;
        default:
            process.stdout.write('{}\n');
    }
}
/**
 * Run a hook body. `body` returns the context to inject, or null to stay
 * silent. Any throw is logged and swallowed: a broken plugin must not break
 * the session.
 */
export async function runHook(fallbackName, body) {
    activeAntigravityEvent = false;
    deniedByHook = false;
    try {
        rememberPluginRoot();
        const event = await readEvent();
        const eventName = eventNameOf(event, fallbackName);
        traceRun(eventName, sessionIdOf(event));
        const context = await body(event, eventName);
        if (deniedByHook) {
            // emitDeny already wrote the host-formatted denial.
        }
        else if (activeAntigravityEvent) {
            emitAntigravityResult(fallbackName, context);
        }
        else if (context && context.trim()) {
            emitContext(eventName, context);
        }
    }
    catch (error) {
        log(`hook error: ${error instanceof Error ? error.message : String(error)}`);
        if (activeAntigravityEvent && !deniedByHook) {
            emitAntigravityResult(fallbackName, null);
        }
    }
    process.exitCode = 0;
}
