/**
 * PostToolUseFailure — the "I just stepped on a rake" sensor.
 *
 * Records the failed invocation so the next success on the same tool can be
 * paired with it, and penalises the antibodies that were in context but failed
 * to prevent this.
 *
 * Emits nothing: PostToolUse cannot block a tool that already ran, and adding
 * context here would attach it to the failing tool result.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { runHook, sessionIdOf, toolNameOf } from '../hook-io.js';
import { summarizeFailure } from '../format.js';
await runHook('PostToolUseFailure', (event) => {
    const sessionId = sessionIdOf(event);
    const toolName = toolNameOf(event);
    const store = new ImmuneStore();
    try {
        const snapshot = store.recordFailure(sessionId, toolName, summarizeFailure(event));
        // Anti-rot: antibodies injected this turn that did not prevent the failure
        // lose credit, and are retired once they keep failing. The penalty is
        // relevance-guarded so an unrelated failure cannot retire a good rule.
        const retired = store.penalize(snapshot.injected_ids, {
            failureText: snapshot.trace,
            toolName,
        });
        // A retired antibody is re-distilled together with the new evidence, so a
        // stale rule is replaced rather than merely deleted.
        for (const antibody of retired) {
            store.enqueueJob(toolName, `retired antibody #${antibody.id} (${antibody.trigger_pattern}): ${antibody.prescription}`, snapshot.trace, []);
        }
    }
    finally {
        store.close();
    }
    return null;
});
