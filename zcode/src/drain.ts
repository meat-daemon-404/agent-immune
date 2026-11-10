/**
 * Drain queued distillation jobs.
 *
 * Distillation is deliberately NOT done on the failure/success hot path: a
 * model call there would add seconds to a turn the user is waiting on, and the
 * platform offers no working background flag for hooks. Instead jobs are queued
 * during tool use and drained at a natural boundary (turn end, session start),
 * under a time budget so a slow model can never stall those hooks either.
 *
 * With a model configured the drain batches: four episodes per request instead
 * of four requests. The time budget is what limits throughput here, so this is
 * the difference between draining a backlog within the turn and not.
 */
import type { ImmuneStore, DistillJob } from '../../core/store/index.js';
import { LLM_FALLBACK_KEY, LLM_SUCCESS_KEY } from '../../core/store/index.js';
import type { LlmConfig } from '../../core/llm.js';
import { distillBatch, distillEpisode } from '../../core/distiller.js';
import { readLlmConfig } from '../../core/llm.js';
import { matchGenericLesson } from '../../core/lessons.js';
import { isSelfEpisode } from '../../core/selfnoise.js';
import { isRelated } from '../../core/relevance.js';
import { currentFingerprint } from '../../core/env-fingerprint.js';
import { selfMarkers } from './root-marker.js';

export interface DrainResult {
  processed: number;
  learned: number;
  /** Episodes distilled with the rule path because the budget could not cover a model call. */
  deferred: number;
  remaining: number;
}

/** Episodes per model request when batching. */
export const DRAIN_BATCH_SIZE = 4;

/**
 * Default wall-clock budget for one drain, in milliseconds. Clamped to the
 * same 1-60 s window the UI displays (resolveBudgetMs): an unclamped env typo
 * would otherwise hold the Stop hook — and the user's turn — for minutes.
 */
export function drainBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IMMUNE_DISTILL_BUDGET_MS ?? '');
  const budget = Number.isFinite(raw) && raw > 0 ? raw : 12_000;
  return Math.min(60_000, Math.max(1_000, Math.trunc(budget)));
}

/** Drop jobs whose traces are the plugin operating on itself. */
function takeUsable(store: ImmuneStore, jobs: DistillJob[]): DistillJob[] {
  const usable: DistillJob[] = [];
  for (const job of jobs) {
    if (isSelfEpisode(`${job.failure_trace} ${job.success_trace}`, selfMarkers())) {
      store.finishJob(job.id, 'skipped', 'self-noise episode (drain-time gate)');
      continue;
    }
    usable.push(job);
  }
  return usable;
}

/** Persist one distillation result for its job. */
function commit(
  store: ImmuneStore,
  job: DistillJob,
  result: Awaited<ReturnType<typeof distillEpisode>>,
  skippedModelReason?: string,
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
  } else if (result.degradedReason || skippedModelReason) {
    store.bumpMeta(LLM_FALLBACK_KEY);
    store.finishJobNote(job.id, `llm degraded: ${result.degradedReason ?? skippedModelReason}`);
  }
  // A generic lesson is published to the shared library so the next project
  // starts already knowing it. The action diff, the teaching origin and the
  // workspace fingerprint ride along as provenance.
  store.insertShared(
    {
      ...result.antibody,
      repair_path: job.repair_path ?? [],
      origin: job.origin ?? '',
      env_fingerprint: currentFingerprint().key,
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
  result: Awaited<ReturnType<typeof distillEpisode>>,
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

/**
 * Process queued jobs until the queue is empty or the budget runs out.
 * Never throws: a distillation error marks the job failed and moves on.
 */
export async function drainJobs(
  store: ImmuneStore,
  budgetMs = drainBudgetMs(),
  opts: { llm?: LlmConfig | null } = {},
): Promise<DrainResult> {
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  let learned = 0;
  let deferred = 0;

  // Recover jobs whose previous attempt died mid-flight.
  store.requeueStuckJobs();

  // A backfill passes llm: null to force the deterministic rule path —
  // hundreds of historical episodes must not turn into hundreds of API calls.
  const configured = opts.llm !== undefined ? opts.llm : readLlmConfig();

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // A model call that cannot finish inside the remaining budget would burn
    // the whole budget and then time out, on every turn, forever. Only hand
    // the model work the budget can actually cover; otherwise distil with the
    // rule path immediately (cheap, deterministic) and say why.
    const llm = configured && remaining >= configured.timeoutMs ? configured : null;
    const budgetShort = configured !== null && llm === null;

    // Batch only when a model is actually configured and there is a backlog;
    // otherwise the deterministic rule runs per episode as before.
    const backlog = store.pendingJobCount();
    const batch = llm && backlog >= 2;
    const claimed = takeUsable(store, store.claimJobs(batch ? DRAIN_BATCH_SIZE : 1));
    if (claimed.length === 0) {
      if (store.pendingJobCount() === 0) break;
      continue;
    }
    if (budgetShort) deferred += claimed.length;

    if (claimed.length >= 2) {
      try {
        const results = await distillBatch(
          claimed.map((job) => ({
            id: job.id,
            toolName: job.tool_name,
            failedTrace: job.failure_trace,
            fixedTrace: job.success_trace,
            humanHint: job.human_hint ?? '',
            repairs: job.repair_path ?? [],
          })),
          { llm, signal: AbortSignal.timeout(Math.max(1000, remaining)) },
        );
        for (const job of claimed) {
          const result = results.get(job.id);
          if (!result) {
            store.finishJob(job.id, 'failed', 'no result from batch');
            continue;
          }
          processed += 1;
          if (commit(store, job, result, budgetShort ? budgetNote(configured, budgetMs) : undefined)) {
            learned += 1;
          }
        }
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        for (const job of claimed) store.finishJob(job.id, 'failed', `batch failed: ${note}`);
      }
      continue;
    }

    const job = claimed[0];
    if (!job) break;
    try {
      const result = await distillEpisode(job.tool_name, job.failure_trace, job.success_trace, {
        llm,
        signal: AbortSignal.timeout(Math.max(1000, remaining)),
        humanHint: job.human_hint ?? '',
        repairs: job.repair_path ?? [],
      });
      processed += 1;
      if (commit(store, job, result, budgetShort ? budgetNote(configured, budgetMs) : undefined)) {
        learned += 1;
      }
    } catch (error) {
      store.finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  return { processed, learned, deferred, remaining: store.pendingJobCount() };
}

/** Why the model path was skipped this pass, for the job note and the counter. */
function budgetNote(llm: LlmConfig | null, budgetMs: number): string {
  return `budget ${budgetMs} ms < llm timeout ${llm?.timeoutMs ?? '?'} ms`;
}
