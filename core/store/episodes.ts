import type { DatabaseSync } from 'node:sqlite';
import type { FailureSnapshot } from '../types.js';
import { redactAndClamp } from '../redact.js';

/** A failure is abandoned if no success follows within this window. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

/** Injected antibodies are only penalised for failures within this window. */
export const INJECTION_TTL_MS = 30 * 60 * 1000;

function parseIds(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

/** Remember which antibodies were injected on this session's current turn. */
export function recordInjection(db: DatabaseSync, sessionId: string, ids: number[]): void {
  db.prepare(
    `INSERT INTO session_injections (session_id, ids, created_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET ids = excluded.ids, created_at = excluded.created_at`,
  ).run(sessionId, JSON.stringify(ids), Date.now());
}

/** Antibody ids injected during the current turn of this session. */
export function injectedIds(db: DatabaseSync, sessionId: string): number[] {
  const row = db
    .prepare('SELECT ids, created_at FROM session_injections WHERE session_id = ?')
    .get(sessionId) as { ids: string; created_at: number } | undefined;
  if (!row) return [];
  if (Date.now() - row.created_at > INJECTION_TTL_MS) return [];
  return parseIds(row.ids);
}

/**
 * Record a failed tool call, capturing which antibodies were in context so they
 * can be penalised if they failed to prevent this.
 */
export function recordFailure(
  db: DatabaseSync,
  sessionId: string,
  toolName: string,
  trace: unknown,
): FailureSnapshot {
  const now = Date.now();
  const injected = injectedIds(db, sessionId);
  const snapshot: FailureSnapshot = {
    session_id: sessionId,
    tool_name: toolName,
    trace: redactAndClamp(trace),
    injected_ids: injected,
    created_at: now,
  };

  db.prepare(
    `INSERT INTO pending_failures (session_id, tool_name, trace, injected_ids, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, tool_name) DO UPDATE SET
       trace = excluded.trace,
       injected_ids = excluded.injected_ids,
       created_at = excluded.created_at`,
  ).run(sessionId, toolName, snapshot.trace, JSON.stringify(injected), now);

  return snapshot;
}

/**
 * Claim a pending failure for `toolName`, deleting it so one failure is only
 * ever paired once. Returns null when there is nothing to pair.
 */
export function claimFailure(
  db: DatabaseSync,
  sessionId: string,
  toolName: string,
): FailureSnapshot | null {
  pruneStale(db);
  const row = db
    .prepare('SELECT * FROM pending_failures WHERE session_id = ? AND tool_name = ?')
    .get(sessionId, toolName) as
    | { session_id: string; tool_name: string; trace: string; injected_ids: string; created_at: number }
    | undefined;
  if (!row) return null;

  db.prepare('DELETE FROM pending_failures WHERE session_id = ? AND tool_name = ?').run(
    sessionId,
    toolName,
  );

  return {
    session_id: row.session_id,
    tool_name: row.tool_name,
    trace: row.trace,
    injected_ids: parseIds(row.injected_ids),
    created_at: row.created_at,
  };
}

/** Drop pending failures and injection records older than the TTL. */
export function pruneStale(db: DatabaseSync, now = Date.now()): void {
  db.prepare('DELETE FROM pending_failures WHERE created_at < ?').run(now - PENDING_TTL_MS);
  db.prepare('DELETE FROM session_injections WHERE created_at < ?').run(now - INJECTION_TTL_MS);
}
