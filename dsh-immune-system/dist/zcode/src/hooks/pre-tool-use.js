/**
 * PreToolUse — just-in-time warning, plus an optional deterministic guard.
 *
 * This is the point where the plugin actually knows what is about to happen:
 * the concrete tool plus its arguments. Matching here catches the mistake at
 * the moment it is made, which prompt-time matching cannot do.
 *
 * Two layers, in order:
 *   1. Guard (`IMMUNE_GUARD`): a short curated list of calls that are wrong in
 *      essentially every environment. Off by default; `warn` escalates the
 *      advisory, `deny` refuses the call.
 *   2. Antibody recall: the project's learned rules, at most two.
 *
 * Kept cheap because it runs before every matched tool call: one indexed query
 * plus at most three regex tests over a clamped string.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { findGuardHit, guardMode } from '../../../core/guards.js';
import { redact } from '../../../core/redact.js';
import { targetSignature } from '../../../core/pairing.js';
import { emitDeny, runHook, sessionIdOf, toolNameOf } from '../hook-io.js';
import { formatToolWarning } from '../format.js';
await runHook('PreToolUse', (event) => {
    let input;
    try {
        input = JSON.stringify(event.tool_input ?? {});
    }
    catch {
        input = '';
    }
    if (input.length < 3)
        return null;
    const sessionId = sessionIdOf(event);
    // ------------------------------------------------- probe-thrash advisory
    // The third consecutive same-target read-only probe gets one nudge: a
    // precise command beats a fourth broad cat. Fires exactly once per streak
    // (count === 2 before this call), resets on any non-probe call.
    const signature = targetSignature(toolNameOf(event), event.tool_input);
    let thrash = null;
    if (signature.probeOnly) {
        const probeStore = new ImmuneStore();
        try {
            if (probeStore.probeStreakCount(sessionId, signature.signature) === 2) {
                thrash =
                    '同一目标已连续探测两次，这是第 3 次：换一条精确命令（grep -n 关键词、单次 Read）通常一步到位。' +
                        ' / Third consecutive probe of the same target — one precise command usually lands it.';
            }
        }
        finally {
            probeStore.close();
        }
    }
    // ---------------------------------------------------------------- guards
    const mode = guardMode();
    if (mode !== 'off') {
        const inspected = redact(input).slice(0, 2000);
        const hit = findGuardHit(inspected);
        if (hit) {
            const banner = `<immune_guard>\n[${hit.rule.id}] ${hit.rule.what}\n` +
                `请改用：${hit.rule.instead}\n</immune_guard>`;
            if (mode === 'deny') {
                emitDeny('PreToolUse', banner);
                return null;
            }
            // warn: still advisory, but placed ahead of the usual recall block.
            const recall = formatToolWarning(recallFor(input, sessionId));
            return [thrash, banner, recall].filter(Boolean).join('\n\n');
        }
    }
    // ------------------------------------------------------------- antibodies
    const recall = formatToolWarning(recallFor(input, sessionId));
    return [thrash, recall].filter(Boolean).join('\n\n');
});
/**
 * Recall for this specific call.
 *
 * Only the arguments are searched: including the tool name would make every
 * "Bash …" antibody match every Bash call. The tool name is still used later,
 * for the relevance-guarded penalty.
 */
function recallFor(input, sessionId) {
    const store = new ImmuneStore();
    try {
        return store.match(input, { limit: 2, sessionId });
    }
    finally {
        store.close();
    }
}
