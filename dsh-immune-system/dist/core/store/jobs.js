export function enqueueJob(db, toolName, failureTrace, successTrace, injectedIds, humanHint = '', repairPath = [], origin = '') {
    const now = Date.now();
    const info = db
        .prepare(`INSERT INTO distill_jobs
         (tool_name, failure_trace, success_trace, injected_ids, human_hint, repair_path, origin, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(toolName, failureTrace, successTrace, JSON.stringify(injectedIds), humanHint, JSON.stringify(repairPath.slice(-3)), origin, now, now);
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
export function finishJob(db, id, status, note) {
    if (note === undefined) {
        // No note argument = leave the note alone: finishJobNote may have just
        // recorded a degradation reason the terminal status must not wipe.
        db.prepare('UPDATE distill_jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
        return;
    }
    db.prepare('UPDATE distill_jobs SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(status, note.slice(0, 400), Date.now(), id);
}
/** Newest jobs for telemetry (ROADMAP 3.3); read-only. */
export function listRecentJobs(db, limit = 500) {
    const rows = db
        .prepare('SELECT * FROM distill_jobs ORDER BY created_at DESC LIMIT ?')
        .all(limit);
    for (const row of rows) {
        try {
            const parsed = JSON.parse(String(row.repair_path ?? '[]'));
            row.repair_path = Array.isArray(parsed)
                ? parsed.filter((v) => typeof v === 'string')
                : [];
        }
        catch {
            row.repair_path = [];
        }
    }
    return rows;
}
/**
 * How long a 'running' claim may be silent before another drain may take it.
 *
 * A claim is only held for the life of one drain, and the drain aborts its
 * model calls at its own deadline — but `backfill --budget-ms` may legitimately
 * pass ten minutes, so a five-minute window let a hook's turn-end drain steal
 * jobs out from under a live backfill and distil the same episode twice. The
 * window must therefore exceed the largest legal budget (plus request
 * overhead), not the common one.
 */
export const STUCK_JOB_MS = 15 * 60 * 1000;
/** Recover jobs whose worker died mid-flight, so they are not lost forever. */
export function requeueStuckJobs(db, olderThanMs = STUCK_JOB_MS) {
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
