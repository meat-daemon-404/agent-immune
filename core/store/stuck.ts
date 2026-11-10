/**
 * Stuck detection state (ROADMAP 1.5): how many consecutive times the same
 * target has failed in one session, and whether the diagnostic hypothesis was
 * already delivered.
 *
 * The table exists because every hook is its own process (AGENTS.md #4): the
 * streak survives across hook invocations only in SQLite. Rows age out with
 * the pending-failure TTL — a stuck episode is only actionable while its
 * failure is still pending anyway.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface StuckRow {
  fail_streak: number;
  hypothesized_at: number;
}

function readRow(db: DatabaseSync, sessionId: string, signature: string): StuckRow | null {
  const row = db
    .prepare('SELECT fail_streak, hypothesized_at FROM stuck_state WHERE session_id = ? AND signature = ?')
    .get(sessionId, signature) as { fail_streak?: number | bigint; hypothesized_at?: number | bigint } | undefined;
  if (!row) return null;
  return { fail_streak: Number(row.fail_streak ?? 0), hypothesized_at: Number(row.hypothesized_at ?? 0) };
}

/** Consecutive-failure count for this session + signature (0 when none). */
export function stuckStreak(db: DatabaseSync, sessionId: string, signature: string): number {
  return readRow(db, sessionId, signature)?.fail_streak ?? 0;
}

/** Whether the diagnostic hypothesis was already injected for this streak. */
export function wasHypothesized(db: DatabaseSync, sessionId: string, signature: string): boolean {
  return (readRow(db, sessionId, signature)?.hypothesized_at ?? 0) > 0;
}

/**
 * Count one failure against this signature's streak and return the new count.
 * Failures on other signatures do not reset it (two rakes can be stepped on in
 * alternation); a success clears the row (see clearStuck).
 */
export function recordStuckFailure(db: DatabaseSync, sessionId: string, signature: string): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO stuck_state (session_id, signature, fail_streak, hypothesized_at, created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)
     ON CONFLICT(session_id, signature) DO UPDATE SET
       fail_streak = fail_streak + 1,
       updated_at = excluded.updated_at`,
  ).run(sessionId, signature, now, now);
  return stuckStreak(db, sessionId, signature);
}

/** Mark the diagnostic hypothesis as delivered (fires exactly once per streak). */
export function markHypothesized(db: DatabaseSync, sessionId: string, signature: string): void {
  db.prepare(
    `UPDATE stuck_state SET hypothesized_at = ?, updated_at = ? WHERE session_id = ? AND signature = ?`,
  ).run(Date.now(), Date.now(), sessionId, signature);
}

/** A success (any close of the episode) ends the stuck state. */
export function clearStuck(db: DatabaseSync, sessionId: string, signature: string): void {
  db.prepare('DELETE FROM stuck_state WHERE session_id = ? AND signature = ?').run(sessionId, signature);
}

/** Age out stale rows — called from pruneStale with the pending TTL. */
export function pruneStuck(db: DatabaseSync, olderThanMs: number, now = Date.now()): number {
  const info = db
    .prepare('DELETE FROM stuck_state WHERE updated_at < ?')
    .run(now - olderThanMs);
  return Number(info.changes);
}
