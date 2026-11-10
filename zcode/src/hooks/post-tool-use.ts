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
import { normaliseTargetPath, targetSignature } from '../../../core/pairing.js';
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
      // ROADMAP 1.3: the chain entry carries the project-relative path when the
      // host provides cwd (two configs named pytest.ini in different directories
      // stay distinguishable); the basename remains the fallback.
      const cwd = typeof record.cwd === 'string' ? record.cwd : undefined;
      const relative =
        typeof filePath === 'string' && filePath.length > 0
          ? normaliseTargetPath(filePath, cwd)
          : '';
      store.recordRepairAction(sessionId, `${toolName} ${relative || base}`);
    }

    // Probe-thrash bookkeeping: a completed probe extends its streak, any
    // other call resets all streaks for the session.
    // ROADMAP 2.3b: a >= 4 same-target probe streak meeting a SUCCESSFUL
    // non-probe is a convergent detour — one telemetry row, never a rule (the
    // deterministic shortcut would be an echo, AGENTS.md #28; `immune rewrite`
    // is the minting path).
    if (!target.probeOnly && !outcome.failed) {
      const detourStreak = store.topProbeStreak(sessionId, store.detourMinProbes);
      if (detourStreak) store.recordDetour(sessionId, detourStreak.signature, detourStreak.count);
    }
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
    // ROADMAP 1.5: any success ends the streak; when the hypothesis had fired,
    // the rule distilled from this closing success is marked as an
    // experiment. user_correction outranks it (the human taught the lesson).
    const hypothesized = store.wasHypothesized(sessionId, target.signature);
    store.clearStuck(sessionId, target.signature);
    if (failure && !isSelfEpisode(failure.trace, selfMarkers())) {
      // Hand the distiller the action diff with the success trace: keyword
      // extraction picks the repaired files out of it, and the LLM prompt gets
      // the repair shape as context.
      const successTrace =
        failure.repair_path.length > 0
          ? `${trace}\nrepair actions: ${failure.repair_path.join(' | ')}`
          : trace;
      // ROADMAP 1.4b: a non-empty human hint is what closed the episode — the
      // rule that emerges is a user correction, recorded as provenance.
      const origin = failure.human_hint.trim()
        ? 'user_correction'
        : hypothesized
          ? 'self_healing_experiment'
          : '';
      store.enqueueJob(
        toolName,
        failure.trace,
        successTrace,
        failure.injected_ids,
        failure.human_hint,
        failure.repair_path,
        origin,
      );
    }
  } finally {
    store.close();
  }

  return null;
});
