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
        byModel: store.modelBreakdown(),
        crossModelRules: store.crossModelRules(),
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
const WEEK = 7 * 24 * 60 * 60 * 1000;
const EVOLUTION_WEEKS = 8;
/**
 * Evolution telemetry from what the database actually records. The roadmap's
 * first-try-success-rate and mean-retries curves need per-call outcome history
 * the store does not keep — those are NOT invented here; the panel shows the
 * rule lifecycle the store can prove.
 */
export function evolutionStats(store, now = Date.now()) {
    const weeks = new Array(EVOLUTION_WEEKS).fill(0);
    const bucketOf = (timestamp) => {
        const age = now - timestamp;
        if (age < 0 || age >= EVOLUTION_WEEKS * WEEK)
            return -1;
        return EVOLUTION_WEEKS - 1 - Math.floor(age / WEEK);
    };
    for (const rule of store.listAll(true)) {
        const bucket = bucketOf(rule.created_at);
        if (bucket >= 0)
            weeks[bucket] = (weeks[bucket] ?? 0) + 1;
    }
    const episodeWeeks = new Array(EVOLUTION_WEEKS).fill(0);
    for (const job of store.listJobs(500)) {
        if (job.status !== 'done')
            continue;
        const bucket = bucketOf(job.created_at);
        if (bucket >= 0)
            episodeWeeks[bucket] = (episodeWeeks[bucket] ?? 0) + 1;
    }
    const all = store.listAll(true);
    return {
        newRules: weeks,
        episodes: episodeWeeks,
        lineage: all.filter((rule) => (rule.parent_id ?? 0) > 0).length,
        fromUserCorrection: all.filter((rule) => rule.origin === 'user_correction').length,
        fromSelfHealing: all.filter((rule) => rule.origin === 'self_healing_experiment').length,
        probation: all.filter((rule) => (rule.probation_at ?? 0) > 0 && rule.status === 'active').length,
        supersededByEnv: all.filter((rule) => rule.retire_reason === 'superseded_by_env_upgrade').length,
        detours: store.detourCount(),
    };
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
