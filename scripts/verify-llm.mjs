/**
 * Live LLM-distillation verification (env-gated, machine-only).
 *
 * Closes the loop the mock tests cannot: a REAL chat-completions round-trip
 * through readLlmConfig/chat/distillEpisode. Skips with instructions when the
 * env is absent, so CI never runs it.
 *
 * Usage:
 *   IMMUNE_LLM_BASE_URL=https://opencode.ai/zen/v1 \
 *   IMMUNE_LLM_MODEL=space-bunny-free \
 *   IMMUNE_LLM_API_KEY=public \
 *   node scripts/verify-llm.mjs
 *
 * (A local proxy that reaches client-locked models works too — it is a private
 * endpoint, so add IMMUNE_ALLOW_PRIVATE_ENDPOINT=1.)
 */

import { readLlmConfig } from '../dsh-immune-system/dist/core/llm.js';
import { distillEpisode } from '../dsh-immune-system/dist/core/distiller.js';

const cfg = readLlmConfig();
if (!cfg) {
  console.log('SKIP — set IMMUNE_LLM_BASE_URL / IMMUNE_LLM_MODEL / IMMUNE_LLM_API_KEY to run.');
  process.exit(0);
}
console.log(`llm: ${cfg.model} @ ${cfg.endpoint} (timeout ${cfg.timeoutMs} ms)`);

// Leg 1: raw reachability, so a failure here is distinguishable from a
// parsing failure downstream. chat(cfg, system, user, signal).
const { chat } = await import('../dsh-immune-system/dist/core/llm.js');
const t0 = Date.now();
try {
  await chat(cfg, 'You are a health check.', 'Reply with exactly: ok', AbortSignal.timeout(cfg.timeoutMs));
  console.log(`ok   endpoint reachable (${Date.now() - t0} ms)`);
} catch (error) {
  console.log(
    `FAIL endpoint not reachable after ${Date.now() - t0} ms: ` +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
}

// Leg 2: the full distill path. The deterministic rule path's prescription for
// this pair is an echo of the success trace ("Bash: npm install ..."), so a
// non-echo prescription proves the model answered and was parsed.
const t1 = Date.now();
const result = await distillEpisode(
  'Bash',
  'npm ERR! ERESOLVE unable to resolve dependency tree: peer react@19 requires react-dom@19, found react-dom@18',
  'npm install --legacy-peer-deps -> added 312 packages in 14s',
  { llm: cfg, signal: AbortSignal.timeout(cfg.timeoutMs) },
);
const prescription = result.antibody?.prescription ?? '';
const viaLlm = result.ok && !prescription.startsWith('Bash: npm');
console.log(
  viaLlm
    ? `ok   distill via LLM (${Date.now() - t1} ms): "${prescription.slice(0, 80)}"`
    : `warn distill fell back to the rule path (${Date.now() - t1} ms): "${prescription.slice(0, 60)}"`,
);
process.exit(viaLlm ? 0 : 1);
