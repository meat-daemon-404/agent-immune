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
};
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
const FAILURE_MARKERS = /ENOENT|EACCES|EPERM|ECONNREFUSED|command not found|is not recognized as an internal|Traceback \(most recent call last\)|npm ERR!|\bfatal:\s|^Error:|Cannot find module/im;
/** Concatenate the text blocks of a content array. */
export function textOf(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
    }
    return parts.join('\n');
}
/**
 * Pull the structured exit code a shell tool puts in its JSON value — see
 * `canonicalBashResult` at `packages\shell\tool-bash\src\index.ts:159-182`
 * (`exitCode: result.exitCode`). Returns `undefined` for tools that have none.
 */
function exitCodeOf(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const exitCode = value.exitCode;
    return typeof exitCode === 'number' ? exitCode : undefined;
}
/**
 * Decide success vs failure from the three signals DSH actually provides.
 *
 * The order matters: `isError` is authoritative when set, the structured exit
 * code beats any text heuristic, and only then do we scan the rendered text.
 */
function judgeOutcome(result, resultText) {
    if (result.isError) {
        return { ok: false, errorText: result.error.message };
    }
    const exitCode = exitCodeOf(result.value);
    if (exitCode !== undefined && exitCode !== 0) {
        return { ok: false, errorText: `exit code ${exitCode}` };
    }
    const killed = KILLED_BY_SIGNAL.exec(resultText);
    if (killed?.[1] !== undefined) {
        return { ok: false, errorText: `killed by signal ${killed[1]}` };
    }
    if (TIMED_OUT.test(resultText)) {
        return { ok: false, errorText: 'timed out' };
    }
    if (SANDBOX_DENIED.test(resultText)) {
        const marker = /\[sandbox: file access denied under ([^\]\n]+) mode\]/.exec(resultText);
        return { ok: false, errorText: `sandbox denied (${marker?.[1] ?? 'unknown'} mode)` };
    }
    if (EXIT_CODE.test(resultText)) {
        const code = EXIT_CODE.exec(resultText);
        return { ok: false, errorText: `exit code ${code?.[1] ?? '?'}` };
    }
    if (FAILURE_MARKERS.test(resultText)) {
        return { ok: false, errorText: 'failure marker in tool output' };
    }
    return { ok: true, errorText: '' };
}
/**
 * Convert a real `(exec, result)` pair from `tools/post-execute` into the shape
 * `core/` consumes.
 *
 * Returns `undefined` for a call with no agent: a direct `ctx.tools.execute()`
 * invocation has no session to attribute the episode to (the same guard
 * `repeat-tool-reminder` uses at `packages\guard\repeat-tool-reminder\src\index.ts`).
 */
export function normaliseToolEvent(exec, result) {
    const agent = exec.agent;
    if (agent === undefined)
        return undefined;
    const resultText = textOf(result.content);
    const { ok, errorText } = judgeOutcome(result, resultText);
    return {
        sessionId: agent.id,
        toolName: exec.name,
        toolInput: exec.arguments,
        ok,
        errorText,
        resultText,
    };
}
/**
 * Build the message `agent.inject()` takes.
 *
 * Mirrors what `createUserMessage` produces (`packages\llm\llm\src\message.ts:192-199`)
 * without importing `@deepseek-ai/dsh-llm`, so the plugin resolves from any
 * `node_modules` layout.
 */
export function createPluginMessage(text) {
    const content = [];
    content.push({ type: 'text', text });
    return Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze(content),
        source: Object.freeze({ kind: 'plugin', plugin: PLUGIN_NAME }),
    });
}
/** Log through the host logger. */
export function makeLogger(ctx) {
    return {
        info: (message) => {
            ctx.logger.info(message);
        },
        warn: (message) => {
            ctx.logger.warn(message);
        },
    };
}
