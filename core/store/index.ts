/**
 * Facade over the immune database.
 *
 * Each hook is a separate process, so all cross-event state lives in SQLite
 * rather than module memory. Low-level work is split into `antibodies.ts`
 * (rules) and `episodes.ts` (failure/success pairing).
 */
import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { Antibody, AntibodyStatus, FailureSnapshot, NewAntibody } from '../types.js';
import { resolveDbPath } from './path.js';
import { openDatabase } from './open.js';
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
  type PenaltyContext,
} from './antibodies.js';
import {
  claimFailure,
  injectedIds,
  pruneStale,
  recordFailure,
  recordInjection,
  attachHumanHint,
} from './episodes.js';
import {
  claimJob,
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
}

export class ImmuneStore {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor(opts: StoreOptions = {}) {
    this.dbPath =
      opts.dbPath ?? (opts.dataDir ? resolve(opts.dataDir, 'immune.sqlite') : resolveDbPath());
    this.db = openDatabase(this.dbPath);
  }

  insert(ab: NewAntibody): number | null {
    return insertAntibody(this.db, ab);
  }

  match(queryText: string, opts: MatchOptions = {}): Antibody[] {
    let rows = findMatches(this.db, queryText, opts.limit ?? 3);
    // Opt-in dedup: a host whose injection happens per TURN (DSH) wants
    // re-injection in later turns; one that primes at session start plus
    // per-prompt matching (ZCode) asks for exclusion so the same rule is not
    // paid for twice within the injection TTL window.
    if (opts.excludeInjected && opts.sessionId) {
      const seen = new Set(this.injectedIds(opts.sessionId));
      rows = rows.filter((r) => !seen.has(r.id));
    }
    if (rows.length > 0) {
      bumpHits(this.db, rows.map((r) => r.id));
      if (opts.sessionId) recordInjection(this.db, opts.sessionId, rows.map((r) => r.id));
    }
    return rows;
  }

  /** Record an injection that did not come through match() (session-start priming). */
  recordInjection(sessionId: string, ids: number[]): void {
    if (ids.length > 0) recordInjection(this.db, sessionId, ids);
  }

  listAll(includeRetired = true): Antibody[] {
    return listAntibodies(this.db, includeRetired);
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

  /** Delete never-injected antibodies older than `olderThanMs`. */
  pruneZombies(olderThanMs: number): number[] {
    return pruneZombieAntibodies(this.db, olderThanMs);
  }

  setStatus(id: number, status: AntibodyStatus): boolean {
    return setAntibodyStatus(this.db, id, status);
  }

  recordFailure(sessionId: string, toolName: string, trace: unknown): FailureSnapshot {
    return recordFailure(this.db, sessionId, toolName, trace);
  }

  /** Annotate pending failures with what the human said in the next turn. */
  attachHumanHint(sessionId: string, hint: unknown): number {
    return attachHumanHint(this.db, sessionId, hint);
  }

  claimFailure(sessionId: string, toolName: string): FailureSnapshot | null {
    return claimFailure(this.db, sessionId, toolName);
  }

  injectedIds(sessionId: string): number[] {
    return injectedIds(this.db, sessionId);
  }

  penalize(ids: number[], ctx?: PenaltyContext): Antibody[] {
    return penalizeAntibodies(this.db, ids, ctx);
  }

  pruneStale(now = Date.now()): void {
    pruneStale(this.db, now);
  }

  exportable(minHits = 3): Antibody[] {
    return exportableAntibodies(this.db, minHits);
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
    this.db.close();
  }
}