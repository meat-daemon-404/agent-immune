import type { DatabaseSync } from 'node:sqlite';
import type { FailureSnapshot } from '../types.js';
import { redactAndClamp } from '../redact.js';
import { canCloseEpisode } from '../pairing.js';

/** A failure is abandoned if no success follows within this window. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

/** Injected antibodies are only penalised for failures within this window. */
export const INJECTION_TTL_MS = 30 * 60 * 1000;

/**
 * Terminal distill jobs (done/failed/skipped) are history: the antibody they
 * produced is already in the library, so the raw job rows only matter for
 * debugging. Keep a week, then let pruneStale reclaim the space.
 */
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Turn-state rows for sessions quiet for a week are dead sessions. */
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** What one pruneStale pass removed, for doctor output and tests. */
export interface PruneCounts {
  pendingFailures: number;
  sessionInjections: number;
  jobs: number;
  sessions: number;
  repairs: number;
}

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
  targetSignature = '',
): FailureSnapshot {
  const now = Date.now();
  const injected = injectedIds(db, sessionId);
  const snapshot: FailureSnapshot = {
    session_id: sessionId,
    tool_name: toolName,
    trace: redactAndClamp(trace),
    injected_ids: injected,
    human_hint: '',
    repair_path: [],
    created_at: now,
  };

  // A repeat failure keeps any hint already attached: the human explanation for
  // this failure may already have arrived, and it must not be wiped by a second
  // failing call in the same turn.
  db.prepare(
    `INSERT INTO pending_failures (session_id, tool_name, trace, injected_ids, target_signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, tool_name) DO UPDATE SET
       trace = excluded.trace,
       injected_ids = excluded.injected_ids,
       target_signature = excluded.target_signature,
       created_at = excluded.created_at`,
  ).run(sessionId, toolName, snapshot.trace, JSON.stringify(injected), targetSignature, now);

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

/** Whether any tool has an unclosed failure for this session. */
export function hasPendingFailure(db: DatabaseSync, sessionId: string, toolName?: string): boolean {
  const row = toolName
    ? db
        .prepare('SELECT 1 FROM pending_failures WHERE session_id = ? AND tool_name = ? LIMIT 1')
        .get(sessionId, toolName)
    : db.prepare('SELECT 1 FROM pending_failures WHERE session_id = ? LIMIT 1').get(sessionId);
  return row !== undefined;
}

/**
 * Record one repair action for the session's open episodes (the action-diff
 * between the failure and the closing success). One row per session, newest
 * last, capped at three — the distiller needs the shape of the fix, not a log.
 */
export function recordRepairAction(db: DatabaseSync, sessionId: string, entry: string): void {
  const clean = entry.trim().slice(0, 120);
  if (!clean) return;
  let actions: string[] = [];
  try {
    const parsed: unknown = JSON.parse(
      (db.prepare('SELECT actions FROM repair_actions WHERE session_id = ?').get(sessionId) as
        | { actions: string }
        | undefined)?.actions ?? '[]',
    );
    if (Array.isArray(parsed)) {
      actions = parsed.filter((v): v is string => typeof v === 'string');
    }
  } catch {
    actions = [];
  }
  actions.push(clean);
  if (actions.length > 3) actions = actions.slice(-3);
  db.prepare(
    `INSERT INTO repair_actions (session_id, actions, created_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET actions = excluded.actions, created_at = excluded.created_at`,
  ).run(sessionId, JSON.stringify(actions), Date.now());
}

function readRepairActions(db: DatabaseSync, sessionId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      (db.prepare('SELECT actions FROM repair_actions WHERE session_id = ?').get(sessionId) as
        | { actions: string }
        | undefined)?.actions ?? '[]',
    );
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Claim a pending failure for `toolName`, deleting it so one failure is only
 * ever paired once. Returns null when there is nothing to pair.
 */
/**
 * Claim a pending failure for `toolName`, deleting it so one failure is only
 * ever paired once.
 *
 * `incoming` is the successful call that might close the episode. When it is
 * a read-only probe, or aimed at a different target, the failure is LEFT
 * PENDING — a `git status` between an error and its real fix must not consume
 * the episode, and the same tool called on another file must not either.
 */
export function claimFailure(
  db: DatabaseSync,
  sessionId: string,
  toolName: string,
  incoming?: { signature: string; probeOnly: boolean },
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
        target_signature?: string;
        created_at: number;
      }
    | undefined;
  if (!row) return null;

  const failedSignature = typeof row.target_signature === 'string' ? row.target_signature : '';
  if (incoming && !canCloseEpisode(failedSignature, incoming)) return null;

  db.prepare('DELETE FROM pending_failures WHERE session_id = ? AND tool_name = ?').run(
    sessionId,
    toolName,
  );
  // The action-diff belongs to this episode wherever it closes: read and clear
  // the buffer even when the closing tool differs from the failing one.
  const repairPath = readRepairActions(db, sessionId);
  db.prepare('DELETE FROM repair_actions WHERE session_id = ?').run(sessionId);

  return {
    session_id: row.session_id,
    tool_name: row.tool_name,
    trace: row.trace,
    injected_ids: parseIds(row.injected_ids),
    human_hint: typeof row.human_hint === 'string' ? row.human_hint : '',
    repair_path: repairPath,
    created_at: row.created_at,
  };
}

/**
 * Drop expired rows before any episode pairing runs. Called on every episode
 * close, so the database cannot grow without bound even if the agent runs for
 * months: terminal distill jobs and dead sessions are reclaimed on a weekly
 * retention window, pending state on the tighter 30-minute TTLs.
 */
export function pruneStale(db: DatabaseSync, now = Date.now()): PruneCounts {
  const pendingFailures = db
    .prepare('DELETE FROM pending_failures WHERE created_at < ?')
    .run(now - PENDING_TTL_MS);
  const sessionInjections = db
    .prepare('DELETE FROM session_injections WHERE created_at < ?')
  .run(now - INJECTION_TTL_MS);
  const jobs = db
    .prepare(
      "DELETE FROM distill_jobs WHERE status IN ('done','failed','skipped') AND updated_at < ?",
    )
    .run(now - JOB_RETENTION_MS);
  const sessions = db
    .prepare('DELETE FROM session_turns WHERE updated_at < ?')
    .run(now - SESSION_RETENTION_MS);
  const repairs = db
    .prepare('DELETE FROM repair_actions WHERE created_at < ?')
    .run(now - PENDING_TTL_MS);
  return {
    pendingFailures: Number(pendingFailures.changes),
    sessionInjections: Number(sessionInjections.changes),
    jobs: Number(jobs.changes),
    sessions: Number(sessions.changes),
    repairs: Number(repairs.changes),
  };
}
