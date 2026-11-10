/** Minimum same-target probes for a detour to be worth a row. */
export const DETOUR_MIN_PROBES = 4;
export function recordDetour(db, sessionId, signature, probes) {
    db.prepare('INSERT INTO detours (session_id, signature, probes, created_at) VALUES (?, ?, ?, ?)').run(sessionId, signature, probes, Date.now());
}
/** Newest rows first, for the CLI surface. */
export function recentDetours(db, limit = 20) {
    return db
        .prepare('SELECT * FROM detours ORDER BY created_at DESC LIMIT ?')
        .all(limit);
}
export function detourCount(db) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM detours').get();
    return Number(row.n);
}
/** Rows older than a week are history; pruneStale reclaims them. */
export function pruneDetours(db, olderThanMs, now = Date.now()) {
    const info = db
        .prepare('DELETE FROM detours WHERE created_at < ?')
        .run(now - olderThanMs);
    return Number(info.changes);
}
