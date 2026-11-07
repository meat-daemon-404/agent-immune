/**
 * Facade over the immune database.
 *
 * Each hook is a separate process, so all cross-event state lives in SQLite
 * rather than module memory. Low-level work is split into `antibodies.ts`
 * (rules) and `episodes.ts` (failure/success pairing).
 */
import type { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Antibody, AntibodyStatus, FailureSnapshot, NewAntibody } from '../types.js';
import { resolveDbPath } from './path.js';
import { openDatabase } from './open.js';
import { GlobalStore, globalDbPathFor, isPromotable } from './global.js';
import { rerank } from './rerank.js';
import { bumpMeta, readMeta } from './meta.js';

/** meta-table key for the value metric: repeats the plugin measurably prevented. */
export const SUPPRESSED_REPEATS_KEY = 'suppressed_repeats';
import {
  bumpTurn,
  clearTurnState,
  readTurnState,
  recordTurnInjection,
  shouldSuppress,
} from './turn-state.js';
import {
  bumpHits,
  exportableAntibodies,
  findMatches,
  insertAntibody,
  listAntibodies,
  penalizeAntibodies,
  removeAntibody,
  setAntibodyStatus,
  newestActiveId,
  pruneZombieAntibodies,
  retireZombieAntibodies,
  type PenaltyContext,
} from './antibodies.js';
import {
  claimFailure,
  injectedIds,
  injectedPrescriptions,
  pruneStale,
  recordFailure,
  recordInjection,
  attachHumanHint,
} from './episodes.js';
import {
  claimJob,
  claimJobs,
  enqueueJob,
  finishJob,
  pendingJobCount,
  requeueStuckJobs,
  type DistillJob,
} from './jobs.js';

export { RETIRE_AFTER_FAILURES } from './antibodies.js';
export { resolveDbPath } from './path.js';
export { tokenize, buildFtsQuery } from './tokenize.js';
export type { DistillJob } from './jobs.js';
export type { PenaltyContext } from './antibodies.js';
export { GlobalStore, globalDbPathFor, isPromotable, GLOBAL_DB_FILE } from './global.js';

export interface StoreOptions {
  /** Full path to the database file, or ':memory:' for tests. */
  dbPath?: string;
  /** Directory the database lives in when `dbPath` is not given. */
  dataDir?: string;
}

export interface MatchOptions {
  limit?: number;
  /** Record hits and remember this turn's injection set for later penalising. */
  sessionId?: string;
  /**
   * Skip rules this session already received within the injection TTL window.
   * Hosts that re-inject per turn (DSH) leave this off; hosts that prime at
   * session start and then match per prompt (ZCode) set it.
   */
  excludeInjected?: boolean;
  /**
   * Suppress an injection whose id set is identical to last turn's, for up to
   * SUPPRESS_WINDOW turns, without counting a hit. Callers that run once per
   * user turn (UserPromptSubmit, agent/pre-step) set this.
   */
  suppressRepeats?: boolean;
}

export class ImmuneStore {
  private db: DatabaseSync;
  readonly dbPath: string;
  /** Shared library, opened on first need; undefined = not decided yet. */
  private globalStore: GlobalStore | null | undefined;

  constructor(opts: StoreOptions = {}) {
    this.dbPath =
      opts.dbPath ?? (opts.dataDir ? resolve(opts.dataDir, 'immune.sqlite') : resolveDbPath());
    this.db = openDatabase(this.dbPath);
  }

  insert(ab: NewAntibody): number | null {
    return insertAntibody(this.db, ab);
  }

  /**
   * Insert and, when the rule is provably generic, also publish it to the
   * shared library so the next project starts already knowing it.
   */
  insertShared(
    ab: NewAntibody,
    opts: { generic?: boolean; humanHint?: boolean; fromLlm?: boolean } = {},
  ): number | null {
    const id = insertAntibody(this.db, ab, {
      humanHint: opts.humanHint === true,
      fromLlm: opts.fromLlm === true,
    });
    if (id === null) return null;
    const global = this.global();
    if (!global) return id;
    try {
      if (isPromotable({ ...ab, hit_count: 0 }, opts.generic === true)) {
        global.insert({
          trigger_pattern: ab.trigger_pattern,
          symptom: ab.symptom,
          prescription: ab.prescription,
          tool_name: ab.tool_name ?? null,
        });
      }
    } catch {
      // Sharing is an optimisation; never let it cost the caller an insert.
    }
    return id;
  }

  /** Lazily open the shared library; null when sharing is disabled. */
  private global(): GlobalStore | null {
    if (this.globalStore !== undefined) return this.globalStore;
    if (process.env.IMMUNE_GLOBAL_LIBRARY === '0' || this.dbPath === ':memory:') {
      this.globalStore = null;
      return null;
    }
    try {
      this.globalStore = new GlobalStore(globalDbPathFor(this.dbPath));
    } catch {
      this.globalStore = null;
    }
    return this.globalStore;
  }

  match(queryText: string, opts: MatchOptions = {}): Antibody[] {
    const limit = opts.limit ?? 3;
    // Retrieve wide, then rerank: BM25 answers "is the text related", not "is
    // this about the file I am touching right now".
    const wide = limit * 2;

    const sent =
      opts.excludeInjected && opts.sessionId
        ? new Set(injectedPrescriptions(this.db, opts.sessionId))
        : null;

    let own = findMatches(this.db, queryText, wide);
    if (opts.excludeInjected && opts.sessionId) {
      const seen = new Set(this.injectedIds(opts.sessionId));
      own = own.filter((r) => !seen.has(r.id));
    }

    // Shared-library candidates compete on the same terms, with a discount.
    const shared: Antibody[] = [];
    const sharedIds = new Set<number>();
    const delivered = new Set(own.map((r) => r.prescription));
    if (own.length < wide) {
      const global = this.global();
      if (global) {
        try {
          const want = wide - own.length + (sent?.size ?? 0);
          for (const candidate of global.match(queryText, want)) {
            if (delivered.has(candidate.prescription)) continue;
            if (sent?.has(candidate.prescription)) continue;
            shared.push(candidate);
            sharedIds.add(candidate.id);
            delivered.add(candidate.prescription);
            if (own.length + shared.length >= wide) break;
          }
        } catch {
          // A broken shared library must not break the caller's turn.
        }
      }
    }

    const merged = [...own, ...shared];
    const relevance = new Map(merged.map((r, i) => [r.id, 1 / (1 + i)]));
    const ranked = rerank(merged, { query: queryText, sharedIds, relevance }).slice(0, limit);
    const rankedOwn = ranked.filter((r) => !sharedIds.has(r.id));
    const rankedShared = ranked.filter((r) => sharedIds.has(r.id));

    // ---- Repeat suppression (per turn) -------------------------------------
    // Same set as last turn and fewer than SUPPRESS_WINDOW turns since: say
    // nothing and do not count a hit. Re-injecting an identical block costs
    // context, and inflating hit_count corrupts promotion and anti-rot.
    if (opts.suppressRepeats && opts.sessionId) {
      const state = readTurnState(this.db, opts.sessionId);
      if (shouldSuppress(state, rankedOwn.map((r) => r.id))) {
        bumpTurn(this.db, opts.sessionId);
        bumpMeta(this.db, SUPPRESSED_REPEATS_KEY);
        return [];
      }
    }

    if (rankedOwn.length > 0) {
      bumpHits(this.db, rankedOwn.map((r) => r.id));

      // Promote on the turn a rule crosses five successful injections: that is
      // the proof-of-generality the promotion rule asks for, and checking the
      // pre-bump count keeps it off the hot path on every other call.
      const crossed = rankedOwn.filter((r) => r.hit_count === 4 && isPromotable(r, false));
      if (crossed.length > 0) {
        const global = this.global();
        for (const row of crossed) {
          try {
            global?.insert({
              trigger_pattern: row.trigger_pattern,
              symptom: row.symptom,
              prescription: row.prescription,
              tool_name: row.tool_name,
            });
          } catch {
            // Sharing is best-effort.
          }
        }
      }
    }

    if (rankedShared.length > 0) {
      try {
        this.global()?.countInjection(rankedShared.map((r) => r.id));
      } catch {
        // Counting is best-effort.
      }
    }

    if (opts.sessionId && (rankedOwn.length > 0 || rankedShared.length > 0)) {
      recordInjection(
        this.db,
        opts.sessionId,
        rankedOwn.map((r) => r.id),
        ranked.map((r) => r.prescription),
      );
      if (opts.suppressRepeats) recordTurnInjection(this.db, opts.sessionId, rankedOwn.map((r) => r.id));
    }

    return ranked;
  }

  /** Record an injection that did not come through match() (session-start priming). */
  recordInjection(sessionId: string, ids: number[], prescriptions: string[] = []): void {
    if (ids.length > 0) recordInjection(this.db, sessionId, ids, prescriptions);
  }

  /**
   * Forget this session's repeat-suppression history.
   *
   * Called on resume / clear / compact: those are new contexts, so a rule that
   * was suppressed before must be eligible again.
   */
  resetTurnState(sessionId: string): void {
    clearTurnState(this.db, sessionId);
  }

  listAll(includeRetired = true): Antibody[] {
    return listAntibodies(this.db, includeRetired);
  }

  /**
   * Read-only search over THIS project's rules, for tooling (the dashboard).
   *
   * Deliberately does NOT bump hit counts or record an injection: browsing in a
   * UI is not the same as delivering a rule to a model, and letting the two
   * share a counter would inflate the numbers that drive promotion and pruning.
   */
  peek(queryText: string, limit = 50): Antibody[] {
    if (!queryText.trim()) return this.listAll(true).slice(0, limit);
    return findMatches(this.db, queryText, limit);
  }

  /** Shared-library rows, for the dashboard's second tab. */
  sharedAntibodies(limit = 100): Antibody[] {
    const global = this.global();
    if (!global) return [];
    try {
      return global.listAll(true).slice(0, limit);
    } catch {
      return [];
    }
  }

  remove(id: number): boolean {
    return removeAntibody(this.db, id);
  }

  /** Forget the newest active antibody. Returns its id, or null when none. */
  forgetLast(): number | null {
    const id = newestActiveId(this.db);
    if (id === null) return null;
    return removeAntibody(this.db, id) ? id : null;
  }

  /** Retire never-injected antibodies older than `olderThanMs` (reversible). */
  retireZombies(olderThanMs: number): number[] {
    return retireZombieAntibodies(this.db, olderThanMs);
  }

  /** Delete never-injected antibodies older than `olderThanMs` (not reversible). */
  pruneZombies(olderThanMs: number): number[] {
    return pruneZombieAntibodies(this.db, olderThanMs);
  }

  setStatus(id: number, status: AntibodyStatus): boolean {
    return setAntibodyStatus(this.db, id, status);
  }

  recordFailure(
    sessionId: string,
    toolName: string,
    trace: unknown,
    targetSignature = '',
  ): FailureSnapshot {
    return recordFailure(this.db, sessionId, toolName, trace, targetSignature);
  }

  /** Annotate pending failures with what the human said in the next turn. */
  attachHumanHint(sessionId: string, hint: unknown): number {
    return attachHumanHint(this.db, sessionId, hint);
  }

  claimFailure(
    sessionId: string,
    toolName: string,
    incoming?: { signature: string; probeOnly: boolean },
  ): FailureSnapshot | null {
    return claimFailure(this.db, sessionId, toolName, incoming);
  }

  injectedIds(sessionId: string): number[] {
    return injectedIds(this.db, sessionId);
  }

  penalize(ids: number[], ctx?: PenaltyContext): Antibody[] {
    return penalizeAntibodies(this.db, ids, ctx);
  }

  pruneStale(now = Date.now()) {
    const counts = pruneStale(this.db, now);
    // The shared library has no other caller for its zombie aging: without
    // this, a shared rule that is never recalled lives forever, and the
    // library can only ever grow. Retiring (not deleting) keeps it
    // recoverable, and the longer window respects that shared rules are
    // recalled more rarely than project ones.
    try {
      this.global()?.retireZombies(30 * 24 * 60 * 60 * 1000);
    } catch {
      // Aging the shared library is best-effort.
    }
    return counts;
  }

  exportable(minHits = 3): Antibody[] {
    return exportableAntibodies(this.db, minHits);
  }

  /**
   * Row counts by table plus the on-disk size of the database file. Feeds
   * `immune doctor` and the UI; lets retention be observed, not assumed.
   */
  stats(): {
    active: number;
    retired: number;
    pendingFailures: number;
    sessions: number;
    jobsPending: number;
    jobsTotal: number;
    suppressedRepeats: number;
    dbBytes: number | null;
  } {
    const count = (sql: string, ...params: (string | number)[]): number => {
      const row = this.db.prepare(sql).get(...params) as { n: number | bigint };
      return Number(row.n);
    };
    let dbBytes: number | null = null;
    try {
      dbBytes = statSync(this.dbPath).size;
    } catch {
      // :memory: or not yet created — size stays null.
    }
    return {
      active: count("SELECT COUNT(*) AS n FROM antibodies WHERE status = 'active'"),
      retired: count("SELECT COUNT(*) AS n FROM antibodies WHERE status != 'active'"),
      pendingFailures: count('SELECT COUNT(*) AS n FROM pending_failures'),
      sessions: count('SELECT COUNT(*) AS n FROM session_turns'),
      jobsPending: count("SELECT COUNT(*) AS n FROM distill_jobs WHERE status = 'pending'"),
      jobsTotal: count('SELECT COUNT(*) AS n FROM distill_jobs'),
      suppressedRepeats: readMeta(this.db, SUPPRESSED_REPEATS_KEY),
      dbBytes,
    };
  }

  enqueueJob(
    tool: string,
    failure: string,
    success: string,
    injected: number[],
    humanHint = '',
  ): number {
    return enqueueJob(this.db, tool, failure, success, injected, humanHint);
  }

  claimJob(): DistillJob | null {
    return claimJob(this.db);
  }

  /** Claim up to `count` pending jobs, for batch distillation. */
  claimJobs(count: number): DistillJob[] {
    return claimJobs(this.db, count);
  }

  finishJob(id: number, status: 'done' | 'failed' | 'skipped', note = ''): void {
    finishJob(this.db, id, status, note);
  }

  requeueStuckJobs(): number {
    return requeueStuckJobs(this.db);
  }

  pendingJobCount(): number {
    return pendingJobCount(this.db);
  }

  close(): void {
    try {
      this.globalStore?.close();
    } catch {
      // already closed
    }
    this.db.close();
  }
}