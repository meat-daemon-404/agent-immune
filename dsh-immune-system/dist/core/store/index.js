import { resolve } from 'node:path';
import { resolveDbPath } from './path.js';
import { openDatabase } from './open.js';
import { bumpHits, exportableAntibodies, findMatches, insertAntibody, listAntibodies, penalizeAntibodies, removeAntibody, setAntibodyStatus, } from './antibodies.js';
import { claimFailure, injectedIds, pruneStale, recordFailure, recordInjection, } from './episodes.js';
import { claimJob, enqueueJob, finishJob, pendingJobCount, requeueStuckJobs, } from './jobs.js';
export { RETIRE_AFTER_FAILURES } from './antibodies.js';
export { resolveDbPath } from './path.js';
export { tokenize, buildFtsQuery } from './tokenize.js';
export class ImmuneStore {
    db;
    dbPath;
    constructor(opts = {}) {
        this.dbPath =
            opts.dbPath ?? (opts.dataDir ? resolve(opts.dataDir, 'immune.sqlite') : resolveDbPath());
        this.db = openDatabase(this.dbPath);
    }
    insert(ab) {
        return insertAntibody(this.db, ab);
    }
    match(queryText, opts = {}) {
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
            if (opts.sessionId)
                recordInjection(this.db, opts.sessionId, rows.map((r) => r.id));
        }
        return rows;
    }
    /** Record an injection that did not come through match() (session-start priming). */
    recordInjection(sessionId, ids) {
        if (ids.length > 0)
            recordInjection(this.db, sessionId, ids);
    }
    listAll(includeRetired = true) {
        return listAntibodies(this.db, includeRetired);
    }
    remove(id) {
        return removeAntibody(this.db, id);
    }
    setStatus(id, status) {
        return setAntibodyStatus(this.db, id, status);
    }
    recordFailure(sessionId, toolName, trace) {
        return recordFailure(this.db, sessionId, toolName, trace);
    }
    claimFailure(sessionId, toolName) {
        return claimFailure(this.db, sessionId, toolName);
    }
    injectedIds(sessionId) {
        return injectedIds(this.db, sessionId);
    }
    penalize(ids, ctx) {
        return penalizeAntibodies(this.db, ids, ctx);
    }
    pruneStale(now = Date.now()) {
        pruneStale(this.db, now);
    }
    exportable(minHits = 3) {
        return exportableAntibodies(this.db, minHits);
    }
    enqueueJob(tool, failure, success, injected) {
        return enqueueJob(this.db, tool, failure, success, injected);
    }
    claimJob() {
        return claimJob(this.db);
    }
    finishJob(id, status, note = '') {
        finishJob(this.db, id, status, note);
    }
    requeueStuckJobs() {
        return requeueStuckJobs(this.db);
    }
    pendingJobCount() {
        return pendingJobCount(this.db);
    }
    close() {
        this.db.close();
    }
}
