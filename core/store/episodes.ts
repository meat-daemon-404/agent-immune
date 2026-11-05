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
export function recordInjection(
  db: DatabaseSync,
  sessionId: string,
  ids: number[],
  prescriptions: string[] = [],
): void {
  db.prepare(
    `INSERT INTO session_injections (session_id, ids, prescriptions, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       ids = excluded.ids,
       prescriptions = excluded.prescriptions,
       created_at = excluded.created_at`,
  ).run(sessionId, JSON.stringify(ids), JSON.stringify(prescriptions), Date.now());
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
 * Prescriptions delivered during the current turn.
 *
 * Shared-library rules have no stable id this database can reason about (their
 * ids come from another file), so they are deduplicated by prescription text.
 */
export function injectedPrescriptions(db: DatabaseSync, sessionId: string): string[] {
  const row = db
    .prepare('SELECT prescriptions, created_at FROM session_injections WHERE session_id = ?')
    .get(sessionId) as { prescriptions?: string; created_at: number } | undefined;
  if (!row) return [];
  if (Date.now() - row.created_at > INJECTION_TTL_MS) return [];
  try {
    const parsed: unknown = JSON.parse(row.prescriptions ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
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
    human_hint: '',
    created_at: now,
  };

  // A repeat failure keeps any hint already attached: the human explanation for
  // this failure may already have arrived, and it must not be wiped by a second
  // failing call in the same turn.
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
 * Attach the human's latest message to every un-hinted pending failure.
 *
 * Called when a NEW user turn starts. Because prompt capture happens before any
 * tool runs in that turn, every pending failure at this moment came from an
 * earlier turn — which is exactly the "agent failed, human explained, try again"
 * shape worth learning from.
 *
 * Returns how many rows were annotated.
 */
export function attachHumanHint(db: DatabaseSync, sessionId: string, hint: unknown): number {
  const text = redactAndClamp(hint, 400);
  if (!text) return 0;
  const info = db
    .prepare(
      `UPDATE pending_failures SET human_hint = ?
        WHERE session_id = ? AND human_hint = ''`,
    )
    .run(text, sessionId);
  return Number(info.changes);
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
    | {
        session_id: string;
        tool_name: string;
        trace: string;
        injected_ids: string;
        human_hint?: string;
        created_at: number;
      }
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
    human_hint: typeof row.human_hint === 'string' ? row.human_hint : '',
    created_at: row.created_at,
  };
}

/** Drop pending failures and injection records older than the TTL. */
export function pruneStale(db: DatabaseSync, now = Date.now()): void {
  db.prepare('DELETE FROM pending_failures WHERE created_at < ?').run(now - PENDING_TTL_MS);
  db.prepare('DELETE FROM session_injections WHERE created_at < ?').run(now - INJECTION_TTL_MS);
}
