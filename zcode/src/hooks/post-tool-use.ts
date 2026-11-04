/**
 * PostToolUse — the outcome sensor.
 *
 * This hook handles BOTH outcomes rather than trusting `PostToolUseFailure` to
 * arrive: that event only fires when a tool handler throws, and a shell command
 * exiting non-zero normally returns instead. By classifying here, the loop works
 * regardless of how the runtime reports the failure.
 *
 *  - failed  -> remember the episode and dock credit from antibodies that did
 *               not prevent it;
 *  - success -> if this tool failed earlier in the session, queue the pair for
 *               distillation.
 *
 * Emits nothing: context added here would be attached to the tool result.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { runHook, sessionIdOf, toolNameOf } from '../hook-io.js';
import { summarizeToolCall } from '../format.js';
import { classifyOutcome } from '../outcome.js';

await runHook('PostToolUse', (event) => {
  const record = event as Record<string, unknown>;
  const sessionId = sessionIdOf(event);
  const toolName = toolNameOf(event);
  const outcome = classifyOutcome(record);
  const trace = `${summarizeToolCall(toolName, event.tool_input)} result=${outcome.text}`;

  const store = new ImmuneStore();
  try {
    if (outcome.failed) {
      const snapshot = store.recordFailure(sessionId, toolName, trace);
      const retired = store.penalize(snapshot.injected_ids, {
        failureText: snapshot.trace,
        toolName,
      });
      // A retired rule is re-distilled with the new evidence, so a stale
      // antibody is replaced rather than merely deleted.
      for (const antibody of retired) {
        store.enqueueJob(
          toolName,
          `retired antibody #${antibody.id} (${antibody.trigger_pattern}): ${antibody.prescription}`,
          snapshot.trace,
          [],
        );
      }
      return null;
    }

    const failure = store.claimFailure(sessionId, toolName);
    if (failure) store.enqueueJob(toolName, failure.trace, trace, failure.injected_ids);
  } finally {
    store.close();
  }

  return null;
});
