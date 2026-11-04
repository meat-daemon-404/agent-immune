/**
 * DSH adapter — the ONLY file that needs to change when the real DSH contract
 * is confirmed.
 *
 * Everything the immune system needs from a host is collected here so the rest
 * of the plugin (and all of `core/`) stays host-agnostic.
 *
 * ============================================================================
 * STATUS: UNVERIFIED
 * The DSH runtime was NOT available on the machine this was written on. The
 * names and shapes below come from the original design sketch (Cordis / Koishi
 * style: `ctx.on`, `ctx.command`, `ctx.logger`) and have NOT been checked
 * against a real DSH build. Treat every item marked TODO(DSH) as a guess.
 * ============================================================================
 *
 * Contract to verify, in priority order:
 *  1. Event names. Sketch used 'dsh/before-llm-request' and 'dsh/after-tool-call'.
 *     Confirm the real names, and whether a failure is a flag on the tool event
 *     or a separate event. (ZCode, for reference, splits success and failure into
 *     PostToolUse / PostToolUseFailure and has no is_error field.)
 *  2. Tool event payload. Need: session id, tool name, tool input, and on failure
 *     the error text. Confirm the property names and nesting.
 *  3. Context injection. Sketch used `session.appendSystemReminder(text)`. Confirm
 *     the real method and whether it is synchronous (ZCode discards background
 *     hook output, which forces injection to be synchronous there too).
 *  4. Model access. Sketch used `ctx.llm.complete(prompt, opts)`. Confirm shape,
 *     or configure IMMUNE_LLM_* and use the built-in HTTP client instead
 *     (see core/llm.ts) — that path needs no host LLM at all.
 *  5. Command registration. Sketch used `ctx.command(name, desc).action(fn)`.
 *     Confirm, and confirm how command output is returned to the user.
 */

/** Everything the adapter needs from DSH. Implement against the real host. */
export interface DshHost {
  /** Subscribe to a host event. */
  on(event: string, handler: (payload: unknown) => unknown): void;
  /** Register a slash command with a handler that returns text. */
  command(name: string, description: string, handler: (args: string) => Promise<string>): void;
  /** Optional host logger; falls back to console when absent. */
  logger?: { info(message: string): void; warn(message: string): void };
}

/** Message/session surface the plugin is allowed to touch. */
export interface DshSession {
  /** Append advisory text that reaches the model on its next request. */
  appendSystemReminder(text: string): void;
  /** Most recent user message, when the host exposes it. */
  lastUserMessage?: string;
}

/** Event names the adapter subscribes to. ALL UNVERIFIED — see header. */
export const DSH_EVENTS = {
  sessionStart: 'dsh/session-start',
  beforeRequest: 'dsh/before-llm-request',
  afterToolCall: 'dsh/after-tool-call',
} as const;

/** Normalised tool outcome, so call sites never read raw host fields. */
export interface NormalisedToolEvent {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  ok: boolean;
  errorText: string;
  /** Present on success; used to capture the fix. */
  resultText: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Convert a raw host tool payload into the normalised shape.
 *
 * Deliberately permissive: it reads several plausible field spellings so that a
 * partially-correct contract still works. Tighten this once the real payload is
 * known — permissiveness here is a temporary cost, not a design goal.
 */
export function normaliseToolEvent(payload: unknown): NormalisedToolEvent {
  const raw = asRecord(payload);
  const tool = asRecord(raw.tool);

  const sessionId =
    asString(raw.sessionId) ?? asString(raw.session_id) ?? asString(raw.id) ?? 'unknown-session';
  const toolName =
    asString(raw.toolName) ?? asString(raw.tool_name) ?? asString(tool.name) ?? 'unknown-tool';
  const toolInput = raw.toolInput ?? raw.tool_input ?? tool.input ?? {};

  // TODO(DSH): confirm how a failure is signalled. The sketch implied a boolean
  // `isError`; a real host may use a separate event or an error object instead.
  const errorText =
    asString(raw.error) ??
    asString(asRecord(raw.error).message) ??
    asString(raw.error_details) ??
    '';
  const ok = raw.isError === true || raw.is_error === true ? false : errorText === '';

  const resultText =
    asString(raw.result) ?? asString(raw.toolResponse) ?? asString(raw.tool_response) ?? '';

  return { sessionId, toolName, toolInput, ok, errorText, resultText };
}

/** Log through the host logger when present. */
export function makeLogger(host: DshHost) {
  return {
    info: (message: string) => (host.logger ? host.logger.info(message) : console.error(message)),
    warn: (message: string) => (host.logger ? host.logger.warn(message) : console.error(message)),
  };
}
