/**
 * Convergent-detour telemetry (ROADMAP 2.3b).
 *
 * A session that probes the same target 4+ times read-only before the
 * successful command lands has walked a detour; the row is a REVIEW
 * CANDIDATE — telemetry only. The deterministic path never mints a shortcut
 * rule from it: its advice would be the echoed command (AGENTS.md #28), so
 * minting stays on the LLM rewrite path (`immune rewrite`).
 */
import type { DatabaseSync } from 'node:sqlite';

export interface DetourRow {
  id: number;
  session_id: string;
  signature: string;
  probes: number;
  created_at: number;
}

/** Minimum same-target probes for a detour to be worth a row. */
export const DETOUR_MIN_PROBES = 4;

export function recordDetour(
  db: DatabaseSync,
  sessionId: string,
  signature: string,
  probes: number,
): void {
  db.prepare(
    'INSERT INTO detours (session_id, signature, probes, created_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, signature, probes, Date.now());
}

/** Newest rows first, for the CLI surface. */
export function recentDetours(db: DatabaseSync, limit = 20): DetourRow[] {
  return db
    .prepare('SELECT * FROM detours ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as DetourRow[];
}

export function detourCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM detours').get() as { n: number | bigint };
  return Number(row.n);
}

/** Rows older than a week are history; pruneStale reclaims them. */
export function pruneDetours(db: DatabaseSync, olderThanMs: number, now = Date.now()): number {
  const info = db
    .prepare('DELETE FROM detours WHERE created_at < ?')
    .run(now - olderThanMs);
  return Number(info.changes);
}
