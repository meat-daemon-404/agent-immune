/**
 * Repeat-suppression state, one row per session.
 *
 * The problem this solves: asking several questions in a row about the same
 * file recalls the same rules every turn. Re-injecting an identical block costs
 * context and inflates `hit_count`, which is the number that drives promotion
 * and anti-rot retirement — so repeats make the library's own statistics lie.
 *
 * The rule: if the candidate set is byte-identical to last turn's and fewer than
 * `SUPPRESS_WINDOW` turns have passed, skip the injection and keep the counter
 * moving instead of counting a hit.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Turns to stay quiet before an unchanged set is re-injected. */
export const SUPPRESS_WINDOW = 4;

export interface TurnState {
  signature: string;
  turns: number;
}

export function readTurnState(db: DatabaseSync, sessionId: string): TurnState {
  const row = db
    .prepare('SELECT signature, turns FROM session_turns WHERE session_id = ?')
    .get(sessionId) as { signature?: string; turns?: number } | undefined;
  return {
    signature: typeof row?.signature === 'string' ? row.signature : '',
    turns: typeof row?.turns === 'number' ? row.turns : 0,
  };
}

/** Record that this set was injected now (turn counter resets). */
export function recordTurnInjection(db: DatabaseSync, sessionId: string, ids: number[]): void {
  const signature = signatureOf(ids);
  db.prepare(
    `INSERT INTO session_turns (session_id, signature, turns, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       signature = excluded.signature,
       turns = 0,
       updated_at = excluded.updated_at`,
  ).run(sessionId, signature, Date.now());
}

/** Count one suppressed turn. */
export function bumpTurn(db: DatabaseSync, sessionId: string): number {
  const current = readTurnState(db, sessionId);
  const turns = current.turns + 1;
  db.prepare(
    `INSERT INTO session_turns (session_id, signature, turns, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       turns = excluded.turns,
       updated_at = excluded.updated_at`,
  ).run(sessionId, current.signature, turns, Date.now());
  return turns;
}

/** Forget the session's injection history (resume / clear / compact). */
export function clearTurnState(db: DatabaseSync, sessionId: string): void {
  db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId);
}

/** Stable ascending-id signature, e.g. "2,8,15". */
export function signatureOf(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}

/**
 * Decide whether this turn's injection should be suppressed.
 *
 * Suppression requires an identical, non-empty signature AND fewer than
 * `SUPPRESS_WINDOW` turns since it was last delivered.
 */
export function shouldSuppress(
  state: TurnState,
  candidateIds: number[],
): boolean {
  if (candidateIds.length === 0) return false;
  const signature = signatureOf(candidateIds);
  if (!signature) return false;
  return state.signature === signature && state.turns < SUPPRESS_WINDOW;
}
