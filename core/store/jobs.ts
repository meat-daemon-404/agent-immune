import type { DatabaseSync } from 'node:sqlite';

/** A distillation job waiting for (or held by) the background worker. */
export interface DistillJob {
  id: number;
  tool_name: string;
  failure_trace: string;
  success_trace: string;
  injected_ids: string;
  human_hint?: string;
  status: string;
  note: string;
  created_at: number;
  updated_at: number;
}

export function enqueueJob(
  db: DatabaseSync,
  toolName: string,
  failureTrace: string,
  successTrace: string,
  injectedIds: number[],
  humanHint = '',
): number {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO distill_jobs
         (tool_name, failure_trace, success_trace, injected_ids, human_hint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(toolName, failureTrace, successTrace, JSON.stringify(injectedIds), humanHint, now, now);
  return Number(info.lastInsertRowid);
}

/**
 * Claim the oldest pending job atomically.
 *
 * A single UPDATE ... RETURNING is used so two workers racing on the same
 * database cannot both take the same job.
 */
export function claimJob(db: DatabaseSync): DistillJob | null {
  const row = db
    .prepare(
      `UPDATE distill_jobs SET status = 'running', updated_at = ?
        WHERE id = (
          SELECT id FROM distill_jobs WHERE status = 'pending'
           ORDER BY created_at ASC LIMIT 1
        )
        RETURNING *`,
    )
    .get(Date.now()) as DistillJob | undefined;
  return row ?? null;
}

export function finishJob(
  db: DatabaseSync,
  id: number,
  status: 'done' | 'failed' | 'skipped',
  note = '',
): void {
  db.prepare('UPDATE distill_jobs SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(
    status,
    note.slice(0, 400),
    Date.now(),
    id,
  );
}

/** Recover jobs whose worker died mid-flight, so they are not lost forever. */
export function requeueStuckJobs(db: DatabaseSync, olderThanMs = 5 * 60 * 1000): number {
  const info = db
    .prepare(
      `UPDATE distill_jobs SET status = 'pending', updated_at = ?
        WHERE status = 'running' AND updated_at < ?`,
    )
    .run(Date.now(), Date.now() - olderThanMs);
  return Number(info.changes);
}

export function pendingJobCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM distill_jobs WHERE status = 'pending'").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
