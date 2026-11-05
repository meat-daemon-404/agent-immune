import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_STATEMENTS } from './schema.js';

/**
 * Open (and initialise) the immune database.
 *
 * WAL and a busy timeout matter here because several hook processes may open
 * the same file at nearly the same moment. Statements run one at a time so a
 * broken migration names the DDL that failed instead of a wall of SQL.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  if (dbPath !== ':memory:') {
    db.prepare('PRAGMA journal_mode = WAL').get();
  }
  db.prepare('PRAGMA busy_timeout = 5000').get();

  for (const statement of SCHEMA_STATEMENTS) db.prepare(statement).run();
  migrate(db);
  return db;
}

/**
 * Additive migrations for databases created by an earlier version.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a column added
 * to the schema would be missing on every pre-existing database and every query
 * touching it would fail. Each column is therefore checked and added
 * individually; nothing is ever dropped, so an older host keeps working.
 *
 * Table and column names here are compile-time constants, not user input.
 */
const COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'pending_failures', column: 'human_hint', ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: 'distill_jobs', column: 'human_hint', ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: 'session_injections', column: 'prescriptions', ddl: "TEXT NOT NULL DEFAULT '[]'" },
];

function migrate(db: DatabaseSync): void {
  for (const { table, column, ddl } of COLUMNS) {
    try {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
      if (info.some((row) => row.name === column)) continue;
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
    } catch {
      // A migration must never prevent the host from starting.
    }
  }
}

/** Default on-disk location for a store that was not given an explicit path. */
export function defaultDbPath(base?: string): string {
  return base ? resolve(base, 'immune.sqlite') : resolve(process.cwd(), '.dsh', 'immune.sqlite');
}
