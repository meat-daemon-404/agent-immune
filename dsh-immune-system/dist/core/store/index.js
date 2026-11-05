import { resolve } from 'node:path';
import { resolveDbPath } from './path.js';
import { openDatabase } from './open.js';
import { GlobalStore, globalDbPathFor, isPromotable } from './global.js';
import { bumpHits, exportableAntibodies, findMatches, insertAntibody, listAntibodies, penalizeAntibodies, removeAntibody, setAntibodyStatus, newestActiveId, pruneZombieAntibodies, retireZombieAntibodies, } from './antibodies.js';
import { claimFailure, injectedIds, injectedPrescriptions, pruneStale, recordFailure, recordInjection, attachHumanHint, } from './episodes.js';
import { claimJob, enqueueJob, finishJob, pendingJobCount, requeueStuckJobs, } from './jobs.js';
export { RETIRE_AFTER_FAILURES } from './antibodies.js';
export { resolveDbPath } from './path.js';
export { tokenize, buildFtsQuery } from './tokenize.js';
export { GlobalStore, globalDbPathFor, isPromotable, GLOBAL_DB_FILE } from './global.js';
export class ImmuneStore {
    db;
    dbPath;
    /** Shared library, opened on first need; undefined = not decided yet. */
    globalStore;
    constructor(opts = {}) {
        this.dbPath =
            opts.dbPath ?? (opts.dataDir ? resolve(opts.dataDir, 'immune.sqlite') : resolveDbPath());
        this.db = openDatabase(this.dbPath);
    }
    insert(ab) {
        return insertAntibody(this.db, ab);
    }
    /**
     * Insert and, when the rule is provably generic, also publish it to the
     * shared library so the next project starts already knowing it.
     */
    insertShared(ab, opts = {}) {
        const id = insertAntibody(this.db, ab);
        if (id === null)
            return null;
        const global = this.global();
        if (!global)
            return id;
        try {
            if (isPromotable({ ...ab, hit_count: 0 }, opts.generic === true)) {
                global.insert({
                    trigger_pattern: ab.trigger_pattern,
                    symptom: ab.symptom,
                    prescription: ab.prescription,
                    tool_name: ab.tool_name ?? null,
                });
            }
        }
        catch {
            // Sharing is an optimisation; never let it cost the caller an insert.
        }
        return id;
    }
    /** Lazily open the shared library; null when sharing is disabled. */
    global() {
        if (this.globalStore !== undefined)
            return this.globalStore;
        if (process.env.IMMUNE_GLOBAL_LIBRARY === '0' || this.dbPath === ':memory:') {
            this.globalStore = null;
            return null;
        }
        try {
            this.globalStore = new GlobalStore(globalDbPathFor(this.dbPath));
        }
        catch {
            this.globalStore = null;
        }
        return this.globalStore;
    }
    match(queryText, opts = {}) {
        const limit = opts.limit ?? 3;
        // Prescriptions already delivered this session. Shared rules live in a
        // different database with its own id sequence, so text is the only stable
        // key to deduplicate them against project rules.
        const sent = opts.excludeInjected && opts.sessionId
            ? new Set(injectedPrescriptions(this.db, opts.sessionId))
            : null;
        let own = findMatches(this.db, queryText, limit);
        // Opt-in dedup: a host whose injection happens per TURN (DSH) wants
        // re-injection in later turns; one that primes at session start plus
        // per-prompt matching (ZCode) asks for exclusion so the same rule is not
        // paid for twice within the injection TTL window.
        if (opts.excludeInjected && opts.sessionId) {
            const seen = new Set(this.injectedIds(opts.sessionId));
            own = own.filter((r) => !seen.has(r.id));
        }
        // Fill the remaining slots from the shared library, so a fresh project is
        // not defenceless before it has learned anything of its own.
        //
        // Project rows and shared rows are tracked in separate arrays, never merged
        // by id: the two databases have independent AUTOINCREMENT sequences, so an
        // id from one can collide with an unrelated row in the other.
        const shared = [];
        const delivered = new Set(own.map((r) => r.prescription));
        if (own.length < limit) {
            const global = this.global();
            if (global) {
                try {
                    // Ask for a little extra so deduplicated candidates do not shrink
                    // the result below what the caller asked for.
                    const want = limit - own.length + (sent?.size ?? 0);
                    for (const candidate of global.match(queryText, want)) {
                        if (delivered.has(candidate.prescription))
                            continue;
                        if (sent?.has(candidate.prescription))
                            continue;
                        shared.push(candidate);
                        delivered.add(candidate.prescription);
                        if (own.length + shared.length >= limit)
                            break;
                    }
                }
                catch {
                    // A broken shared library must not break the caller's turn.
                }
            }
        }
        if (own.length > 0) {
            bumpHits(this.db, own.map((r) => r.id));
            // Promote on the turn a rule crosses five successful injections: that is
            // the proof-of-generality the promotion rule asks for, and checking the
            // pre-bump count keeps it off the hot path on every other call.
            const crossed = own.filter((r) => r.hit_count === 4 && isPromotable(r, false));
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
                    }
                    catch {
                        // Sharing is best-effort.
                    }
                }
            }
        }
        if (shared.length > 0) {
            // The shared library is a real library, not a read-only mirror: its rules
            // must accumulate hits or they can never age, retire, or be pruned.
            try {
                this.global()?.countInjection(shared.map((r) => r.id));
            }
            catch {
                // Counting is best-effort.
            }
        }
        if (opts.sessionId && (own.length > 0 || shared.length > 0)) {
            recordInjection(this.db, opts.sessionId, own.map((r) => r.id), [...delivered]);
        }
        return [...own, ...shared];
    }
    /** Record an injection that did not come through match() (session-start priming). */
    recordInjection(sessionId, ids, prescriptions = []) {
        if (ids.length > 0)
            recordInjection(this.db, sessionId, ids, prescriptions);
    }
    listAll(includeRetired = true) {
        return listAntibodies(this.db, includeRetired);
    }
    /**
     * Read-only search over THIS project's rules, for tooling (the dashboard).
     *
     * Deliberately does NOT bump hit counts or record an injection: browsing in a
     * UI is not the same as delivering a rule to a model, and letting the two
     * share a counter would inflate the numbers that drive promotion and pruning.
     */
    peek(queryText, limit = 50) {
        if (!queryText.trim())
            return this.listAll(true).slice(0, limit);
        return findMatches(this.db, queryText, limit);
    }
    /** Shared-library rows, for the dashboard's second tab. */
    sharedAntibodies(limit = 100) {
        const global = this.global();
        if (!global)
            return [];
        try {
            return global.listAll(true).slice(0, limit);
        }
        catch {
            return [];
        }
    }
    remove(id) {
        return removeAntibody(this.db, id);
    }
    /** Forget the newest active antibody. Returns its id, or null when none. */
    forgetLast() {
        const id = newestActiveId(this.db);
        if (id === null)
            return null;
        return removeAntibody(this.db, id) ? id : null;
    }
    /** Retire never-injected antibodies older than `olderThanMs` (reversible). */
    retireZombies(olderThanMs) {
        return retireZombieAntibodies(this.db, olderThanMs);
    }
    /** Delete never-injected antibodies older than `olderThanMs` (not reversible). */
    pruneZombies(olderThanMs) {
        return pruneZombieAntibodies(this.db, olderThanMs);
    }
    setStatus(id, status) {
        return setAntibodyStatus(this.db, id, status);
    }
    recordFailure(sessionId, toolName, trace) {
        return recordFailure(this.db, sessionId, toolName, trace);
    }
    /** Annotate pending failures with what the human said in the next turn. */
    attachHumanHint(sessionId, hint) {
        return attachHumanHint(this.db, sessionId, hint);
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
        // The shared library has no other caller for its zombie aging: without
        // this, a shared rule that is never recalled lives forever, and the
        // library can only ever grow. Retiring (not deleting) keeps it
        // recoverable, and the longer window respects that shared rules are
        // recalled more rarely than project ones.
        try {
            this.global()?.retireZombies(30 * 24 * 60 * 60 * 1000);
        }
        catch {
            // Aging the shared library is best-effort.
        }
    }
    exportable(minHits = 3) {
        return exportableAntibodies(this.db, minHits);
    }
    enqueueJob(tool, failure, success, injected, humanHint = '') {
        return enqueueJob(this.db, tool, failure, success, injected, humanHint);
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
        try {
            this.globalStore?.close();
        }
        catch {
            // already closed
        }
        this.db.close();
    }
}
