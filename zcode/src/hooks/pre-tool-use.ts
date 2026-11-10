/**
 * PreToolUse — just-in-time warning, plus an optional deterministic guard.
 *
 * This is the point where the plugin actually knows what is about to happen:
 * the concrete tool plus its arguments. Matching here catches the mistake at
 * the moment it is made, which prompt-time matching cannot do.
 *
 * Layers, in order:
 *   1. Probe-thrash advisory (existing): a third consecutive read-only probe
 *      gets one nudge toward a precise command.
 *   2. Guard (`IMMUNE_GUARD`): a short curated list of calls that are wrong in
 *      essentially every environment. Off by default; `warn` escalates the
 *      advisory, `deny` refuses the call.
 *   3. Stuck hypothesis (ROADMAP 1.5): a target that failed twice in a row
 *      with NO covering rule gets one structured diagnostic prompt before the
 *      third attempt. The library already answering recalls this off — the
 *      point is the blind spot, not noise on covered ground.
 *   4. Antibody recall: the project's learned rules, at most two.
 *
 * Kept cheap because it runs before every matched tool call: one indexed query
 * plus at most three regex tests over a clamped string.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { stuckHypothesisText } from '../../../core/store/stuck.js';
import { findGuardHit, guardMode } from '../../../core/guards.js';
import { redact } from '../../../core/redact.js';
import { targetSignature } from '../../../core/pairing.js';
import { emitDeny, runHook, sessionIdOf, toolNameOf } from '../hook-io.js';
import { formatToolWarning } from '../format.js';

await runHook('PreToolUse', (event) => {
  let input: string;
  try {
    input = JSON.stringify(event.tool_input ?? {});
  } catch {
    input = '';
  }
  if (input.length < 3) return null;
  const sessionId = sessionIdOf(event);
  const toolName = toolNameOf(event);
  const signature = targetSignature(toolName, event.tool_input);

  const store = new ImmuneStore();
  try {
    // ------------------------------------------------- probe-thrash advisory
    // The third consecutive same-target read-only probe gets one nudge: a
    // precise command beats a fourth broad cat. Fires exactly once per streak
    // (count === 2 before this call), resets on any non-probe call.
    let thrash: string | null = null;
    if (signature.probeOnly) {
      if (store.probeStreakCount(sessionId, signature.signature) === 2) {
        thrash =
          '同一目标已连续探测两次，这是第 3 次：换一条精确命令（grep -n 关键词、单次 Read）通常一步到位。' +
          ' / Third consecutive probe of the same target — one precise command usually lands it.';
      }
    }

    // ------------------------------------------------------------- antibodies
    // One recall per hook run: the guard branch, the stuck hypothesis and the
    // final block all consume this single result.
    const recallRows = store.match(input, { limit: 2, sessionId, toolName });
    const recall = formatToolWarning(recallRows);

    // -------------------------------------------------- stuck hypothesis
    // ROADMAP 1.5: the streak is already >= 2 (post-failure counted it), the
    // call is not a probe, and recall found NOTHING — otherwise the library is
    // already on the case and a hypothesis is noise. Fires exactly once per
    // streak (hypothesized_at guards it), before the third attempt.
    let stuck: string | null = null;
    if (
      !signature.probeOnly &&
      recallRows.length === 0 &&
      store.stuckStreak(sessionId, signature.signature) >= 2 &&
      !store.wasHypothesized(sessionId, signature.signature)
    ) {
      stuck = stuckHypothesisText(signature.signature);
      store.markHypothesized(sessionId, signature.signature);
    }

    // ---------------------------------------------------------------- guards
    const mode = guardMode();
    if (mode !== 'off') {
      const inspected = redact(input).slice(0, 2000);
      const hit = findGuardHit(inspected);
      if (hit) {
        const banner =
          `<immune_guard>\n[${hit.rule.id}] ${hit.rule.what}\n` +
          `请改用：${hit.rule.instead}\n</immune_guard>`;
        if (mode === 'deny') {
          emitDeny('PreToolUse', banner);
          return null;
        }
        // warn: still advisory, but placed ahead of the usual recall block.
        return [thrash, banner, stuck, recall].filter(Boolean).join('\n\n');
      }
    }

    return [thrash, stuck, recall].filter(Boolean).join('\n\n');
  } finally {
    store.close();
  }
});
