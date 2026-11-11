import { looksEchoPrescription } from '../rewrite.js';
import { buildFtsQuery, cjkBigrams } from './tokenize.js';
import { isRelated } from '../relevance.js';
import { prescriptionSimilarity } from '../similarity.js';
import { tokenize } from './tokenize.js';
/** An antibody is retired after this many injected-but-still-failed episodes. */
export const RETIRE_AFTER_FAILURES = 3;
/**
 * …and only if that many failures is a real share of its deliveries.
 *
 * The count alone retired the best rules in production: #44 was injected 516
 * times and blamed 3 times (0.6%) and still lost its place, which is why 276
 * recent failures matched "known but not injected" rules. Three failures out of
 * five hundred is a rule working, not a rule rotting. A quarter of deliveries
 * is the bar; the junk rules that motivated anti-rot sat at 50%.
 */
export const RETIRE_FAILURE_RATE = 0.25;
/** True when the evidence says this rule is noise rather than occasionally unlucky. */
export function shouldRetire(hitCount, failCount) {
    if (failCount < RETIRE_AFTER_FAILURES)
        return false;
    const deliveries = Math.max(hitCount, failCount);
    return failCount >= deliveries * RETIRE_FAILURE_RATE;
}
/** Prescriptions at or above this similarity are the same rule. */
export const MERGE_THRESHOLD = 0.7;
/** Escape a token for a bound LIKE value (the pattern part is constant). */
function escapeLike(token) {
    return token.replace(/[\\%_]/g, '\\$&');
}
/**
 * Candidate rules that might be the same lesson in different words: the exact
 * trigger, plus any active rule whose trigger shares a token with the incoming
 * one. The old exact-equality net missed every paraphrase ("npm 装依赖" vs
 * "npm peer dependency ERESOLVE"), splitting one lesson into two rows.
 */
function findMergeCandidates(db, trigger) {
    const tokens = tokenize(trigger, 8);
    const clauses = ['trigger_pattern = ?'];
    const params = [trigger];
    for (const token of tokens) {
        clauses.push('trigger_pattern LIKE ? ESCAPE \'\\\'');
        params.push(`%${escapeLike(token)}%`);
    }
    return db
        .prepare(`SELECT id, trigger_pattern, prescription, symptom FROM antibodies
        WHERE status = 'active' AND (${clauses.join(' OR ')})
        LIMIT 25`)
        .all(...params);
}
/**
 * Union the incoming trigger into the stored one, keeping every recall path
 * the rule has earned. Returns null unless the merge adds tokens AND the two
 * triggers already share at least one token (so unrelated text cannot fuse),
 * and the result still fits the 200-character cap.
 */
export function mergeTriggers(existing, incoming) {
    const oldTokens = existing.split(/\s+/).filter(Boolean);
    const seen = new Set(oldTokens.map((t) => t.toLowerCase()));
    const added = [];
    for (const token of incoming.split(/\s+/).filter(Boolean)) {
        const key = token.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            added.push(token);
        }
    }
    if (added.length === 0)
        return null;
    const shares = incoming
        .split(/\s+/)
        .some((t) => oldTokens.some((o) => o.toLowerCase() === t.toLowerCase()));
    if (!shares)
        return null;
    const merged = [...oldTokens, ...added].join(' ');
    if (merged.length > 200)
        return null;
    return merged;
}
/**
 * Insert a new antibody, merging near-duplicates.
 *
 * Exact prescription equality is the cheap first check. Beyond that, a rule
 * whose prescription is ≥70% similar (character 3-gram Jaccard) to an existing
 * active rule with an overlapping trigger is the same lesson in different
 * words: inserting it would give the library two rows that say the same thing
 * and halve the observed hit count of each. On every merge the incoming
 * trigger's tokens are unioned into the stored trigger, so each paraphrase
 * widens the rule's recall surface instead of being thrown away.
 */
/** Parse the stored JSON action-diff into an array; tolerate legacy rows. */
function parseRepairPath(value) {
    if (Array.isArray(value))
        return value.filter((v) => typeof v === 'string');
    if (typeof value !== 'string' || !value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    }
    catch {
        return [];
    }
}
function rowToAntibody(row) {
    return { ...row, repair_path: parseRepairPath(row.repair_path) };
}
/** One rule by id, or null. Read-only. */
export function getAntibodyById(db, id) {
    const row = db.prepare('SELECT * FROM antibodies WHERE id = ?').get(id);
    return row ? rowToAntibody(row) : null;
}
/**
 * ROADMAP 2.2 — mutate an injected-but-still-failed rule into a refined child.
 *
 * The trigger is refined with the NEW episode's evidence tokens (mergeTriggers
 * keeps the old recall keys and appends the observed ones); the prescription is
 * NOT rewritten — that stays model-only (AGENTS.md #28). The parent is retired
 * (it was injected and still failed — the anti-rot verdict), recoverable via
 * `immune list --all`. Repair evidence is REQUIRED: a failure-only episode
 * cannot mutate either (AGENTS.md #24 — the flow that minted junk from the
 * literal retirement text).
 */
export function mutateRule(db, parentId, incomingTokens, evidence = {}) {
    const hasEvidence = (evidence.repairPath ?? []).length > 0 || Boolean(evidence.humanHint?.trim());
    if (!hasEvidence)
        return null;
    const parent = getAntibodyById(db, parentId);
    if (!parent || parent.status !== 'active')
        return null;
    const refined = mergeTriggers(parent.trigger_pattern, incomingTokens);
    if (!refined || refined === parent.trigger_pattern)
        return null;
    const now = Date.now();
    const info = db
        .prepare(`INSERT INTO antibodies
         (trigger_pattern, symptom, prescription, tool_name, repair_path, origin, parent_id, mutated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(refined, parent.symptom, parent.prescription, parent.tool_name, toRepairJson(evidence.repairPath), parent.origin ?? '', parentId, now, now, now);
    db.prepare("UPDATE antibodies SET status = 'retired', updated_at = ? WHERE id = ?").run(now, parentId);
    return Number(info.lastInsertRowid);
}
/** Normalise and cap an incoming action diff for storage. */
function toRepairJson(repairPath) {
    const actions = (repairPath ?? [])
        .filter((v) => typeof v === 'string')
        .map((v) => v.trim().slice(0, 120))
        .filter(Boolean)
        .slice(-3);
    return JSON.stringify(actions);
}
export function insertAntibody(db, ab, options = {}) {
    // Defensive caps: the model path clamps in prompts.ts, the rule path does not.
    // Without these, one bloated rule dominates every later injection.
    const trigger = ab.trigger_pattern.trim().slice(0, 200);
    const symptom = ab.symptom.trim().slice(0, 160);
    const prescription = ab.prescription.trim().slice(0, 200);
    if (!trigger || !prescription)
        return null;
    const now = Date.now();
    // 1. Exact prescription match.
    const exact = db
        .prepare('SELECT id, trigger_pattern FROM antibodies WHERE prescription = ? LIMIT 1')
        .get(prescription);
    if (exact) {
        const merged = mergeTriggers(exact.trigger_pattern, trigger);
        if (merged) {
            db.prepare('UPDATE antibodies SET trigger_pattern = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?').run(merged, now, exact.id);
            return exact.id;
        }
        else {
            db.prepare('UPDATE antibodies SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?').run(now, exact.id);
            return exact.id;
        }
    }
    else {
        // 2. Near-duplicate: overlapping trigger, similar prescription.
        const candidates = findMergeCandidates(db, trigger);
        for (const candidate of candidates) {
            if (prescriptionSimilarity(candidate.prescription, prescription) < MERGE_THRESHOLD)
                continue;
            if (options.humanHint || options.fromLlm) {
                // A human correction or a model rewrite outranks the stored wording.
                const mergedTrigger = mergeTriggers(candidate.trigger_pattern, trigger);
                db.prepare('UPDATE antibodies SET prescription = ?, symptom = ?, trigger_pattern = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?').run(prescription, symptom || candidate.symptom, mergedTrigger ?? candidate.trigger_pattern, now, candidate.id);
            }
            else {
                const mergedTrigger = mergeTriggers(candidate.trigger_pattern, trigger);
                db.prepare('UPDATE antibodies SET trigger_pattern = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?').run(mergedTrigger ?? candidate.trigger_pattern, now, candidate.id);
            }
            return candidate.id;
        }
    }
    const info = db
        .prepare(`INSERT INTO antibodies (trigger_pattern, symptom, prescription, tool_name, repair_path, origin, env_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(trigger, ab.symptom.trim(), prescription, ab.tool_name ?? null, toRepairJson(ab.repair_path), ab.origin ?? '', ab.env_fingerprint ?? '', now, now);
    const newId = Number(info.lastInsertRowid);
    // ROADMAP 3.1: the new environment just re-learned this lesson on its own —
    // a same-lesson probation rule is superseded_by_env_upgrade. Exact lesson
    // key (tool + symptom), the consolidation standard, nothing fuzzier.
    if (ab.env_fingerprint) {
        db.prepare(`UPDATE antibodies
          SET status = 'retired', retire_reason = 'superseded_by_env_upgrade', updated_at = ?
        WHERE status = 'active' AND probation_at > 0
          AND id != ?
          AND tool_name IS ?
          AND symptom = ?`).run(now, newId, ab.tool_name ?? null, ab.symptom.trim());
    }
    return newId;
}
/**
 * Rank active antibodies against free text.
 *
 * Two retrievers, merged:
 *   1. FTS5 trigram MATCH for terms of 3+ characters (ranked by bm25);
 *   2. a bound-parameter LIKE pass for 2-character CJK words, which trigram
 *      cannot index at all — without it "跨域" / "端口" / "权限" never match.
 *
 * Like-query values are bound, never interpolated, and only the number of
 * placeholders is generated (that count is derived from a bounded token list).
 */
export function findMatches(db, text, limit) {
    const rows = [];
    const seen = new Set();
    const ftsQuery = buildFtsQuery(text);
    if (ftsQuery) {
        try {
            const raw = db
                .prepare(`SELECT a.* FROM antibodies a
             JOIN antibodies_fts f ON a.id = f.rowid
            WHERE antibodies_fts MATCH ?
              AND a.status = 'active'
            ORDER BY bm25(antibodies_fts)
            LIMIT ?`)
                .all(ftsQuery, limit);
            const hits = raw.map(rowToAntibody);
            for (const row of hits) {
                rows.push(row);
                seen.add(row.id);
            }
        }
        catch {
            // A malformed MATCH expression must never break the user's turn.
        }
    }
    if (rows.length >= limit)
        return rows.slice(0, limit);
    const bigrams = cjkBigrams(text);
    if (bigrams.length === 0)
        return rows;
    try {
        const clause = '(trigger_pattern LIKE ? OR symptom LIKE ? OR prescription LIKE ?)';
        const where = bigrams.map(() => clause).join(' OR ');
        const params = [];
        for (const gram of bigrams) {
            const needle = `%${gram}%`;
            params.push(needle, needle, needle);
        }
        const rawCandidates = db
            .prepare(`SELECT * FROM antibodies
          WHERE status = 'active' AND (${where})
          ORDER BY hit_count DESC, created_at DESC
          LIMIT 24`)
            .all(...params);
        const candidates = rawCandidates.map(rowToAntibody);
        // Rank the LIKE hits by how many distinct words they contain, so an
        // antibody matching two concepts outranks one that merely shares a word.
        //
        // NOTE: a "minimum 2 windows" gate was tried here and removed. It cannot
        // distinguish a legitimate recall ("怎么解决跨域" shares only 跨域 with the
        // rule) from a spurious one ("改一下这个文件" shares only 文件): both are one
        // window out of ~5, and length or ratio thresholds differ by one character.
        // Costing ~100 advisory characters on an occasional weak match is cheaper
        // than silently dropping a real one.
        const scored = candidates
            .filter((row) => !seen.has(row.id))
            .map((row) => {
            const haystack = `${row.trigger_pattern} ${row.symptom} ${row.prescription}`;
            const score = bigrams.filter((gram) => haystack.includes(gram)).length;
            return { row, score };
        })
            .sort((a, b) => b.score - a.score || b.row.hit_count - a.row.hit_count);
        for (const entry of scored) {
            if (rows.length >= limit)
                break;
            rows.push(entry.row);
            seen.add(entry.row.id);
        }
    }
    catch {
        // The fallback is an optimisation; never let it cost the caller a turn.
    }
    return rows.slice(0, limit);
}
/** Bump hit counters for injected antibodies. */
export function bumpHits(db, ids) {
    const stmt = db.prepare('UPDATE antibodies SET hit_count = hit_count + 1 WHERE id = ?');
    for (const id of ids)
        stmt.run(id);
}
export function listAntibodies(db, includeRetired = true) {
    const sql = includeRetired
        ? 'SELECT * FROM antibodies ORDER BY status ASC, hit_count DESC, created_at DESC'
        : "SELECT * FROM antibodies WHERE status = 'active' ORDER BY hit_count DESC, created_at DESC";
    return db.prepare(sql).all().map(rowToAntibody);
}
export function removeAntibody(db, id) {
    // Attribution is keyed by rule id. Leaving it behind makes the per-model
    // totals count deliveries of a rule that no longer exists, and the numbers
    // only ever drift upward. Delete both in one transaction.
    let removed = false;
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM model_hits WHERE rule_id = ?').run(id);
        removed = Number(db.prepare('DELETE FROM antibodies WHERE id = ?').run(id).changes) > 0;
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    return removed;
}
export function setAntibodyStatus(db, id, status) {
    const info = db
        .prepare('UPDATE antibodies SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), id);
    return Number(info.changes) > 0;
}
/**
 * Anti-rot: an injected antibody that did not prevent the failure loses credit.
 * At RETIRE_AFTER_FAILURES it is retired so it stops being injected.
 *
 * With `ctx`, only antibodies whose trigger actually relates to the failure are
 * penalised — an unrelated failing command must not retire a good rule.
 * Returns the retired antibodies plus the ids that were actually penalised:
 * attribution has to credit exactly those, not every id that was in context.
 */
export function penalizeAntibodies(db, ids, ctx) {
    if (ids.length === 0)
        return { retired: [], penalized: [] };
    const retired = [];
    const penalized = [];
    const now = Date.now();
    const bump = db.prepare('UPDATE antibodies SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?');
    for (const id of ids) {
        const before = db.prepare('SELECT * FROM antibodies WHERE id = ?').get(id);
        if (!before || before.status !== 'active')
            continue;
        if (ctx && !isRelated(before.trigger_pattern, ctx.failureText, ctx.toolName))
            continue;
        bump.run(now, id);
        penalized.push(id);
        // The rate guard uses the counters as they will be after this penalty: a
        // rule is not retired for being unlucky three times in a thousand.
        if (!shouldRetire(before.hit_count, before.fail_count + 1))
            continue;
        setAntibodyStatus(db, id, 'retired');
        retired.push({ ...before, status: 'retired', fail_count: before.fail_count + 1 });
    }
    return { retired, penalized };
}
/** Antibodies worth sharing: proven by repeated successful injection. */
export function exportableAntibodies(db, minHits) {
    const raw = db
        .prepare(`SELECT * FROM antibodies
        WHERE status = 'active' AND hit_count >= ?
        ORDER BY hit_count DESC, created_at DESC`)
        .all(minHits);
    // The share quality bar (#39's line, extended to the two ship surfaces): a
    // rule whose prescription is a raw command dump does not travel — not into
    // the managed AGENTS.md block, not into a team SKILL.md. `immune rewrite`
    // is how an echo graduates onto these surfaces; the evidence suffix (#40)
    // counts as advice and keeps its eligibility.
    return raw
        .map(rowToAntibody)
        .filter((ab) => !looksEchoPrescription(ab.prescription));
}
/**
 * Replace one rule's prescription in place, keeping trigger, symptom and the
 * counters. Only `immune rewrite` calls this: the wording becomes advice while
 * the evidence that made the rule worth keeping stays intact.
 */
export function setPrescription(db, id, prescription, source) {
    const info = db
        .prepare(`UPDATE antibodies SET prescription = ?, prescription_source = ?, updated_at = ?
        WHERE id = ?`)
        .run(prescription.trim().slice(0, 200), source, Date.now(), id);
    return Number(info.changes) > 0;
}
/**
 * Consolidate duplicate rows into one proven rule in a single transaction.
 * The trigger union and all evidence survive; duplicates are retired so the
 * operation can be reviewed or restored from the dashboard later.
 */
export function consolidateAntibodies(db, keepId, input) {
    const tx = db.prepare('BEGIN');
    try {
        tx.run();
        db.prepare(`UPDATE antibodies SET trigger_pattern = ?, hit_count = ?, fail_count = ?,
        repair_path = ?, updated_at = ? WHERE id = ? AND status = 'active'`).run(input.trigger.slice(0, 200), input.hitCount, input.failCount, toRepairJson(input.repairs), Date.now(), keepId);
        if (input.retireIds.length > 0) {
            const placeholders = input.retireIds.map(() => '?').join(',');
            db.prepare(`UPDATE antibodies SET status = 'retired', updated_at = ?
          WHERE id IN (${placeholders}) AND status = 'active'`).run(Date.now(), ...input.retireIds);
            // Attribution belongs to the surviving rule; otherwise a model switch
            // would make a consolidated lesson appear to have no history.
            const move = db.prepare(`INSERT INTO model_hits (rule_id, model, hits, fails, updated_at)
          SELECT ?, model, SUM(hits), SUM(fails), MAX(updated_at) FROM model_hits
           WHERE rule_id IN (${placeholders}) GROUP BY model
          ON CONFLICT(rule_id, model) DO UPDATE SET
            hits = hits + excluded.hits, fails = fails + excluded.fails,
            updated_at = MAX(updated_at, excluded.updated_at)`);
            move.run(keepId, ...input.retireIds);
            // The rows were copied into the keeper above. Leaving them behind makes
            // one delivery count twice in every per-model total.
            db.prepare(`DELETE FROM model_hits WHERE rule_id IN (${placeholders})`).run(...input.retireIds);
        }
        db.prepare('COMMIT').run();
    }
    catch (error) {
        db.prepare('ROLLBACK').run();
        throw error;
    }
}
/** Id of the newest still-active antibody, or null when there is none. */
export function newestActiveId(db) {
    const row = db
        .prepare("SELECT id FROM antibodies WHERE status = 'active' ORDER BY id DESC LIMIT 1")
        .get();
    return row?.id ?? null;
}
/**
 * Retire "zombie" antibodies instead of deleting them.
 *
 * Preferred over deletion: zero hits does not prove a rule is worthless, only
 * that its trigger has not come up yet. Retirement stops it being injected —
 * the actual goal — while keeping the text recoverable if it turns out to
 * matter. Physical removal is available separately, deliberately.
 */
export function retireZombieAntibodies(db, olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    const rows = db
        .prepare(`SELECT id FROM antibodies
        WHERE status = 'active' AND hit_count = 0 AND created_at < ?`)
        .all(cutoff);
    const retired = [];
    for (const row of rows) {
        if (setAntibodyStatus(db, row.id, 'retired'))
            retired.push(row.id);
    }
    return retired;
}
/** Physically delete zombie antibodies. Only for an explicit "purge" request. */
export function pruneZombieAntibodies(db, olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    const rows = db
        .prepare(`SELECT id FROM antibodies
        WHERE status = 'active' AND hit_count = 0 AND created_at < ?`)
        .all(cutoff);
    const removed = [];
    for (const row of rows) {
        if (removeAntibody(db, row.id))
            removed.push(row.id);
    }
    return removed;
}
