/**
 * ROADMAP 2.4b — sleep consolidation at the turn-end drain.
 *
 * ZCode has no SessionEnd (known limits), so the quiet pass rides the existing
 * Stop hook with a 12-hour cooldown: at most one scan per half day, a few
 * milliseconds when it does run. It NEVER auto-merges (AGENTS.md #29:
 * consolidation merges only what it can prove) — it clusters the library and
 * queues the review work; `immune consolidate` stays the explicit action. The
 * managed AGENTS.md refresh is the already-shipped sync-doc path (2.4a).
 */
import { findLessonGroups } from './consolidate.js';
/** Minimum time between consolidation scans. */
export const SLEEP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
/** A cluster this big deserves the operator's attention. */
export const SLEEP_MIN_CLUSTER = 5;
const KEY_LAST_RUN = 'sleep_consolidate_last_run';
const KEY_REVIEW_GROUPS = 'sleep_review_groups';
/**
 * One bounded consolidation scan. Read-only over the rules; the only writes
 * are two meta keys. Never throws into the hook.
 */
export function maybeSleepConsolidate(store, env = process.env, now = Date.now()) {
    if (env.IMMUNE_SLEEP_CONSOLIDATE === 'off')
        return null;
    const last = store.metaValue(KEY_LAST_RUN);
    if (last > 0 && now - last < SLEEP_COOLDOWN_MS)
        return null;
    const groups = findLessonGroups(store);
    const reviewGroups = groups.filter((group) => group.rules.length >= SLEEP_MIN_CLUSTER).length;
    store.setMetaValue(KEY_LAST_RUN, now);
    store.setMetaValue(KEY_REVIEW_GROUPS, reviewGroups);
    return { ran: true, reviewGroups, lastRun: now };
}
/** The queued review count for `immune stats` (0 when no scan has run yet). */
export function sleepReviewGroupsOf(store) {
    return store.metaValue(KEY_REVIEW_GROUPS);
}
