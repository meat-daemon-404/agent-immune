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
export function openDatabase(dbPath) {
    if (dbPath !== ':memory:')
        mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
        db.prepare('PRAGMA journal_mode = WAL').get();
    }
    db.prepare('PRAGMA busy_timeout = 5000').get();
    for (const statement of SCHEMA_STATEMENTS)
        db.prepare(statement).run();
    return db;
}
/** Default on-disk location for a store that was not given an explicit path. */
export function defaultDbPath(base) {
    return base ? resolve(base, 'immune.sqlite') : resolve(process.cwd(), '.dsh', 'immune.sqlite');
}
