export function enqueueJob(db, toolName, failureTrace, successTrace, injectedIds, humanHint = '', repairPath = []) {
    const now = Date.now();
    const info = db
        .prepare(`INSERT INTO distill_jobs
         (tool_name, failure_trace, success_trace, injected_ids, human_hint, repair_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(toolName, failureTrace, successTrace, JSON.stringify(injectedIds), humanHint, JSON.stringify(repairPath.slice(-3)), now, now);
    return Number(info.lastInsertRowid);
}
/**
 * Claim the oldest pending job atomically.
 *
 * A single UPDATE ... RETURNING is used so two workers racing on the same
 * database cannot both take the same job.
 */
export function claimJob(db) {
    const row = db
        .prepare(`UPDATE distill_jobs SET status = 'running', updated_at = ?
        WHERE id = (
          SELECT id FROM distill_jobs WHERE status = 'pending'
           ORDER BY created_at ASC LIMIT 1
        )
        RETURNING *`)
        .get(Date.now());
    if (!row)
        return null;
    // The column stores JSON text; surface it as an array like the antibodies do.
    try {
        const parsed = JSON.parse(String(row.repair_path ?? '[]'));
        row.repair_path = Array.isArray(parsed)
            ? parsed.filter((v) => typeof v === 'string')
            : [];
    }
    catch {
        row.repair_path = [];
    }
    return row;
}
/**
 * Claim up to `count` pending jobs atomically.
 *
 * One statement per claim keeps the race posture of `claimJob`; batching is the
 * caller's concern so a partial claim is still safe.
 */
export function claimJobs(db, count) {
    const out = [];
    const wanted = Math.max(1, Math.min(count, 16));
    for (let i = 0; i < wanted; i += 1) {
        const job = claimJob(db);
        if (!job)
            break;
        out.push(job);
    }
    return out;
}
export function finishJob(db, id, status, note = '') {
    db.prepare('UPDATE distill_jobs SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(status, note.slice(0, 400), Date.now(), id);
}
/** Recover jobs whose worker died mid-flight, so they are not lost forever. */
export function requeueStuckJobs(db, olderThanMs = 5 * 60 * 1000) {
    const info = db
        .prepare(`UPDATE distill_jobs SET status = 'pending', updated_at = ?
        WHERE status = 'running' AND updated_at < ?`)
        .run(Date.now(), Date.now() - olderThanMs);
    return Number(info.changes);
}
export function pendingJobCount(db) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM distill_jobs WHERE status = 'pending'").get();
    return row?.n ?? 0;
}
