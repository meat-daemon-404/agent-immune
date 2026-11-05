/**
 * Global antibody library.
 *
 * A per-project database keeps unrelated work from bleeding together, but it
 * also means every new project re-learns the same generic pitfalls (edit
 * conflicts, pnpm-vs-npm, Windows quoting). This layer lets an antibody that is
 * provably generic be shared.
 *
 * Design note — why two connections instead of `ATTACH DATABASE`:
 * SQLite documents that a transaction spanning attached databases is not atomic
 * under WAL, and this plugin opens the database from several short-lived hook
 * processes. Two independent connections keep each write a normal single-file
 * transaction; there is no cross-database transaction to lose. The cost is that
 * recall is two queries instead of one, which is irrelevant at this scale.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync as Database } from 'node:sqlite';
import { SCHEMA_STATEMENTS } from './schema.js';
import { openDatabase } from './open.js';
import { findMatches, insertAntibody, bumpHits, pruneZombieAntibodies, retireZombieAntibodies, } from './antibodies.js';
/** File name of the shared library next to the per-project database. */
export const GLOBAL_DB_FILE = 'global.sqlite';
/** Path of the global library that belongs to a given project database. */
export function globalDbPathFor(projectDbPath) {
    if (projectDbPath === ':memory:')
        return ':memory:';
    return join(dirname(projectDbPath), GLOBAL_DB_FILE);
}
/**
 * A structurally-identical store for the shared library.
 *
 * It reuses the same schema and the same match/insert helpers, so ranking and
 * de-duplication behave exactly as they do per project.
 */
export class GlobalStore {
    db;
    dbPath;
    constructor(dbPath) {
        this.dbPath = dbPath;
        if (dbPath !== ':memory:')
            this.db = openDatabase(dbPath);
        else {
            this.db = new Database(dbPath);
            for (const statement of SCHEMA_STATEMENTS)
                this.db.prepare(statement).run();
        }
    }
    static existsFor(projectDbPath) {
        const path = globalDbPathFor(projectDbPath);
        return path === ':memory:' ? false : existsSync(path);
    }
    insert(ab) {
        return insertAntibody(this.db, ab);
    }
    match(text, limit) {
        return findMatches(this.db, text, limit);
    }
    /**
     * Count an injection of a shared rule.
     *
     * Without this the shared library would be write-only: `findMatches` is a
     * pure read, so a shared rule could never accumulate hits, never satisfy any
     * hit-based rule, and never be pruned or retired.
     */
    countInjection(ids) {
        if (ids.length === 0)
            return;
        bumpHits(this.db, ids);
    }
    /** Drop shared rules that were never used and are old enough not to be new. */
    pruneZombies(olderThanMs) {
        return pruneZombieAntibodies(this.db, olderThanMs);
    }
    /** Retire them instead — reversible, and the safer default for sharing. */
    retireZombies(olderThanMs) {
        return retireZombieAntibodies(this.db, olderThanMs);
    }
    listAll(includeRetired = true) {
        const sql = includeRetired
            ? 'SELECT * FROM antibodies ORDER BY status ASC, hit_count DESC, created_at DESC'
            : "SELECT * FROM antibodies WHERE status = 'active' ORDER BY hit_count DESC, created_at DESC";
        return this.db.prepare(sql).all();
    }
    close() {
        this.db.close();
    }
}
/**
 * Whether an antibody deserves to be shared with every project.
 *
 * Two proofs of generality:
 *  - it came from the curated table (`generic` is true), which by definition
 *    carries no project-specific trigger; or
 *  - it names no project-shaped token (a file path, a module path) and has
 *    proven itself by repeated successful injection.
 */
export function isPromotable(antibody, generic) {
    if (generic)
        return true;
    const text = `${antibody.trigger_pattern} ${antibody.prescription}`;
    const mentionsPath = /[\\/]|\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|yml|yaml)\b/i.test(text);
    if (mentionsPath)
        return false;
    return (antibody.hit_count ?? 0) >= 5;
}
