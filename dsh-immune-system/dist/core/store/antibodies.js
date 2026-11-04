import { buildFtsQuery } from './tokenize.js';
import { isRelated } from '../relevance.js';
/** An antibody is retired after this many injected-but-still-failed episodes. */
export const RETIRE_AFTER_FAILURES = 3;
/** Insert a new antibody. Returns its id, or null when the input is unusable. */
export function insertAntibody(db, ab) {
    // Defensive caps: the model path clamps in prompts.ts, the rule path does not.
    // Without these, one bloated rule dominates every later injection.
    const trigger = ab.trigger_pattern.trim().slice(0, 200);
    const symptom = ab.symptom.trim().slice(0, 160);
    const prescription = ab.prescription.trim().slice(0, 200);
    if (!trigger || !prescription)
        return null;
    // De-duplicate on the prescription: it is the actionable part of the rule.
    const dupe = db
        .prepare('SELECT id FROM antibodies WHERE prescription = ? LIMIT 1')
        .get(prescription);
    if (dupe) {
        db.prepare('UPDATE antibodies SET updated_at = ? WHERE id = ?').run(Date.now(), dupe.id);
        return dupe.id;
    }
    const now = Date.now();
    const info = db
        .prepare(`INSERT INTO antibodies (trigger_pattern, symptom, prescription, tool_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`)
        .run(trigger, ab.symptom.trim(), prescription, ab.tool_name ?? null, now, now);
    return Number(info.lastInsertRowid);
}
/** Rank active antibodies against free text using bm25. */
export function findMatches(db, text, limit) {
    const ftsQuery = buildFtsQuery(text);
    if (!ftsQuery)
        return [];
    try {
        return db
            .prepare(`SELECT a.* FROM antibodies a
           JOIN antibodies_fts f ON a.id = f.rowid
          WHERE antibodies_fts MATCH ?
            AND a.status = 'active'
          ORDER BY bm25(antibodies_fts)
          LIMIT ?`)
            .all(ftsQuery, limit);
    }
    catch {
        // A malformed MATCH expression must never break the user's turn.
        return [];
    }
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
    return db.prepare(sql).all();
}
export function removeAntibody(db, id) {
    const info = db.prepare('DELETE FROM antibodies WHERE id = ?').run(id);
    return Number(info.changes) > 0;
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
 * Returns the antibodies retired by this call.
 */
export function penalizeAntibodies(db, ids, ctx) {
    if (ids.length === 0)
        return [];
    const retired = [];
    const now = Date.now();
    const bump = db.prepare('UPDATE antibodies SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?');
    for (const id of ids) {
        const before = db.prepare('SELECT * FROM antibodies WHERE id = ?').get(id);
        if (!before || before.status !== 'active')
            continue;
        if (ctx && !isRelated(before.trigger_pattern, ctx.failureText, ctx.toolName))
            continue;
        bump.run(now, id);
        if (before.fail_count + 1 < RETIRE_AFTER_FAILURES)
            continue;
        setAntibodyStatus(db, id, 'retired');
        retired.push({ ...before, status: 'retired', fail_count: before.fail_count + 1 });
    }
    return retired;
}
/** Antibodies worth sharing: proven by repeated successful injection. */
export function exportableAntibodies(db, minHits) {
    return db
        .prepare(`SELECT * FROM antibodies
        WHERE status = 'active' AND hit_count >= ?
        ORDER BY hit_count DESC, created_at DESC`)
        .all(minHits);
}
