import { distillBatch, distillEpisode } from '../../core/distiller.js';
import { readLlmConfig } from '../../core/llm.js';
import { matchGenericLesson } from '../../core/lessons.js';
import { isSelfEpisode } from '../../core/selfnoise.js';
import { selfMarkers } from './root-marker.js';
/** Episodes per model request when batching. */
export const DRAIN_BATCH_SIZE = 4;
/**
 * Default wall-clock budget for one drain, in milliseconds. Clamped to the
 * same 1-60 s window the UI displays (resolveBudgetMs): an unclamped env typo
 * would otherwise hold the Stop hook — and the user's turn — for minutes.
 */
export function drainBudgetMs(env = process.env) {
    const raw = Number(env.IMMUNE_DISTILL_BUDGET_MS ?? '');
    const budget = Number.isFinite(raw) && raw > 0 ? raw : 12_000;
    return Math.min(60_000, Math.max(1_000, Math.trunc(budget)));
}
/** Drop jobs whose traces are the plugin operating on itself. */
function takeUsable(store, jobs) {
    const usable = [];
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
function commit(store, job, result) {
    if (!result.ok) {
        store.finishJob(job.id, result.reason === 'skip' ? 'skipped' : 'failed', result.detail ?? '');
        return false;
    }
    // A generic lesson is published to the shared library so the next project
    // starts already knowing it.
    store.insertShared(result.antibody, {
        generic: matchGenericLesson(result.antibody.symptom) !== null,
        humanHint: Boolean(job.human_hint),
    });
    store.finishJob(job.id, 'done');
    return true;
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
    const llm = readLlmConfig();
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        // Batch only when a model is actually configured and there is a backlog;
        // otherwise the deterministic rule runs per episode as before.
        const backlog = store.pendingJobCount();
        const batch = llm && backlog >= 2;
        const claimed = takeUsable(store, store.claimJobs(batch ? DRAIN_BATCH_SIZE : 1));
        if (claimed.length === 0) {
            if (store.pendingJobCount() === 0)
                break;
            continue;
        }
        if (claimed.length >= 2) {
            try {
                const results = await distillBatch(claimed.map((job) => ({
                    id: job.id,
                    toolName: job.tool_name,
                    failedTrace: job.failure_trace,
                    fixedTrace: job.success_trace,
                    humanHint: job.human_hint ?? '',
                })), { llm, signal: AbortSignal.timeout(Math.max(1000, remaining)) });
                for (const job of claimed) {
                    const result = results.get(job.id);
                    if (!result) {
                        store.finishJob(job.id, 'failed', 'no result from batch');
                        continue;
                    }
                    processed += 1;
                    if (commit(store, job, result))
                        learned += 1;
                }
            }
            catch (error) {
                const note = error instanceof Error ? error.message : String(error);
                for (const job of claimed)
                    store.finishJob(job.id, 'failed', `batch failed: ${note}`);
            }
            continue;
        }
        const job = claimed[0];
        if (!job)
            break;
        try {
            const result = await distillEpisode(job.tool_name, job.failure_trace, job.success_trace, {
                llm,
                signal: AbortSignal.timeout(Math.max(1000, remaining)),
                humanHint: job.human_hint ?? '',
            });
            processed += 1;
            if (commit(store, job, result))
                learned += 1;
        }
        catch (error) {
            store.finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error));
        }
    }
    return { processed, learned, remaining: store.pendingJobCount() };
}
