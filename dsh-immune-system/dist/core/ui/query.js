export const MAX_QUERY = 200;
export const ACTIONS = new Set(['retire', 'restore', 'delete']);
/**
 * The same variable and clamp the adapters use (zcode/src/drain.ts,
 * dsh/src/index.ts). Read here only to display it; the drain itself owns the
 * real value.
 */
export function resolveBudgetMs(env = process.env) {
    const raw = Number(env.IMMUNE_DISTILL_BUDGET_MS ?? '');
    const budget = Number.isFinite(raw) && raw > 0 ? raw : 12_000;
    return Math.min(60_000, Math.max(1_000, Math.trunc(budget)));
}
export function dashboardStats(store) {
    const all = store.listAll(true);
    const s = store.stats();
    return {
        active: all.filter((a) => a.status === 'active').length,
        retired: all.filter((a) => a.status === 'retired').length,
        hits: all.reduce((sum, a) => sum + a.hit_count, 0),
        fails: all.reduce((sum, a) => sum + a.fail_count, 0),
        shared: store.sharedAntibodies(1000).length,
        pendingFailures: s.pendingFailures,
        sessions: s.sessions,
        jobsPending: s.jobsPending,
        jobsTotal: s.jobsTotal,
        suppressedRepeats: s.suppressedRepeats,
        llmDistilled: s.llmDistilled,
        llmFallbacks: s.llmFallbacks,
        dbBytes: s.dbBytes,
    };
}
/** Read state for one view. Never bumps hit counts: browsing is not delivery. */
export function readState(store, view, query = '', budgetMs = resolveBudgetMs()) {
    const antibodies = view === 'shared' ? store.sharedAntibodies(MAX_QUERY) : store.peek(query.slice(0, MAX_QUERY), MAX_QUERY);
    return { stats: dashboardStats(store), antibodies, budgetMs };
}
/** Apply one validated mutation. */
export function applyAction(store, op, id) {
    if (!ACTIONS.has(op) || !Number.isInteger(id) || id <= 0) {
        return { status: 400, body: { error: 'invalid action' } };
    }
    if (op === 'delete') {
        const ok = store.remove(id);
        return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'not found' } };
    }
    const ok = store.setStatus(id, op === 'retire' ? 'retired' : 'active');
    return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'not found' } };
}
