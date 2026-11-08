import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDbPath } from './path.js';
import { openDatabase } from './open.js';
import { GlobalStore, globalDbPathFor, isPromotable } from './global.js';
import { rerank } from './rerank.js';
import { bumpMeta, readMeta } from './meta.js';
/** meta-table key for the value metric: repeats the plugin measurably prevented. */
export const SUPPRESSED_REPEATS_KEY = 'suppressed_repeats';
/** Runtime truth for the optional model path: rules it produced / times it degraded. */
export const LLM_SUCCESS_KEY = 'llm_distilled';
export const LLM_FALLBACK_KEY = 'llm_fallbacks';
import { bumpTurn, clearTurnState, readTurnState, recordTurnInjection, shouldSuppress, } from './turn-state.js';
import { bumpHits, exportableAntibodies, findMatches, insertAntibody, listAntibodies, penalizeAntibodies, removeAntibody, setAntibodyStatus, newestActiveId, pruneZombieAntibodies, retireZombieAntibodies, } from './antibodies.js';
import { claimFailure, hasPendingFailure, injectedIds, injectedPrescriptions, probeStreakCount, pruneStale, recordFailure, recordInjection, recordProbeOutcome, recordRepairAction, topProbeStreak, attachHumanHint, } from './episodes.js';
import { claimJob, claimJobs, enqueueJob, finishJob, pendingJobCount, requeueStuckJobs, } from './jobs.js';
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
        const id = insertAntibody(this.db, ab, {
            humanHint: opts.humanHint === true,
            fromLlm: opts.fromLlm === true,
        });
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
        // Retrieve wide, then rerank: BM25 answers "is the text related", not "is
        // this about the file I am touching right now".
        const wide = limit * 2;
        const sent = opts.excludeInjected && opts.sessionId
            ? new Set(injectedPrescriptions(this.db, opts.sessionId))
            : null;
        let own = findMatches(this.db, queryText, wide);
        if (opts.excludeInjected && opts.sessionId) {
            const seen = new Set(this.injectedIds(opts.sessionId));
            own = own.filter((r) => !seen.has(r.id));
        }
        // Shared-library candidates compete on the same terms, with a discount.
        const shared = [];
        const sharedIds = new Set();
        const delivered = new Set(own.map((r) => r.prescription));
        if (own.length < wide) {
            const global = this.global();
            if (global) {
                try {
                    const want = wide - own.length + (sent?.size ?? 0);
                    for (const candidate of global.match(queryText, want)) {
                        if (delivered.has(candidate.prescription))
                            continue;
                        if (sent?.has(candidate.prescription))
                            continue;
                        shared.push(candidate);
                        sharedIds.add(candidate.id);
                        delivered.add(candidate.prescription);
                        if (own.length + shared.length >= wide)
                            break;
                    }
                }
                catch {
                    // A broken shared library must not break the caller's turn.
                }
            }
        }
        const merged = [...own, ...shared];
        // Tool affinity is a TIE-BREAKER inside the retrieval order, not a
        // post-multiplier: two rules with near-identical text get near-arbitrary
        // bm25 positions, and a same-tool rule should win that tie. The stable
        // sort keeps retrieval order otherwise; the relevance spread stays the
        // dominant signal.
        const aff = (r) => opts.toolName && r.tool_name?.toLowerCase() === opts.toolName.toLowerCase() ? 0 : 1;
        const ordered = merged
            .map((r, i) => ({ r, i }))
            .sort((x, y) => aff(x.r) - aff(y.r) || x.i - y.i);
        const relevance = new Map(ordered.map((e, i) => [e.r.id, 1 / (1 + i)]));
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
            // the proof-of-generality the promotion rule asks for. isPromotable
            // judges the POST-bump count (>= 5), so pass hit_count + 1: the original
            // code fed the pre-bump count into that predicate, which made the whole
            // crossing check dead — nothing could ever promote at match time. The
            // >= form also lets pre-existing rules (hit counts already past the
            // threshold when promotion shipped) promote on their next injection;
            // GlobalStore.insert deduplicates by prescription, so repeated crossings
            // just count the shared copy's hits.
            const crossed = rankedOwn.filter((r) => r.hit_count + 1 >= 5 && isPromotable({ ...r, hit_count: r.hit_count + 1 }, false));
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
        if (rankedShared.length > 0) {
            try {
                this.global()?.countInjection(rankedShared.map((r) => r.id));
            }
            catch {
                // Counting is best-effort.
            }
        }
        if (opts.sessionId && (rankedOwn.length > 0 || rankedShared.length > 0)) {
            recordInjection(this.db, opts.sessionId, rankedOwn.map((r) => r.id), ranked.map((r) => r.prescription));
            if (opts.suppressRepeats)
                recordTurnInjection(this.db, opts.sessionId, rankedOwn.map((r) => r.id));
        }
        return ranked;
    }
    /** Record an injection that did not come through match() (session-start priming). */
    /** Whether an episode is open for this session (optionally: for this tool). */
    hasPendingFailure(sessionId, toolName) {
        return hasPendingFailure(this.db, sessionId, toolName);
    }
    /** Record one repair action for the session's open episodes (action diff). */
    recordRepairAction(sessionId, entry) {
        recordRepairAction(this.db, sessionId, entry);
    }
    /** Consecutive same-target probe count for this session. */
    probeStreakCount(sessionId, signature) {
        return probeStreakCount(this.db, sessionId, signature);
    }
    /** Strongest still-standing probe streak (DSH turn-start advisory). */
    topProbeStreak(sessionId, min = 3) {
        return topProbeStreak(this.db, sessionId, min);
    }
    /** Record a completed call as a probe (+1) or a streak reset (null). */
    recordProbeOutcome(sessionId, signature) {
        recordProbeOutcome(this.db, sessionId, signature);
    }
    recordInjection(sessionId, ids, prescriptions = []) {
        if (ids.length > 0)
            recordInjection(this.db, sessionId, ids, prescriptions);
    }
    /**
     * Forget this session's repeat-suppression history.
     *
     * Called on resume / clear / compact: those are new contexts, so a rule that
     * was suppressed before must be eligible again.
     */
    resetTurnState(sessionId) {
        clearTurnState(this.db, sessionId);
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
    recordFailure(sessionId, toolName, trace, targetSignature = '') {
        return recordFailure(this.db, sessionId, toolName, trace, targetSignature);
    }
    /** Annotate pending failures with what the human said in the next turn. */
    attachHumanHint(sessionId, hint) {
        return attachHumanHint(this.db, sessionId, hint);
    }
    claimFailure(sessionId, toolName, incoming) {
        return claimFailure(this.db, sessionId, toolName, incoming);
    }
    injectedIds(sessionId) {
        return injectedIds(this.db, sessionId);
    }
    penalize(ids, ctx) {
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
        }
        catch {
            // Aging the shared library is best-effort.
        }
        return counts;
    }
    exportable(minHits = 3) {
        return exportableAntibodies(this.db, minHits);
    }
    /**
     * Row counts by table plus the on-disk size of the database file. Feeds
     * `immune doctor` and the UI; lets retention be observed, not assumed.
     */
    stats() {
        const count = (sql, ...params) => {
            const row = this.db.prepare(sql).get(...params);
            return Number(row.n);
        };
        let dbBytes = null;
        try {
            dbBytes = statSync(this.dbPath).size;
        }
        catch {
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
            llmDistilled: readMeta(this.db, LLM_SUCCESS_KEY),
            llmFallbacks: readMeta(this.db, LLM_FALLBACK_KEY),
            dbBytes,
        };
    }
    enqueueJob(tool, failure, success, injected, humanHint = '', repairPath = []) {
        return enqueueJob(this.db, tool, failure, success, injected, humanHint, repairPath);
    }
    claimJob() {
        return claimJob(this.db);
    }
    /** Claim up to `count` pending jobs, for batch distillation. */
    claimJobs(count) {
        return claimJobs(this.db, count);
    }
    finishJob(id, status, note = '') {
        finishJob(this.db, id, status, note);
    }
    /** Bump a named meta counter (value metrics surfaced by stats/doctor). */
    bumpMeta(key, delta = 1) {
        return bumpMeta(this.db, key, delta);
    }
    /** Attach a note to a job without changing its status. */
    finishJobNote(id, note) {
        this.db
            .prepare('UPDATE distill_jobs SET note = ?, updated_at = ? WHERE id = ?')
            .run(note.slice(0, 400), Date.now(), id);
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
