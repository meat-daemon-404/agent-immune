/**
 * Model attribution for rule deliveries.
 *
 * The hook payload does not carry a model name — ZCode sends session_id,
 * permission_mode, tool_name and the tool input, nothing else. The host does
 * record it, on every `model_usage` row (`session_id` + `model_id`), so the
 * first delivery of a session pays one read-only lookup against the host
 * database and caches the answer in `session_models`. Everything after that is
 * a primary-key read in our own database.
 *
 * Why bother: it turns "does this lesson survive a model switch" from an
 * opinion into a query — a rule delivered under two models is the evidence
 * that its prescription is a general action rather than one model's tic.
 * `IMMUNE_MODEL_NAME` overrides the lookup, which is what a non-ZCode host or
 * a test uses.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UNKNOWN_MODEL = 'unknown';

/**
 * Attribution is per delivery, not per session.
 *
 * Measured on the maintainer's own database: one session used
 * GLM-5.3-Flash 1395 times, auto/deepseek-v4.1-flash 1248 times and two others
 * in between — a user switches models inside a session. A long session-level
 * cache would credit every later delivery to whichever model happened to
 * answer first, so the answer is refreshed every 30 s (one small indexed read,
 * well under a hook's time budget) instead of being kept for the session.
 */
const REFRESH_MS = 30 * 1000;
const MODEL_MAX = 80;

export interface ModelRow {
  model: string;
  hits: number;
  fails: number;
  /** Distinct rules delivered under this model. */
  rules: number;
}

/** Where the host keeps model usage. Only the default is ZCode's. */
export function hostDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.IMMUNE_HOST_DB?.trim() || join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

/**
 * The model that served the most recent request of this session.
 *
 * Returns '' when the host database is absent, encrypted, locked or has no
 * usage row yet — the caller stores `unknown` and asks again later. Every
 * failure path is swallowed on purpose: attribution must never break a hook.
 */
export function lookupHostModel(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.IMMUNE_MODEL_NAME?.trim();
  if (explicit) return explicit.slice(0, MODEL_MAX);
  if (!sessionId) return '';

  const path = hostDbPath(env);
  if (!existsSync(path)) return '';

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db
      .prepare(
        `SELECT model_id FROM model_usage
          WHERE session_id = ? AND model_id <> ''
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sessionId) as { model_id?: string } | undefined;
    return (row?.model_id ?? '').slice(0, MODEL_MAX);
  } catch {
    return '';
  } finally {
    try {
      db?.close();
    } catch {
      // A closed handle costs nothing; an exception here would be noise.
    }
  }
}

/** Resolve and cache the model for a session. Always returns a usable label. */
export function resolveModel(
  db: DatabaseSync,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string {
  if (!sessionId) return UNKNOWN_MODEL;

  const row = db
    .prepare('SELECT model, resolved_at FROM session_models WHERE session_id = ?')
    .get(sessionId) as { model: string; resolved_at: number } | undefined;
  if (row && now - row.resolved_at < REFRESH_MS) return row.model;

  const found = lookupHostModel(sessionId, env) || UNKNOWN_MODEL;
  db.prepare(
    `INSERT INTO session_models (session_id, model, resolved_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET model = excluded.model, resolved_at = excluded.resolved_at`,
  ).run(sessionId, found, now);
  return found;
}

/** Count one delivery of each rule under this model. */
export function recordModelHits(
  db: DatabaseSync,
  model: string,
  ruleIds: number[],
  now = Date.now(),
): void {
  if (ruleIds.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO model_hits (rule_id, model, hits, fails, updated_at) VALUES (?, ?, 1, 0, ?)
     ON CONFLICT(rule_id, model) DO UPDATE SET
       hits = hits + 1,
       updated_at = excluded.updated_at`,
  );
  for (const id of ruleIds) stmt.run(id, model, now);
}

/** Count a delivery that did not prevent the failure (anti-rot penalty). */
export function recordModelFails(
  db: DatabaseSync,
  model: string,
  ruleIds: number[],
  now = Date.now(),
): void {
  if (ruleIds.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO model_hits (rule_id, model, hits, fails, updated_at) VALUES (?, ?, 0, 1, ?)
     ON CONFLICT(rule_id, model) DO UPDATE SET
       fails = fails + 1,
       updated_at = excluded.updated_at`,
  );
  for (const id of ruleIds) stmt.run(id, model, now);
}

/** Per-model totals, busiest first. */
export function modelBreakdown(db: DatabaseSync): ModelRow[] {
  const rows = db
    .prepare(
      `SELECT model, SUM(hits) AS hits, SUM(fails) AS fails, COUNT(*) AS rules
         FROM model_hits
        GROUP BY model
        ORDER BY hits DESC, model ASC`,
    )
    .all() as Array<{ model: string; hits: number; fails: number; rules: number }>;
  return rows.map((r) => ({
    model: r.model,
    hits: Number(r.hits),
    fails: Number(r.fails),
    rules: Number(r.rules),
  }));
}

/**
 * Rules proven under more than one model. This is the measurable form of
 * "the prescription is general": the same trigger recalled and held while a
 * different model was driving.
 */
export function crossModelRuleCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT rule_id FROM model_hits
          WHERE model <> ?
          GROUP BY rule_id HAVING COUNT(DISTINCT model) > 1
       )`,
    )
    .get(UNKNOWN_MODEL) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}
