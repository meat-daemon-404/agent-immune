import type { DatabaseSync } from 'node:sqlite';
import type { Antibody, AntibodyStatus, NewAntibody } from '../types.js';
import { buildFtsQuery, cjkBigrams } from './tokenize.js';
import { isRelated } from '../relevance.js';
import { prescriptionSimilarity } from '../similarity.js';
import { tokenize } from './tokenize.js';

/** An antibody is retired after this many injected-but-still-failed episodes. */
export const RETIRE_AFTER_FAILURES = 3;

/** Prescriptions at or above this similarity are the same rule. */
export const MERGE_THRESHOLD = 0.7;

/** Where a new rule came from; decides whether it may overwrite existing text. */
export interface InsertOptions {
  /** Distilled from a human correction — the highest-authority source. */
  humanHint?: boolean;
  /** Distilled by the model (as opposed to the deterministic rule path). */
  fromLlm?: boolean;
}

/** Escape a token for a bound LIKE value (the pattern part is constant). */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, '\\$&');
}

/**
 * Candidate rules that might be the same lesson in different words: the exact
 * trigger, plus any active rule whose trigger shares a token with the incoming
 * one. The old exact-equality net missed every paraphrase ("npm 装依赖" vs
 * "npm peer dependency ERESOLVE"), splitting one lesson into two rows.
 */
function findMergeCandidates(
  db: DatabaseSync,
  trigger: string,
): Array<{ id: number; trigger_pattern: string; prescription: string; symptom: string }> {
  const tokens = tokenize(trigger, 8);
  const clauses = ['trigger_pattern = ?'];
  const params: Array<string> = [trigger];
  for (const token of tokens) {
    clauses.push('trigger_pattern LIKE ? ESCAPE \'\\\'');
    params.push(`%${escapeLike(token)}%`);
  }
  return db
    .prepare(
      `SELECT id, trigger_pattern, prescription, symptom FROM antibodies
        WHERE status = 'active' AND (${clauses.join(' OR ')})
        LIMIT 25`,
    )
    .all(...params) as Array<{
    id: number;
    trigger_pattern: string;
    prescription: string;
    symptom: string;
  }>;
}

/**
 * Union the incoming trigger into the stored one, keeping every recall path
 * the rule has earned. Returns null unless the merge adds tokens AND the two
 * triggers already share at least one token (so unrelated text cannot fuse),
 * and the result still fits the 200-character cap.
 */
export function mergeTriggers(existing: string, incoming: string): string | null {
  const oldTokens = existing.split(/\s+/).filter(Boolean);
  const seen = new Set(oldTokens.map((t) => t.toLowerCase()));
  const added: string[] = [];
  for (const token of incoming.split(/\s+/).filter(Boolean)) {
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      added.push(token);
    }
  }
  if (added.length === 0) return null;
  const shares = incoming
    .split(/\s+/)
    .some((t) => oldTokens.some((o) => o.toLowerCase() === t.toLowerCase()));
  if (!shares) return null;
  const merged = [...oldTokens, ...added].join(' ');
  if (merged.length > 200) return null;
  return merged;
}

/**
 * Insert a new antibody, merging near-duplicates.
 *
 * Exact prescription equality is the cheap first check. Beyond that, a rule
 * whose prescription is ≥70% similar (character 3-gram Jaccard) to an existing
 * active rule with an overlapping trigger is the same lesson in different
 * words: inserting it would give the library two rows that say the same thing
 * and halve the observed hit count of each. On every merge the incoming
 * trigger's tokens are unioned into the stored trigger, so each paraphrase
 * widens the rule's recall surface instead of being thrown away.
 */
/** Parse the stored JSON action-diff into an array; tolerate legacy rows. */
function parseRepairPath(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToAntibody(row: Record<string, unknown>): Antibody {
  return { ...(row as unknown as Antibody), repair_path: parseRepairPath(row.repair_path) };
}

/** Normalise and cap an incoming action diff for storage. */
function toRepairJson(repairPath?: string[]): string {
  const actions = (repairPath ?? [])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, 120))
    .filter(Boolean)
    .slice(-3);
  return JSON.stringify(actions);
}

export function insertAntibody(
  db: DatabaseSync,
  ab: NewAntibody,
  options: InsertOptions = {},
): number | null {
  // Defensive caps: the model path clamps in prompts.ts, the rule path does not.
  // Without these, one bloated rule dominates every later injection.
  const trigger = ab.trigger_pattern.trim().slice(0, 200);
  const symptom = ab.symptom.trim().slice(0, 160);
  const prescription = ab.prescription.trim().slice(0, 200);
  if (!trigger || !prescription) return null;

  const now = Date.now();

  // 1. Exact prescription match.
  const exact = db
    .prepare('SELECT id, trigger_pattern FROM antibodies WHERE prescription = ? LIMIT 1')
    .get(prescription) as { id: number; trigger_pattern: string } | undefined;
  if (exact) {
    const merged = mergeTriggers(exact.trigger_pattern, trigger);
    if (merged) {
      db.prepare(
        'UPDATE antibodies SET trigger_pattern = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?',
      ).run(merged, now, exact.id);
      return exact.id;
    } else {
      db.prepare(
        'UPDATE antibodies SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?',
      ).run(now, exact.id);
      return exact.id;
    }
  } else {
    // 2. Near-duplicate: overlapping trigger, similar prescription.
    const candidates = findMergeCandidates(db, trigger);

    for (const candidate of candidates) {
      if (prescriptionSimilarity(candidate.prescription, prescription) < MERGE_THRESHOLD) continue;

      if (options.humanHint || options.fromLlm) {
        // A human correction or a model rewrite outranks the stored wording.
        const mergedTrigger = mergeTriggers(candidate.trigger_pattern, trigger);
        db.prepare(
          'UPDATE antibodies SET prescription = ?, symptom = ?, trigger_pattern = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?',
        ).run(
          prescription,
          symptom || candidate.symptom,
          mergedTrigger ?? candidate.trigger_pattern,
          now,
          candidate.id,
        );
      } else {
        const mergedTrigger = mergeTriggers(candidate.trigger_pattern, trigger);
        db.prepare(
          'UPDATE antibodies SET trigger_pattern = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?',
        ).run(mergedTrigger ?? candidate.trigger_pattern, now, candidate.id);
      }
      return candidate.id;
    }
  }

  const info = db
    .prepare(
      `INSERT INTO antibodies (trigger_pattern, symptom, prescription, tool_name, repair_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      trigger,
      ab.symptom.trim(),
      prescription,
      ab.tool_name ?? null,
      toRepairJson(ab.repair_path),
      now,
      now,
    );
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
      const raw = db
        .prepare(
          `SELECT a.* FROM antibodies a
             JOIN antibodies_fts f ON a.id = f.rowid
            WHERE antibodies_fts MATCH ?
              AND a.status = 'active'
            ORDER BY bm25(antibodies_fts)
            LIMIT ?`,
        )
        .all(ftsQuery, limit) as unknown as Array<Record<string, unknown>>;
      const hits = raw.map(rowToAntibody);
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

    const rawCandidates = db
      .prepare(
        `SELECT * FROM antibodies
          WHERE status = 'active' AND (${where})
          ORDER BY hit_count DESC, created_at DESC
          LIMIT 24`,
      )
      .all(...params) as unknown as Array<Record<string, unknown>>;
    const candidates = rawCandidates.map(rowToAntibody);

    // Rank the LIKE hits by how many distinct words they contain, so an
    // antibody matching two concepts outranks one that merely shares a word.
    //
    // NOTE: a "minimum 2 windows" gate was tried here and removed. It cannot
    // distinguish a legitimate recall ("怎么解决跨域" shares only 跨域 with the
    // rule) from a spurious one ("改一下这个文件" shares only 文件): both are one
    // window out of ~5, and length or ratio thresholds differ by one character.
    // Costing ~100 advisory characters on an occasional weak match is cheaper
    // than silently dropping a real one.
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
  return (db.prepare(sql).all() as unknown as Array<Record<string, unknown>>).map(rowToAntibody);
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
  const raw = db
    .prepare(
      `SELECT * FROM antibodies
        WHERE status = 'active' AND hit_count >= ?
        ORDER BY hit_count DESC, created_at DESC`,
    )
    .all(minHits) as unknown as Array<Record<string, unknown>>;
  return raw.map(rowToAntibody);
}

/** Id of the newest still-active antibody, or null when there is none. */
export function newestActiveId(db: DatabaseSync): number | null {
  const row = db
    .prepare("SELECT id FROM antibodies WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Retire "zombie" antibodies instead of deleting them.
 *
 * Preferred over deletion: zero hits does not prove a rule is worthless, only
 * that its trigger has not come up yet. Retirement stops it being injected —
 * the actual goal — while keeping the text recoverable if it turns out to
 * matter. Physical removal is available separately, deliberately.
 */
export function retireZombieAntibodies(db: DatabaseSync, olderThanMs: number): number[] {
  const cutoff = Date.now() - olderThanMs;
  const rows = db
    .prepare(
      `SELECT id FROM antibodies
        WHERE status = 'active' AND hit_count = 0 AND created_at < ?`,
    )
    .all(cutoff) as Array<{ id: number }>;

  const retired: number[] = [];
  for (const row of rows) {
    if (setAntibodyStatus(db, row.id, 'retired')) retired.push(row.id);
  }
  return retired;
}

/** Physically delete zombie antibodies. Only for an explicit "purge" request. */
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
