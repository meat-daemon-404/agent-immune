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
function traceRun(eventName: string, sessionId: string): void {
  const target = process.env.IMMUNE_DEBUG_LOG;
  if (!target) return;
  try {
    appendFileSync(target, `${new Date().toISOString()}\t${eventName}\t${sessionId}\n`);
  } catch {
    // Diagnostics must never break a hook.
  }
}

export interface HookEvent {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_result_preview?: string;
  error?: unknown;
  error_details?: unknown;
  prompt?: string;
  source?: string;
  [key: string]: unknown;
}

const MAX_CONTEXT = 10_000;

export function log(message: string): void {
  try {
    process.stderr.write(`[immune] ${message}\n`);
  } catch {
    // stderr failures must never surface.
  }
}

/**
 * The only stdout write this plugin performs. Kept to the single documented
 * shape so strict schema validation cannot fail on an extra key.
 */
export function emitContext(eventName: string, additionalContext: string): void {
  const text = additionalContext.slice(0, MAX_CONTEXT);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
    }),
  );
}

/**
 * Deny a tool call (PreToolUse only).
 *
 * Uses the one additional shape the schema allows for this event. Only the
 * three documented keys are emitted — an extra key fails validation and the
 * whole hook is discarded, which would silently turn a deny into an allow.
 */
export function emitDeny(eventName: string, reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: 'deny',
        permissionDecisionReason: reason.slice(0, MAX_CONTEXT),
      },
    }),
  );
}

export async function readEvent(): Promise<HookEvent> {  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookEvent) : {};
  } catch {
    log('ignoring malformed stdin');
    return {};
  }
}

export function eventNameOf(event: HookEvent, fallback: string): string {
  return event.hook_event_name ?? event.hookEventName ?? fallback;
}

export function sessionIdOf(event: HookEvent): string {
  const id = event.session_id ?? event.sessionId;
  return typeof id === 'string' && id ? id : 'unknown-session';
}

export function toolNameOf(event: HookEvent): string {
  const name = event.tool_name ?? event.toolName;
  return typeof name === 'string' && name ? name : 'unknown-tool';
}

/**
 * Run a hook body. `body` returns the context to inject, or null to stay
 * silent. Any throw is logged and swallowed: a broken plugin must not break
 * the session.
 */
export async function runHook(
  fallbackName: string,
  body: (event: HookEvent, eventName: string) => Promise<string | null> | string | null,
): Promise<void> {
  try {
    rememberPluginRoot();
    const event = await readEvent();
    const eventName = eventNameOf(event, fallbackName);
    traceRun(eventName, sessionIdOf(event));
    const context = await body(event, eventName);
    if (context && context.trim()) emitContext(eventName, context);
  } catch (error) {
    log(`hook error: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 0;
}
