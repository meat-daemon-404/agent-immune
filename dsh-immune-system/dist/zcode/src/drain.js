import { distillEpisode } from '../../core/distiller.js';
import { isSelfEpisode } from '../../core/selfnoise.js';
import { selfMarkers } from './root-marker.js';
/** Default wall-clock budget for one drain, in milliseconds. */
export function drainBudgetMs(env = process.env) {
    const raw = Number(env.IMMUNE_DISTILL_BUDGET_MS ?? '');
    return Number.isFinite(raw) && raw > 0 ? raw : 12_000;
}
/**
 * Process queued jobs until the queue is empty or the budget runs out.
 * Never throws: a distillation error marks the job failed and moves on.
 */
export async function drainJobs(store, budgetMs = drainBudgetMs()) {
    const deadline = Date.now() + budgetMs;
    let processed = 0;
    let learned = 0;
    // Recover jobs whose previous attempt died mid-flight.
    store.requeueStuckJobs();
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        const job = store.claimJob();
        if (!job)
            break;
        // Defense in depth: jobs enqueued by older plugin versions may predate the
        // enqueue-time self-noise gate, so the drain re-checks before distilling.
        if (isSelfEpisode(`${job.failure_trace} ${job.success_trace}`, selfMarkers())) {
            store.finishJob(job.id, 'skipped', 'self-noise episode (drain-time gate)');
            continue;
        }
        try {
            const result = await distillEpisode(job.tool_name, job.failure_trace, job.success_trace, {
                signal: AbortSignal.timeout(Math.max(1000, remaining)),
                humanHint: job.human_hint ?? '',
            });
            processed += 1;
            if (result.ok) {
                store.insert(result.antibody);
                store.finishJob(job.id, 'done');
                learned += 1;
            }
            else {
                store.finishJob(job.id, result.reason === 'skip' ? 'skipped' : 'failed', result.detail ?? '');
            }
        }
        catch (error) {
            store.finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error));
        }
    }
    return { processed, learned, remaining: store.pendingJobCount() };
}
