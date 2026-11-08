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
import { isSelfEpisode } from '../../../core/selfnoise.js';
import { targetSignature } from '../../../core/pairing.js';
import { runHook, sessionIdOf, toolNameOf } from '../hook-io.js';
import { summarizeToolCall } from '../format.js';
import { classifyOutcome } from '../outcome.js';
import { selfMarkers } from '../root-marker.js';
import { REPAIR_TOOLS } from '../../../core/repair-tools.js';

await runHook('PostToolUse', (event) => {
  const record = event as Record<string, unknown>;
  const sessionId = sessionIdOf(event);
  const toolName = toolNameOf(event);
  const outcome = classifyOutcome(record);
  const trace = `${summarizeToolCall(toolName, event.tool_input)} result=${outcome.text}`;
  const target = targetSignature(toolName, event.tool_input);

  const store = new ImmuneStore();
  try {
    // Action diff (EMG-style): when OTHER tools have open episodes, a write to
    // a file is very often the actual repair. Record it so the distiller sees
    // what fixed the problem, not just that the retry succeeded. A tool with
    // its own open episode does not record itself as its own repair.
    if (
      REPAIR_TOOLS.has(toolName) &&
      store.hasPendingFailure(sessionId) &&
      !store.hasPendingFailure(sessionId, toolName)
    ) {
      const filePath =
        (event.tool_input as Record<string, unknown> | undefined)?.file_path ??
        (event.tool_input as Record<string, unknown> | undefined)?.path ??
        '';
      const base =
        typeof filePath === 'string' && filePath.length > 0
          ? filePath.split(/[\\/]/).pop() ?? filePath
          : toolName;
      store.recordRepairAction(sessionId, `${toolName} ${base}`);
    }

    // Probe-thrash bookkeeping: a completed probe extends its streak, any
    // other call resets all streaks for the session.
    store.recordProbeOutcome(sessionId, target.probeOnly ? target.signature : null);

    if (outcome.failed) {
      const snapshot = store.recordFailure(sessionId, toolName, trace, target.signature);
      // Anti-rot retires rules that failed to prevent this; retirement itself
      // is the handling. A failure-only episode has no repair evidence, so
      // re-distilling it only produced literal "previous rule (retired after
      // N failures)" prescriptions (production data). A genuine recurrence
      // forms a new rule through the normal failure -> success loop.
      store.penalize(snapshot.injected_ids, {
        failureText: snapshot.trace,
        toolName,
        sessionId,
      });
      return null;
    }

    const failure = store.claimFailure(sessionId, toolName, target);
    if (failure && !isSelfEpisode(failure.trace, selfMarkers())) {
      // Hand the distiller the action diff with the success trace: keyword
      // extraction picks the repaired files out of it, and the LLM prompt gets
      // the repair shape as context.
      const successTrace =
        failure.repair_path.length > 0
          ? `${trace}\nrepair actions: ${failure.repair_path.join(' | ')}`
          : trace;
      store.enqueueJob(
        toolName,
        failure.trace,
        successTrace,
        failure.injected_ids,
        failure.human_hint,
        failure.repair_path,
      );
    }
  } finally {
    store.close();
  }

  return null;
});
