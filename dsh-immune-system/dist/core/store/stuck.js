function readRow(db, sessionId, signature) {
    const row = db
        .prepare('SELECT fail_streak, hypothesized_at FROM stuck_state WHERE session_id = ? AND signature = ?')
        .get(sessionId, signature);
    if (!row)
        return null;
    return { fail_streak: Number(row.fail_streak ?? 0), hypothesized_at: Number(row.hypothesized_at ?? 0) };
}
/** Consecutive-failure count for this session + signature (0 when none). */
export function stuckStreak(db, sessionId, signature) {
    return readRow(db, sessionId, signature)?.fail_streak ?? 0;
}
/** Whether the diagnostic hypothesis was already injected for this streak. */
export function wasHypothesized(db, sessionId, signature) {
    return (readRow(db, sessionId, signature)?.hypothesized_at ?? 0) > 0;
}
/**
 * Count one failure against this signature's streak and return the new count.
 * Failures on other signatures do not reset it (two rakes can be stepped on in
 * alternation); a success clears the row (see clearStuck).
 */
export function recordStuckFailure(db, sessionId, signature) {
    const now = Date.now();
    db.prepare(`INSERT INTO stuck_state (session_id, signature, fail_streak, hypothesized_at, created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)
     ON CONFLICT(session_id, signature) DO UPDATE SET
       fail_streak = fail_streak + 1,
       updated_at = excluded.updated_at`).run(sessionId, signature, now, now);
    return stuckStreak(db, sessionId, signature);
}
/** Mark the diagnostic hypothesis as delivered (fires exactly once per streak). */
export function markHypothesized(db, sessionId, signature) {
    db.prepare(`UPDATE stuck_state SET hypothesized_at = ?, updated_at = ? WHERE session_id = ? AND signature = ?`).run(Date.now(), Date.now(), sessionId, signature);
}
/**
 * The strongest unresolved stuck row for a session (streak >= min, hypothesis
 * not yet delivered), or null. The DSH preStep uses it for turn-start
 * delivery — that host's PreToolDecision has no context channel, the same
 * constraint that keeps the guard's warn mode ZCode-only.
 */
export function topStuckRow(db, sessionId, minStreak) {
    const row = db
        .prepare(`SELECT signature, fail_streak FROM stuck_state
        WHERE session_id = ? AND fail_streak >= ? AND hypothesized_at = 0
        ORDER BY fail_streak DESC LIMIT 1`)
        .get(sessionId, minStreak);
    return row ? { signature: row.signature, failStreak: Number(row.fail_streak) } : null;
}
/**
 * The structured diagnostic hypothesis, shared verbatim by both delivery
 * surfaces (ZCode PreToolUse before the third attempt, DSH at turn start) so
 * the two hosts cannot drift into different advice.
 */
export function stuckHypothesisText(signature) {
    return ('同一目标连续失败两次且规则库无覆盖 / this target failed twice in a row with no covering rule. ' +
        `目标 / target: ${signature}. ` +
        '第 3 次尝试前先做一次最小化诊断：读报错第一行、查 --help 或版本、检查锁文件与环境变量，确认原因后再改参数重试。' +
        ' / Before the third attempt, run ONE minimal diagnostic first: read the first line of the error, ' +
        'check --help or versions, inspect the lockfile and env vars — confirm the cause, then retry with the fix.');
}
/** A success (any close of the episode) ends the stuck state. */
export function clearStuck(db, sessionId, signature) {
    db.prepare('DELETE FROM stuck_state WHERE session_id = ? AND signature = ?').run(sessionId, signature);
}
/** Age out stale rows — called from pruneStale with the pending TTL. */
export function pruneStuck(db, olderThanMs, now = Date.now()) {
    const info = db
        .prepare('DELETE FROM stuck_state WHERE updated_at < ?')
        .run(now - olderThanMs);
    return Number(info.changes);
}
