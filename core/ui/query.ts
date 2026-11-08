/**
 * Query surface shared by the standalone dashboard and the DSH web route.
 *
 * Kept separate from either server so the two cannot drift: one definition of
 * "what the UI may read" and "which mutations exist".
 */
import type { Antibody } from '../types.js';
import type { ImmuneStore } from '../store/index.js';

export const MAX_QUERY = 200;
export const ACTIONS = new Set(['retire', 'restore', 'delete']);

export interface DashboardStats {
  active: number;
  retired: number;
  hits: number;
  shared: number;
  /** Live episode/session tables and the on-disk footprint (null = :memory:). */
  pendingFailures: number;
  sessions: number;
  jobsPending: number;
  jobsTotal: number;
  /** Value metric: repeats the suppression window measurably prevented. */
  suppressedRepeats: number;
  /**
   * Deliveries followed by a relevant failure (anti-rot penalties). `hits` is
   * how often the library was used; `hits - fails` is how often it held. The
   * pair is what says the rules are being used, not merely accumulated.
   */
  fails: number;
  /** Model path: rules it produced, and times it degraded to the rule path. */
  llmDistilled: number;
  llmFallbacks: number;
  dbBytes: number | null;
}

export interface DashboardState {
  stats: DashboardStats;
  antibodies: Antibody[];
  /** Effective turn-end distillation budget, so the UI can show it. */
  budgetMs: number;
}

/**
 * The same variable and clamp the adapters use (zcode/src/drain.ts,
 * dsh/src/index.ts). Read here only to display it; the drain itself owns the
 * real value.
 */
export function resolveBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IMMUNE_DISTILL_BUDGET_MS ?? '');
  const budget = Number.isFinite(raw) && raw > 0 ? raw : 12_000;
  return Math.min(60_000, Math.max(1_000, Math.trunc(budget)));
}

export function dashboardStats(store: ImmuneStore): DashboardStats {
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
export function readState(
  store: ImmuneStore,
  view: 'project' | 'shared',
  query = '',
  budgetMs = resolveBudgetMs(),
): DashboardState {
  const antibodies =
    view === 'shared' ? store.sharedAntibodies(MAX_QUERY) : store.peek(query.slice(0, MAX_QUERY), MAX_QUERY);
  return { stats: dashboardStats(store), antibodies, budgetMs };
}

export interface ActionResult {
  status: number;
  body: unknown;
}

/** Apply one validated mutation. */
export function applyAction(store: ImmuneStore, op: string, id: number): ActionResult {
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
