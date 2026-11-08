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
  // Generic key-value store for cross-process counters and bookkeeping (the
  // value metric lives here). One table, parameterized accessors only.
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Action-diff buffer (borrowed from the EMG idea): non-probe write actions
  // recorded between a failure and the retry that closes it, so the distiller
  // sees WHAT repaired the problem, not just that the retry succeeded. One row
  // per session, JSON array, pruned with the pending failure.
  `CREATE TABLE IF NOT EXISTS repair_actions (
    session_id TEXT PRIMARY KEY,
    actions    TEXT    NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  // Probe-thrash streaks: consecutive same-target read-only probes. The
  // PreToolUse hook warns once when the count reaches two (the incoming call
  // is the third), and any non-probe call resets the streak for the session.
  `CREATE TABLE IF NOT EXISTS probe_streaks (
    session_id TEXT    NOT NULL,
    signature  TEXT    NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, signature)
  )`,
  // Which model was driving when a rule was delivered, and whether that
  // delivery held. One row per (rule, model) keeps the table bounded by the
  // library size: the question it answers is "does this lesson survive a model
  // switch", which needs the pair, not a per-event log.
  `CREATE TABLE IF NOT EXISTS model_hits (
    rule_id    INTEGER NOT NULL,
    model      TEXT    NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 0,
    fails      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (rule_id, model)
  )`,
  // session_id -> model cache. The host records the model on its own usage
  // rows, not in the hook payload, so the first delivery of a session pays one
  // read-only lookup against the host database and every later one reads here.
  `CREATE TABLE IF NOT EXISTS session_models (
    session_id  TEXT PRIMARY KEY,
    model       TEXT NOT NULL,
    resolved_at INTEGER NOT NULL
  )`,
];
