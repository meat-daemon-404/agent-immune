/**
 * Stop — the quiet worker.
 *
 * The turn is over, so this is the cheapest place to run model-backed
 * distillation: the user is no longer waiting on a tool result.
 *
 * Emits nothing. Stop hooks may also request continuation, and a plugin that
 * silently kept a conversation going would be hostile; learning is recorded
 * in the database instead.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { runHook } from '../hook-io.js';
import { drainJobs } from '../drain.js';
import { maybeSyncDocAfterDrain } from '../../../core/sync-doc.js';
import { maybeSleepConsolidate } from '../../../core/sleep-consolidate.js';
await runHook('Stop', async () => {
    const store = new ImmuneStore();
    try {
        await drainJobs(store);
        // Opt-in (IMMUNE_SYNC_DOC): push freshly learned rules into the project's
        // agent docs at the same boundary. Best-effort; never throws.
        maybeSyncDocAfterDrain(store);
        // ROADMAP 2.4b: the sleep-consolidation scan — 12h cooldown, read-only
        // over the rules, queues review clusters in meta for `immune stats`.
        // Best-effort; never throws into the turn boundary.
        try {
            maybeSleepConsolidate(store);
        }
        catch {
            // A failed scan must not cost the turn end anything.
        }
    }
    finally {
        store.close();
    }
    return null;
});
