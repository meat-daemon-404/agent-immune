/**
 * Schema for the immune database, as individual statements.
 *
 * Statements are kept separate (rather than one multi-statement blob) so each
 * runs through `prepare().run()`; that keeps DDL portable and lets a failure
 * name the exact statement that broke.
 *
 * FTS5 uses the `trigram` tokenizer: antibody text is mixed Chinese and
 * English, and trigram supports CJK substring matching where `unicode61` would
 * treat a whole Chinese sentence as a single token.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS antibodies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_pattern TEXT    NOT NULL,
    symptom         TEXT    NOT NULL,
    prescription    TEXT    NOT NULL,
    hit_count       INTEGER NOT NULL DEFAULT 0,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'active',
    tool_name       TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS antibodies_fts USING fts5(
    trigger_pattern,
    symptom,
    prescription,
    content='antibodies',
    content_rowid='id',
    tokenize='trigram'
  )`,
  `CREATE TRIGGER IF NOT EXISTS antibodies_ai AFTER INSERT ON antibodies BEGIN
    INSERT INTO antibodies_fts(rowid, trigger_pattern, symptom, prescription)
    VALUES (new.id, new.trigger_pattern, new.symptom, new.prescription);
  END`,
  `CREATE TRIGGER IF NOT EXISTS antibodies_ad AFTER DELETE ON antibodies BEGIN
    INSERT INTO antibodies_fts(antibodies_fts, rowid, trigger_pattern, symptom, prescription)
    VALUES ('delete', old.id, old.trigger_pattern, old.symptom, old.prescription);
  END`,
  `CREATE TRIGGER IF NOT EXISTS antibodies_au AFTER UPDATE ON antibodies BEGIN
    INSERT INTO antibodies_fts(antibodies_fts, rowid, trigger_pattern, symptom, prescription)
    VALUES ('delete', old.id, old.trigger_pattern, old.symptom, old.prescription);
    INSERT INTO antibodies_fts(rowid, trigger_pattern, symptom, prescription)
    VALUES (new.id, new.trigger_pattern, new.symptom, new.prescription);
  END`,
  `CREATE TABLE IF NOT EXISTS pending_failures (
    session_id   TEXT    NOT NULL,
    tool_name    TEXT    NOT NULL,
    trace        TEXT    NOT NULL,
    injected_ids TEXT    NOT NULL DEFAULT '[]',
    human_hint   TEXT    NOT NULL DEFAULT '',
    target_signature TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (session_id, tool_name)
  )`,
  // Repeat suppression: what was injected last turn in this session, and how
  // many turns have passed without it changing.
  `CREATE TABLE IF NOT EXISTS session_turns (
    session_id TEXT    PRIMARY KEY,
    signature  TEXT    NOT NULL DEFAULT '',
    turns      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_injections (
    session_id    TEXT    PRIMARY KEY,
    ids           TEXT    NOT NULL,
    prescriptions TEXT    NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_antibodies_status ON antibodies(status, hit_count DESC)`,
  `CREATE TABLE IF NOT EXISTS distill_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name     TEXT    NOT NULL,
    failure_trace TEXT    NOT NULL,
    success_trace TEXT    NOT NULL,
    injected_ids  TEXT    NOT NULL DEFAULT '[]',
    human_hint    TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'pending',
    note          TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON distill_jobs(status, created_at)`,
];
