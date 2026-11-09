/**
 * DSH adapter — the only file that binds the immune system to DeepSeek Harness.
 *
 * ============================================================================
 * STATUS: VERIFIED against the real DSH checkout
 *   D:\deepseek harness\deepseek-harness\
 * (the `@deepseek-ai/dsh-*` entries under the DSH profile's `node_modules` are
 * symlinks into that tree). Every name and shape below was read out of source;
 * the previously speculative `??` fallbacks are gone on purpose — when a field
 * name is wrong we want a loud failure, not a silent `'unknown-tool'`.
 * ============================================================================
 *
 * The three questions this file used to guess at, answered:
 *
 *  1. EVENT NAMES. There is no `dsh/`-prefixed event family; a repo-wide grep
 *     for `'dsh/[a-z-]+'` matches nothing. The real names are `agent/session-start`,
 *     `agent/pre-step` and `tools/post-execute` (see `DSH_EVENTS` below for the
 *     file:line each was read from).
 *
 *  2. HOW FAILURE IS REPORTED. A single event with a discriminated result, not a
 *     split success/failure pair — but a bare `result.isError` is NOT enough:
 *     `packages\shell\tool-bash\src\render.ts:17-21` says outright that
 *     "Non-zero exits are reported, not errored … only infrastructure failures
 *     (spawn errors, aborts) surface as isError results". A `bash` call that
 *     exits 1 therefore arrives as `isError: false` with the truth buried in the
 *     last line of the rendered text (`[exit code: 1]`) and in the structured
 *     `value.exitCode`. `judgeOutcome()` below reads all three signals.
 *
 *  3. HOW TEXT REACHES THE MODEL. `agent.inject(message)` is the channel the
 *     `agent/session-start` docs point at, and it is synchronous (`void`) — it
 *     queues onto the `next-step` inbox without waking the driver. That alone
 *     can miss the turn already being assembled, so the plugin also rides the
 *     `agent/pre-step` waterfall and splices the block into the decision. There
 *     is no `session.appendSystemReminder` in DSH; that method was invented.
 *
 * Deliberately no runtime import from `@deepseek-ai/*`: the shapes this plugin
 * actually touches are re-declared here as structural types, which keeps the
 * built plugin loadable from any `node_modules` layout. Each type carries the
 * upstream path it mirrors so drift is easy to spot.
 */
import { randomUUID } from 'node:crypto';

/** The plugin label stamped on injected messages and used as the Cordis id. */
export const PLUGIN_NAME = 'dsh-immune-system';

/**
 * Event names the adapter subscribes to.
 *
 * - `sessionStart`    — `packages\core\agent\src\runtime-types.ts:217` (`@mode emit`)
 * - `preStep`         — `packages\core\agent\src\runtime-types.ts:231` (`@mode waterfall`)
 * - `preToolExecute`  — `packages\core\tools\src\index.ts:152` (`@mode waterfall`)
 * - `postToolExecute` — `packages\core\tools\src\index.ts:175` (`@mode waterfall`)
 * - `turnStopping`    — `packages\core\agent\src\runtime-types.ts:278` (`@mode serial`)
 */
export const DSH_EVENTS = {
  sessionStart: 'agent/session-start',
  preStep: 'agent/pre-step',
  preToolExecute: 'tools/pre-execute',
  postToolExecute: 'tools/post-execute',
  turnStopping: 'agent/turn-stopping',
} as const;

/** A text block. Mirrors `TextBlock` at `packages\llm\llm\src\types.ts:53-56`. */
export interface DshContentBlock {
  readonly type: string;
  readonly text?: string;
}

/**
 * A message the plugin injects. Mirrors `createUserMessage(...)` output —
 * `packages\llm\llm\src\message.ts:192-199` — including the `kind:'plugin'`
 * source that keeps the text from rendering as a human prompt in derived
 * history (`MessageSourceMap` at `packages\llm\llm\src\message.ts:100-105`).
 */
export interface DshUserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: ReadonlyArray<DshContentBlock>;
  readonly source: { readonly kind: 'plugin'; readonly plugin: string };
}

/** The agent handle. Mirrors `Agent` at `packages\core\agent\src\runtime-types.ts:66-143`. */
export interface DshAgent {
  /** `Agent.id` is typed `SessionId` — `runtime-types.ts:66`. */
  readonly id: string;
  readonly session: { readonly header: { readonly id: string } };
  /** `runtime-types.ts:143`. Synchronous; queues onto the `next-step` inbox. */
  inject(message: DshUserMessage): void;
}

/** Tool failure detail. Mirrors `ToolFailure` at `packages\core\tools\src\index.ts:481`. */
export interface DshToolFailure {
  readonly message: string;
  readonly info?: { readonly name: string; readonly code: string };
}

/**
 * The execution handle handed to a tool listener. Mirrors `ToolExecutionInput`
 * plus `token` at `packages\core\tools\src\index.ts:191-205`.
 */
export interface DshToolExecution {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: DshAgent;
  readonly signal: { readonly aborted: boolean };
}

/**
 * The normalized dispatch result. Mirrors `ToolExecutionSuccess` /
 * `ToolExecutionFailure` / `ToolExecutionResult` at
 * `packages\core\tools\src\index.ts:556-580`.
 */
export type DshToolResult =
  | {
      readonly isError: false;
      readonly value: unknown;
      readonly content: ReadonlyArray<DshContentBlock>;
    }
  | {
      readonly isError: true;
      readonly error: DshToolFailure;
      readonly content: ReadonlyArray<DshContentBlock>;
    };

/** `PreStepDecision` at `packages\core\agent\src\runtime-types.ts:53-55`. */
export type DshPreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: DshUserMessage[] };

/** `PreToolDecision` at `packages\core\tools\src\index.ts:588-591`. */
export type DshPreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string };

/** `PostToolDecision` at `packages\core\tools\src\index.ts:188-193`. */
export type DshPostToolDecision =
  | { readonly kind: 'accept'; readonly content?: ReadonlyArray<DshContentBlock> }
  | { readonly kind: 'block'; readonly feedback: ReadonlyArray<DshContentBlock> };

/** Payload of `agent/pre-step` — `packages\core\agent\src\runtime-types.ts:231`. */
export interface DshPreStepPayload {
  readonly agent: DshAgent;
  readonly messages: DshUserMessage[];
  readonly turn: number;
  readonly step: number;
  readonly signal: { readonly aborted: boolean };
}

/** Payload of `agent/session-start` — `packages\core\agent\src\runtime-types.ts:217`. */
export interface DshSessionStartPayload {
  readonly agent: DshAgent;
  readonly source: 'startup' | 'resume' | 'clear' | 'compact';
}

/**
 * Payload of `agent/turn-stopping` — `packages\core\agent\src\runtime-types.ts:278`
 * (`@mode serial`). Awaited before the turn boundary commits, so it is the last
 * place to do turn-end work without stalling a tool result mid-turn.
 */
export interface DshTurnStoppingPayload {
  readonly agent: DshAgent;
  readonly turn: number;
  readonly signal: { readonly aborted: boolean };
}

/**
 * A session handle as handed to a `session/event` listener —
 * `packages\core\session\src\index.ts:76` (`'session/event'(this, session, event)`).
 */
export interface DshSession {
  readonly header: { readonly id: string };
}

/**
 * One durable session event — `packages\core\session\src\types.ts:408-440`:
 * `{ type, seq, time, data }`. We only read `user/message` events, whose
 * `data` is the appended `UserMessage`.
 */
export interface DshSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

/** `CommandInvocation` at `packages\interaction\commands\src\index.ts:34-51`. */
export interface DshCommandInvocation {
  readonly commandId: string;
  readonly agent: DshAgent;
  /** The remaining command-line text — there is no separate `args` field. */
  readonly rawInput: string;
  readonly signal: { readonly aborted: boolean };
}

/** `CommandResult` at `packages\interaction\commands\src\types.ts:27-34`. */
export type DshCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string };

/** `CommandDefinition` at `packages\interaction\commands\src\index.ts:54-69`. */
export interface DshCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string; readonly images?: boolean };
  readonly handler: (
    invocation: DshCommandInvocation,
  ) => DshCommandResult | Promise<DshCommandResult>;
}

export interface DshLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * The slice of the Cordis `Context` this plugin touches.
 *
 * `logger`, `on` and `effect` are members of the Context itself; `commands` is a
 * service and therefore requires `export const inject = ['commands']` — an
 * un-injected service property throws `cannot get property "commands" without
 * inject` (`vendor\cordis\src\reflect.ts:144`).
 */
export interface DshContext {
  readonly logger: DshLogger;
  /** `vendor\cordis\src\events.ts:97`. */
  on(
    event: typeof DSH_EVENTS.sessionStart,
    listener: (payload: DshSessionStartPayload) => void,
  ): () => boolean;
  on(
    event: typeof DSH_EVENTS.preStep,
    listener: (
      payload: DshPreStepPayload,
      next: () => Promise<DshPreStepDecision>,
    ) => Promise<DshPreStepDecision>,
  ): () => boolean;
  /**
   * Before dispatch — `packages\core\tools\src\index.ts:152` (`@mode waterfall`).
   * `next()` allows; returning a decision replaces the outcome. Used only for
   * the opt-in guard: `PreToolDecision` has no context channel, so an advisory
   * (non-blocking) warning cannot be delivered from here.
   */
  on(
    event: typeof DSH_EVENTS.preToolExecute,
    listener: (
      exec: DshToolExecution,
      next: () => Promise<DshPreToolDecision>,
    ) => Promise<DshPreToolDecision>,
  ): () => boolean;
  on(
    event: typeof DSH_EVENTS.postToolExecute,
    listener: (
      exec: DshToolExecution,
      result: DshToolResult,
      next: () => Promise<DshPostToolDecision>,
    ) => Promise<DshPostToolDecision>,
  ): () => boolean;
  /**
   * Turn end — `packages\core\agent\src\runtime-types.ts:278` (`@mode serial`).
   * Awaited before the boundary commits; returning a promise therefore delays
   * turn close (but never stalls a tool result mid-turn).
   */
  on(
    event: typeof DSH_EVENTS.turnStopping,
    listener: (payload: DshTurnStoppingPayload) => void | Promise<void>,
  ): () => boolean;
  /**
   * Durable session events — `packages\core\session\src\index.ts:76`. Used to
   * remember the latest human prompt so a cold `resume`/`compact` start (whose
   * `agent/pre-step` batch carries no human message) can still recall.
   */
  on(
    event: 'session/event',
    listener: (session: DshSession, event: DshSessionEvent) => void,
  ): () => boolean;
  /** `vendor\cordis\src\fiber.ts:415-418`. */
  effect(execute: () => () => void, label?: string): unknown;
  readonly commands: {
    /** `packages\interaction\commands\src\index.ts:270-277`. */
    register(definition: DshCommandDefinition): () => void;
  };
  /**
   * Service lookup without an `inject` edge (cordis `ctx.get`, as used by
   * `packages\context\agent-instructions\src\index.ts:116` for `fs`). Read-only
   * here: it reports whether the host composed the web client row, so a missing
   * settings tab can be diagnosed from `/immune` instead of guessed at.
   */
  get?(name: string): unknown;
  /**
   * Optional dependency activation (`ctx.inject(deps, cb)`), the same shape
   * `dsh/src/ui-route.ts` relies on. Used only to wait until `clientModules`
   * exists before reporting the web-tab state; a host without it is fine.
   */
  inject?(deps: string[], callback: (ctx: unknown) => void): unknown;
}

/** Normalised tool outcome, so call sites never read raw host fields. */
export interface NormalisedToolEvent {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  ok: boolean;
  errorText: string;
  /** The model-facing result text; used to capture the fix on the success leg. */
  resultText: string;
  /**
   * The call was refused by the sandbox's file-access policy, not by the tool.
   * A permission negotiation is environmental, so it is reported but never
   * learned from: distilling it can only restate the same command.
   */
  sandboxDenied: boolean;
}

/**
 * The `[killed by signal: X]` / `[exit code: N]` trailer contract, copied from
 * `packages\shell\shell\src\render.ts:17-38` (`parseExitStatus`).
 */
const KILLED_BY_SIGNAL = /\n\[killed by signal: ([^\]\n]+)\]$/;
const EXIT_CODE = /\n\[exit code: (\d+)\]$/;
const TIMED_OUT = /\n\[timed out after \d+ms\]/;
const SANDBOX_DENIED = /\[sandbox: file access denied under [^\]\n]+ mode\]/;

/**
 * Signals that a *reported* (non-`isError`) result is still a failure.
 *
 * Lifted from the ZCode side (`zcode\src\outcome.ts`) where it compensated for
 * the same missing signal. The shell markers above are handled structurally;
 * this covers everything a tool prints without a structured status.
 */
const FAILURE_MARKERS =
  /ENOENT|EACCES|EPERM|ECONNREFUSED|command not found|is not recognized as an internal|Traceback \(most recent call last\)|npm ERR!|\bfatal:\s|^Error:|Cannot find module/im;

/** Concatenate the text blocks of a content array. */
export function textOf(content: ReadonlyArray<DshContentBlock>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Pull the structured exit code a shell tool puts in its JSON value — see
 * `canonicalBashResult` at `packages\shell\tool-bash\src\index.ts:159-182`
 * (`exitCode: result.exitCode`). Returns `undefined` for tools that have none.
 */
function exitCodeOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const exitCode = (value as { exitCode?: unknown }).exitCode;
  return typeof exitCode === 'number' ? exitCode : undefined;
}

/**
 * `timedOut: true` from `canonicalBashResult` (`packages\shell\tool-bash\src\index.ts:159-182`).
 * A timeout can still carry `exitCode: 0`, so it must be judged from the flag as
 * well as the rendered marker.
 */
function timedOutOf(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { timedOut?: unknown }).timedOut === true;
}

/** True when the tool returned a structured, non-empty `value` payload. */
function hasStructuredPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

/**
 * Decide success vs failure from the signals DSH actually provides.
 *
 * Authority order, highest first:
 *  1. `isError` — the host already classified it (but a thrown file tool can
 *     still carry the sandbox marker in its message, so it is checked too);
 *  2. a sandbox file-access denial — reported, but flagged so it is not learned;
 *  3. a kill signal / timeout — a status marker that can co-exist with exit 0;
 *  4. the structured `value.exitCode` — **authoritative for shell tools**;
 *  5. a structured `value` payload with no exit status — the tool encoded its
 *     own outcome, so its text is data and is not scanned;
 *  6. the rendered `[exit code: N]` trailer;
 *  7. `FAILURE_MARKERS` text — only for results that carry *no* structured
 *     status, since a successful command may legitimately print `Error:` or
 *     `command not found` in its own output (grep, test runners, docs).
 */
export function judgeOutcome(
  result: DshToolResult,
  resultText: string,
): { ok: boolean; errorText: string; sandboxDenied: boolean } {
  if (result.isError) {
    const message = result.error.message;
    // A file tool that throws on a denied path surfaces the same marker as a
    // shell tool that reports it; neither is a project pitfall.
    if (SANDBOX_DENIED.test(message)) {
      const mode = /\[sandbox: file access denied under ([^\]\n]+) mode\]/.exec(message);
      return { ok: false, errorText: `sandbox denied (${mode?.[1] ?? 'unknown'} mode)`, sandboxDenied: true };
    }
    return { ok: false, errorText: message, sandboxDenied: false };
  }

  if (SANDBOX_DENIED.test(resultText)) {
    const marker = /\[sandbox: file access denied under ([^\]\n]+) mode\]/.exec(resultText);
    return {
      ok: false,
      errorText: `sandbox denied (${marker?.[1] ?? 'unknown'} mode)`,
      sandboxDenied: true,
    };
  }

  const killed = KILLED_BY_SIGNAL.exec(resultText);
  if (killed?.[1] !== undefined) {
    return { ok: false, errorText: `killed by signal ${killed[1]}`, sandboxDenied: false };
  }
  if (TIMED_OUT.test(resultText) || timedOutOf(result.value)) {
    return { ok: false, errorText: 'timed out', sandboxDenied: false };
  }

  const exitCode = exitCodeOf(result.value);
  if (exitCode !== undefined) {
    return exitCode === 0
      ? { ok: true, errorText: '', sandboxDenied: false }
      : { ok: false, errorText: `exit code ${exitCode}`, sandboxDenied: false };
  }

  // A tool that returned a non-empty structured payload but no usable exit
  // status has already encoded its own outcome — the payload IS the verdict.
  // Its text is data (a file's contents, grep matches, a tool's JSON result),
  // so scanning it for `Error:` / `[exit code: 1]` would turn a successful
  // `read` of a log file into a recorded failure. Text heuristics are only for
  // tools that returned nothing structured at all.
  if (hasStructuredPayload(result.value)) {
    return { ok: true, errorText: '', sandboxDenied: false };
  }

  if (EXIT_CODE.test(resultText)) {
    const code = EXIT_CODE.exec(resultText);
    return { ok: false, errorText: `exit code ${code?.[1] ?? '?'}`, sandboxDenied: false };
  }
  if (FAILURE_MARKERS.test(resultText)) {
    return { ok: false, errorText: 'failure marker in tool output', sandboxDenied: false };
  }

  return { ok: true, errorText: '', sandboxDenied: false };
}

/**
 * Convert a real `(exec, result)` pair from `tools/post-execute` into the shape
 * `core/` consumes.
 *
 * Returns `undefined` for a call with no agent: a direct `ctx.tools.execute()`
 * invocation has no session to attribute the episode to (the same guard
 * `repeat-tool-reminder` uses at `packages\guard\repeat-tool-reminder\src\index.ts`).
 */
export function normaliseToolEvent(
  exec: DshToolExecution,
  result: DshToolResult,
): NormalisedToolEvent | undefined {
  const agent = exec.agent;
  if (agent === undefined) return undefined;

  const resultText = textOf(result.content);
  const { ok, errorText, sandboxDenied } = judgeOutcome(result, resultText);

  return {
    sessionId: agent.id,
    toolName: exec.name,
    toolInput: exec.arguments,
    ok,
    errorText,
    resultText,
    sandboxDenied,
  };
}

/**
 * Build the message `agent.inject()` takes.
 *
 * Mirrors what `createUserMessage` produces (`packages\llm\llm\src\message.ts:192-199`)
 * without importing `@deepseek-ai/dsh-llm`, so the plugin resolves from any
 * `node_modules` layout.
 */
export function createPluginMessage(text: string): DshUserMessage {
  const content: DshContentBlock[] = [];
  content.push({ type: 'text', text });
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'plugin' as const, plugin: PLUGIN_NAME }),
  });
}

/** Log through the host logger. */
export function makeLogger(ctx: DshContext) {
  return {
    info: (message: string) => {
      ctx.logger.info(message);
    },
    warn: (message: string) => {
      ctx.logger.warn(message);
    },
  };
}
