/**
 * Cross-process counters and bookkeeping in one key-value table.
 *
 * Every hook is its own process, so anything the UI or doctor wants to report
 * has to live in the database, not module memory. Access is parameterized and
 * values are stored as text; read it back with `readMeta`.
 */
/** Increment (or initialise) a counter. Returns the new value. */
export function bumpMeta(db, key, delta = 1) {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`).run(key, String(delta), delta);
    return readMeta(db, key);
}
/** Read one key, defaulting to 0. */
export function readMeta(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? Number(row.value) : 0;
}
