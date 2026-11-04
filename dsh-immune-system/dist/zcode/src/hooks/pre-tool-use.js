/**
 * PreToolUse — the just-in-time warning.
 *
 * This is the point where the plugin actually knows what is about to happen:
 * the concrete tool plus its arguments. Matching here catches the mistake at
 * the moment it is made, which prompt-time matching cannot do.
 *
 * Kept deliberately cheap because it runs before every matched tool call: one
 * indexed query, at most two rules, a short block.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { runHook, sessionIdOf } from '../hook-io.js';
import { formatToolWarning } from '../format.js';
await runHook('PreToolUse', (event) => {
    let input;
    try {
        input = JSON.stringify(event.tool_input ?? {});
    }
    catch {
        input = '';
    }
    // Only the arguments are searched: including the tool name would make every
    // "Bash …" antibody match every Bash call. The tool name is still used later,
    // for the relevance-guarded penalty.
    const query = input;
    if (input.length < 3)
        return null;
    const store = new ImmuneStore();
    try {
        // Recording the session id means these rules become candidates for the
        // anti-rot penalty if the call still fails.
        const hits = store.match(query, { limit: 2, sessionId: sessionIdOf(event) });
        return formatToolWarning(hits);
    }
    finally {
        store.close();
    }
});
