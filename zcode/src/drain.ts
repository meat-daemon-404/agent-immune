/**
 * Drain queued distillation jobs.
 *
 * Distillation is deliberately NOT done on the failure/success hot path: a
 * model call there would add seconds to a turn the user is waiting on, and the
 * platform offers no working background flag for hooks. Instead jobs are queued
 * during tool use and drained at a natural boundary (turn end, session start),
 * under a time budget so a slow model can never stall those hooks either.
 */
import type { ImmuneStore } from '../../core/store/index.js';
import { distillEpisode } from '../../core/distiller.js';

export interface DrainResult {
  processed: number;
  learned: number;
  remaining: number;
}

/** Default wall-clock budget for one drain, in milliseconds. */
export function drainBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IMMUNE_DISTILL_BUDGET_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 12_000;
}

/**
 * Process queued jobs until the queue is empty or the budget runs out.
 * Never throws: a distillation error marks the job failed and moves on.
 */
export async function drainJobs(store: ImmuneStore, budgetMs = drainBudgetMs()): Promise<DrainResult> {
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  let learned = 0;

  // Recover jobs whose previous attempt died mid-flight.
  store.requeueStuckJobs();

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const job = store.claimJob();
    if (!job) break;

    try {
      const result = await distillEpisode(job.tool_name, job.failure_trace, job.success_trace, {
        signal: AbortSignal.timeout(Math.max(1000, remaining)),
      });
      processed += 1;
      if (result.ok) {
        store.insert(result.antibody);
        store.finishJob(job.id, 'done');
        learned += 1;
      } else {
        store.finishJob(job.id, result.reason === 'skip' ? 'skipped' : 'failed', result.detail ?? '');
      }
    } catch (error) {
      store.finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  return { processed, learned, remaining: store.pendingJobCount() };
}
