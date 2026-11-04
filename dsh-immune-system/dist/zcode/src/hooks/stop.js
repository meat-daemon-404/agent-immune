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
await runHook('Stop', async () => {
    const store = new ImmuneStore();
    try {
        await drainJobs(store);
    }
    finally {
        store.close();
    }
    return null;
});
