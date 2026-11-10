/**
 * The ONE commit path for distilled episodes — both adapters (zcode/src/drain.ts,
 * dsh/src/index.ts) call this, so provenance (repair chain, origin, environment
 * fingerprint) and the post-injection mutation cannot drift between hosts.
 *
 * Extracted verbatim from the ZCode drain in 1.1.0; the DSH drain previously
 * lacked the origin stamp, the fingerprint and the mutation step entirely.
 */
import { matchGenericLesson } from './lessons.js';
import { isRelated } from './relevance.js';
import { LLM_FALLBACK_KEY, LLM_SUCCESS_KEY } from './store/index.js';
import type { ImmuneStore, DistillJob } from './store/index.js';
import type { DistillResult } from './types.js';

export interface ApplyDistillOptions {
  /** Workspace fingerprint stamped onto the project row (ROADMAP 3.1). */
  fingerprint?: string;
  /**
   * A model-path degradation observed by the CALLER (the ZCode budget path
   * skips the model up front and reports that here), folded into the same
   * fallback counter and job note as an in-flight degradation.
   */
  extraFallbackReason?: string;
}

/**
 * Persist one distillation result for its job. Returns true when the episode
 * learned (a rule was stored or merged).
 */
export function applyDistillResult(
  store: ImmuneStore,
  job: DistillJob,
  result: DistillResult,
  opts: ApplyDistillOptions = {},
): boolean {
  if (!result.ok) {
    store.finishJob(job.id, result.reason === 'skip' ? 'skipped' : 'failed', result.detail ?? '');
    return false;
  }
  // Which path produced the rule is runtime truth an operator cannot see
  // otherwise: a configured LLM that keeps degrading looks identical to no
  // LLM at all. The note carries the reason for `immune list --all` readers.
  if (result.source === 'llm') {
    store.bumpMeta(LLM_SUCCESS_KEY);
  } else if (result.degradedReason || opts.extraFallbackReason) {
    store.bumpMeta(LLM_FALLBACK_KEY);
    store.finishJobNote(job.id, `llm degraded: ${result.degradedReason ?? opts.extraFallbackReason}`);
  }
  // A generic lesson is published to the shared library so the next project
  // starts already knowing it. The action diff, the teaching origin and the
  // workspace fingerprint ride along as provenance.
  store.insertShared(
    {
      ...result.antibody,
      repair_path: job.repair_path ?? [],
      origin: job.origin ?? '',
      env_fingerprint: opts.fingerprint ?? '',
    },
    {
      generic: matchGenericLesson(result.antibody.symptom) !== null,
      humanHint: Boolean(job.human_hint),
    },
  );
  // ROADMAP 2.2: a rule that was in context and still failed gets refined once
  // the fix arrives with repair evidence. The distilled rule's trigger tokens
  // are the refinement source; the prescription is never rewritten here (#28).
  mutateInjectedRules(store, job, result);
  store.finishJob(job.id, 'done');
  return true;
}

/**
 * Post-injection mutation (ROADMAP 2.2). Only rules that were injected into
 * the failing turn AND related to the failure (the same bar anti-rot uses
 * before blaming a rule) mutate; the refinement source is the distilled
 * trigger, the prescription stays captured evidence.
 */
function mutateInjectedRules(
  store: ImmuneStore,
  job: DistillJob,
  result: DistillResult,
): void {
  if (!result.ok) return;
  let ids: number[] = [];
  try {
    const parsed: unknown = JSON.parse(job.injected_ids ?? '[]');
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is number => typeof v === 'number');
  } catch {
    return;
  }
  if (ids.length === 0) return;
  for (const id of ids) {
    const rule = store.byId(id);
    if (!rule || rule.status !== 'active') continue;
    if (!isRelated(rule.trigger_pattern, job.failure_trace, job.tool_name)) continue;
    store.mutateRule(id, result.antibody.trigger_pattern, {
      repairPath: job.repair_path ?? [],
      humanHint: job.human_hint ?? '',
    });
  }
}
