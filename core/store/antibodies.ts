import type { DatabaseSync } from 'node:sqlite';
import type { Antibody, AntibodyStatus, NewAntibody } from '../types.js';
import { buildFtsQuery, cjkBigrams } from './tokenize.js';
import { isRelated } from '../relevance.js';

/** An antibody is retired after this many injected-but-still-failed episodes. */
export const RETIRE_AFTER_FAILURES = 3;

/** Insert a new antibody. Returns its id, or null when the input is unusable. */
export function insertAntibody(db: DatabaseSync, ab: NewAntibody): number | null {
  // Defensive caps: the model path clamps in prompts.ts, the rule path does not.
  // Without these, one bloated rule dominates every later injection.
  const trigger = ab.trigger_pattern.trim().slice(0, 200);
  const symptom = ab.symptom.trim().slice(0, 160);
  const prescription = ab.prescription.trim().slice(0, 200);
  if (!trigger || !prescription) return null;

  // De-duplicate on the prescription: it is the actionable part of the rule.
  const dupe = db
    .prepare('SELECT id FROM antibodies WHERE prescription = ? LIMIT 1')
    .get(prescription) as { id: number } | undefined;
  if (dupe) {
    db.prepare('UPDATE antibodies SET updated_at = ? WHERE id = ?').run(Date.now(), dupe.id);
    return dupe.id;
  }

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO antibodies (trigger_pattern, symptom, prescription, tool_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(trigger, ab.symptom.trim(), prescription, ab.tool_name ?? null, now, now);
  return Number(info.lastInsertRowid);
}

/**
 * Rank active antibodies against free text.
 *
 * Two retrievers, merged:
 *   1. FTS5 trigram MATCH for terms of 3+ characters (ranked by bm25);
 *   2. a bound-parameter LIKE pass for 2-character CJK words, which trigram
 *      cannot index at all — without it "跨域" / "端口" / "权限" never match.
 *
 * Like-query values are bound, never interpolated, and only the number of
 * placeholders is generated (that count is derived from a bounded token list).
 */
export function findMatches(db: DatabaseSync, text: string, limit: number): Antibody[] {
  const rows: Antibody[] = [];
  const seen = new Set<number>();

  const ftsQuery = buildFtsQuery(text);
  if (ftsQuery) {
    try {
      const hits = db
        .prepare(
          `SELECT a.* FROM antibodies a
             JOIN antibodies_fts f ON a.id = f.rowid
            WHERE antibodies_fts MATCH ?
              AND a.status = 'active'
            ORDER BY bm25(antibodies_fts)
            LIMIT ?`,
        )
        .all(ftsQuery, limit) as unknown as Antibody[];
      for (const row of hits) {
        rows.push(row);
        seen.add(row.id);
      }
    } catch {
      // A malformed MATCH expression must never break the user's turn.
    }
  }

  if (rows.length >= limit) return rows.slice(0, limit);

  const bigrams = cjkBigrams(text);
  if (bigrams.length === 0) return rows;

  try {
    const clause = '(trigger_pattern LIKE ? OR symptom LIKE ? OR prescription LIKE ?)';
    const where = bigrams.map(() => clause).join(' OR ');
    const params: string[] = [];
    for (const gram of bigrams) {
      const needle = `%${gram}%`;
      params.push(needle, needle, needle);
    }

    const candidates = db
      .prepare(
        `SELECT * FROM antibodies
          WHERE status = 'active' AND (${where})
          ORDER BY hit_count DESC, created_at DESC
          LIMIT 24`,
      )
      .all(...params) as unknown as Antibody[];

    // Rank the LIKE hits by how many distinct words they contain, so an
    // antibody matching two concepts outranks one that merely shares a word.
    const scored = candidates
      .filter((row) => !seen.has(row.id))
      .map((row) => {
        const haystack = `${row.trigger_pattern} ${row.symptom} ${row.prescription}`;
        const score = bigrams.filter((gram) => haystack.includes(gram)).length;
        return { row, score };
      })
      .sort((a, b) => b.score - a.score || b.row.hit_count - a.row.hit_count);

    for (const entry of scored) {
      if (rows.length >= limit) break;
      rows.push(entry.row);
      seen.add(entry.row.id);
    }
  } catch {
    // The fallback is an optimisation; never let it cost the caller a turn.
  }

  return rows.slice(0, limit);
}

/** Bump hit counters for injected antibodies. */
export function bumpHits(db: DatabaseSync, ids: number[]): void {
  const stmt = db.prepare('UPDATE antibodies SET hit_count = hit_count + 1 WHERE id = ?');
  for (const id of ids) stmt.run(id);
}

export function listAntibodies(db: DatabaseSync, includeRetired = true): Antibody[] {
  const sql = includeRetired
    ? 'SELECT * FROM antibodies ORDER BY status ASC, hit_count DESC, created_at DESC'
    : "SELECT * FROM antibodies WHERE status = 'active' ORDER BY hit_count DESC, created_at DESC";
  return db.prepare(sql).all() as unknown as Antibody[];
}

export function removeAntibody(db: DatabaseSync, id: number): boolean {
  const info = db.prepare('DELETE FROM antibodies WHERE id = ?').run(id);
  return Number(info.changes) > 0;
}

export function setAntibodyStatus(db: DatabaseSync, id: number, status: AntibodyStatus): boolean {
  const info = db
    .prepare('UPDATE antibodies SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
  return Number(info.changes) > 0;
}

/**
 * Context used to decide whether a failure is plausibly this antibody's fault.
 * Without it every injected antibody is blamed for every later failure.
 */
export interface PenaltyContext {
  failureText: string;
  toolName: string;
}

/**
 * Anti-rot: an injected antibody that did not prevent the failure loses credit.
 * At RETIRE_AFTER_FAILURES it is retired so it stops being injected.
 *
 * With `ctx`, only antibodies whose trigger actually relates to the failure are
 * penalised — an unrelated failing command must not retire a good rule.
 * Returns the antibodies retired by this call.
 */
export function penalizeAntibodies(
  db: DatabaseSync,
  ids: number[],
  ctx?: PenaltyContext,
): Antibody[] {
  if (ids.length === 0) return [];
  const retired: Antibody[] = [];
  const now = Date.now();
  const bump = db.prepare(
    'UPDATE antibodies SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?',
  );

  for (const id of ids) {
    const before = db.prepare('SELECT * FROM antibodies WHERE id = ?').get(id) as
      | Antibody
      | undefined;
    if (!before || before.status !== 'active') continue;
    if (ctx && !isRelated(before.trigger_pattern, ctx.failureText, ctx.toolName)) continue;

    bump.run(now, id);
    if (before.fail_count + 1 < RETIRE_AFTER_FAILURES) continue;
    setAntibodyStatus(db, id, 'retired');
    retired.push({ ...before, status: 'retired', fail_count: before.fail_count + 1 });
  }
  return retired;
}

/** Antibodies worth sharing: proven by repeated successful injection. */
export function exportableAntibodies(db: DatabaseSync, minHits: number): Antibody[] {
  return db
    .prepare(
      `SELECT * FROM antibodies
        WHERE status = 'active' AND hit_count >= ?
        ORDER BY hit_count DESC, created_at DESC`,
    )
    .all(minHits) as unknown as Antibody[];
}

/** Id of the newest still-active antibody, or null when there is none. */
export function newestActiveId(db: DatabaseSync): number | null {
  const row = db
    .prepare("SELECT id FROM antibodies WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Delete "zombie" antibodies: never injected once, and old enough that they
 * are not simply waiting for their first recall.
 *
 * Returns the ids actually removed so the caller can report them.
 */
export function pruneZombieAntibodies(db: DatabaseSync, olderThanMs: number): number[] {
  const cutoff = Date.now() - olderThanMs;
  const rows = db
    .prepare(
      `SELECT id FROM antibodies
        WHERE status = 'active' AND hit_count = 0 AND created_at < ?`,
    )
    .all(cutoff) as Array<{ id: number }>;

  const removed: number[] = [];
  for (const row of rows) {
    if (removeAntibody(db, row.id)) removed.push(row.id);
  }
  return removed;
}
