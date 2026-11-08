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
import { targetSignature } from '../../../core/pairing.js';
import { runHook, sessionIdOf, toolNameOf } from '../hook-io.js';
import { summarizeFailure } from '../format.js';

await runHook('PostToolUseFailure', (event) => {
  const sessionId = sessionIdOf(event);
  const toolName = toolNameOf(event);
  const target = targetSignature(toolName, event.tool_input);

  const store = new ImmuneStore();
  try {
    const snapshot = store.recordFailure(
      sessionId,
      toolName,
      summarizeFailure(event),
      target.signature,
    );

    // Anti-rot: antibodies injected this turn that did not prevent the failure
    // lose credit, and are retired once they keep failing. The penalty is
    // relevance-guarded so an unrelated failure cannot retire a good rule.
    store.penalize(snapshot.injected_ids, {
      failureText: snapshot.trace,
      toolName,
    });

    // Retirement is the handling (AGENTS.md #24). A failure-only episode has no
    // repair evidence, and enqueueing the retired rule as the "success" trace
    // made the deterministic path turn the meta sentence into a prescription —
    // production rule #58 was that junk, nested twice and injected 21 times.
    // A genuine recurrence forms a new rule through failure -> success.
  } finally {
    store.close();
  }

  return null;
});
