/** Turns to stay quiet before an unchanged set is re-injected. */
export const SUPPRESS_WINDOW = 4;
export function readTurnState(db, sessionId) {
    const row = db
        .prepare('SELECT signature, turns FROM session_turns WHERE session_id = ?')
        .get(sessionId);
    return {
        signature: typeof row?.signature === 'string' ? row.signature : '',
        turns: typeof row?.turns === 'number' ? row.turns : 0,
    };
}
/** Record that this set was injected now (turn counter resets). */
export function recordTurnInjection(db, sessionId, ids) {
    const signature = signatureOf(ids);
    db.prepare(`INSERT INTO session_turns (session_id, signature, turns, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       signature = excluded.signature,
       turns = 0,
       updated_at = excluded.updated_at`).run(sessionId, signature, Date.now());
}
/** Count one suppressed turn. */
export function bumpTurn(db, sessionId) {
    const current = readTurnState(db, sessionId);
    const turns = current.turns + 1;
    db.prepare(`INSERT INTO session_turns (session_id, signature, turns, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       turns = excluded.turns,
       updated_at = excluded.updated_at`).run(sessionId, current.signature, turns, Date.now());
    return turns;
}
/** Forget the session's injection history (resume / clear / compact). */
export function clearTurnState(db, sessionId) {
    db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId);
}
/** Stable ascending-id signature, e.g. "2,8,15". */
export function signatureOf(ids) {
    return [...ids].sort((a, b) => a - b).join(',');
}
/**
 * Decide whether this turn's injection should be suppressed.
 *
 * Suppression requires an identical, non-empty signature AND fewer than
 * `SUPPRESS_WINDOW` turns since it was last delivered.
 */
export function shouldSuppress(state, candidateIds) {
    if (candidateIds.length === 0)
        return false;
    const signature = signatureOf(candidateIds);
    if (!signature)
        return false;
    return state.signature === signature && state.turns < SUPPRESS_WINDOW;
}
