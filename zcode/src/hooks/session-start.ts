/**
 * SessionStart — prime a new session and catch up on leftover work.
 *
 * Two jobs: drain any distillation jobs a previous session never finished, and
 * inject the project's most-used antibodies so the session starts already
 * aware of its own history.
 *
 * The runtime only passes a match value for `startup` and `resume` (the
 * `clear`/`compact` sources are documented but not dispatched in this build),
 * so hooks.json uses no matcher at all — that matches every source.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { runHook } from '../hook-io.js';
import { formatImmuneContext } from '../format.js';
import { drainJobs } from '../drain.js';

await runHook('SessionStart', async () => {
  const store = new ImmuneStore();
  try {
    await drainJobs(store);
    const top = store.listAll(false).slice(0, 3);
    return formatImmuneContext(top);
  } finally {
    store.close();
  }
});
