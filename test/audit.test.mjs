import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';
import { auditHistory } from '../dsh-immune-system/dist/core/audit.js';

function store() {
  return new ImmuneStore({ dbPath: ':memory:' });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Build a minimal ZCode session db: tool_usage + part + model_usage rows. */
function zcodeFixture(dbPath, { command, errorText }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE tool_usage (session_id TEXT, tool_call_id TEXT, tool_name TEXT,
    status TEXT, error_message TEXT, started_at INTEGER);
    CREATE TABLE part (session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE model_usage (status TEXT, computed_total_tokens INTEGER, started_at INTEGER)`);
  const now = Date.now();
  const session = 'sess_audit_z';
  const call = (id, tool, status, error, cmd) => {
    db.prepare(
      'INSERT INTO tool_usage VALUES (?, ?, ?, ?, ?, ?)',
    ).run(session, id, tool, status, error, now - 60_000);
    db.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
      session,
      JSON.stringify({ type: 'tool', callID: id, state: { input: { command: cmd }, output: '' } }),
      now - 60_000,
    );
  };
  call('c1', 'Bash', 'error', errorText, command);
  call('c2', 'Bash', 'error', errorText, command);
  call('c3', 'Edit', 'completed', null, null);
  db.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
    session,
    JSON.stringify({ type: 'tool', callID: 'c3', state: { input: { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' } } }),
    now - 59_000,
  );
  call('c4', 'Bash', 'completed', null, command);
  for (let i = 0; i < 30; i += 1) {
    db.prepare('INSERT INTO model_usage VALUES (?, ?, ?)').run('completed', 2_000 + i, now - i * 1_000);
  }
  db.close();
}

test('audit replays ZCode history into pairing stats, families and a token median', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-audit-'));
  const dbPath = join(dir, 'db.sqlite');
  zcodeFixture(dbPath, { command: 'npm run build', errorText: 'npm ERR! missing script: build\nmore' });
  const s = store();
  const report = auditHistory(s, { days: 30, source: 'zcode', sourceDb: dbPath });
  const z = report.sources.find((source) => source.source === 'zcode');
  assert.equal(z.present, true);
  assert.equal(z.scanned, 4, '3 Bash + 1 Edit');
  assert.equal(z.failures, 2);
  assert.equal(z.paired, 1, 'second identical failure supersedes the first');
  assert.equal(z.superseded, 1);
  assert.equal(z.enqueued, 1);
  assert.equal(s.pendingJobCount(), 1, 'episode actually enqueued');
  const bash = z.byTool.find((row) => row.tool === 'Bash');
  assert.deepEqual([bash.scanned, bash.failures, bash.paired], [3, 2, 1]);
  assert.equal(z.byTool.find((row) => row.tool === 'Edit').paired, 0);
  assert.deepEqual(z.topFailures, [
    { tool: 'Bash', error: 'npm ERR! missing script: build', count: 2 },
  ], 'the repeated error forms one reportable family');
  assert.equal(z.medianRequestTokens, 2015, 'median of the 30 seeded usage rows');
  s.close();
});

function codexFixture(dir) {
  const now = new Date();
  const dayDir = join(dir, '.codex', 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  mkdirSync(dayDir, { recursive: true });
  const ts = new Date(now.getTime() - 60_000).toISOString();
  const line = (payload) => `${JSON.stringify({ timestamp: ts, type: 'response_item', payload })}\n`;
  writeFileSync(
    join(dayDir, 'rollout-audit-fixture.jsonl'),
    `${line({ type: 'function_call', call_id: 'k1', name: 'shell_command', arguments: '{"command": "tsc -p ."}' })}` +
      `${line({ type: 'function_call_output', call_id: 'k1', output: 'Exit code: 1\nerror TS2304: Cannot find name' })}` +
      `${line({ type: 'function_call', call_id: 'k2', name: 'apply_patch', arguments: '*** Begin Patch' })}` +
      `${line({ type: 'function_call_output', call_id: 'k2', output: 'Success. Updated the following files:\nM a.ts' })}` +
      `${line({ type: 'function_call', call_id: 'k3', name: 'shell_command', arguments: '{"command": "tsc -p ."}' })}` +
      `${line({ type: 'function_call_output', call_id: 'k3', output: 'Exit code: 0\n' })}`,
    'utf8',
  );
  return dayDir;
}

test('audit parses Codex rollouts: exit codes, apply_patch as repair, tool mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-audit-'));
  codexFixture(dir);
  const s = store();
  const report = auditHistory(s, { days: 30, source: 'codex', codexSessionsDir: join(dir, '.codex', 'sessions') });
  const cx = report.sources.find((source) => source.source === 'codex');
  assert.equal(cx.present, true);
  assert.equal(cx.scanned, 3, 'two shell_command + one apply_patch');
  assert.equal(cx.failures, 1);
  assert.equal(cx.paired, 1, 'failed tsc, patch, then clean tsc closes the episode');
  assert.equal(cx.enqueued, 1);
  const bash = cx.byTool.find((row) => row.tool === 'Bash');
  const edit = cx.byTool.find((row) => row.tool === 'Edit');
  assert.deepEqual([bash.failures, bash.paired], [1, 1]);
  assert.equal(edit.paired, 0, 'paired counts the closing tool; the patch rides in repair_path');
  assert.equal(cx.medianRequestTokens, null, 'codex rollouts carry no usage samples yet');
  s.close();
});

test('audit skips Codex day directories older than the window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-audit-'));
  const sessionsRoot = join(dir, '.codex', 'sessions');
  codexFixture(dir);
  const old = new Date(Date.now() - 90 * 86_400_000);
  const oldDir = join(sessionsRoot, String(old.getFullYear()), pad(old.getMonth() + 1), pad(old.getDate()));
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'rollout-old.jsonl'), '{"type":"response_item"}\n', 'utf8');
  const s = store();
  const report = auditHistory(s, { days: 30, source: 'codex', codexSessionsDir: sessionsRoot });
  const cx = report.sources.find((source) => source.source === 'codex');
  assert.equal(cx.scanned, 3, 'the 30-day-old directory is pruned by path date');
  s.close();
});

function claudeFixture(dir) {
  const projDir = join(dir, '.claude', 'projects', 'D--proj');
  mkdirSync(projDir, { recursive: true });
  const t = Date.now() - 60_000;
  const iso = (ms) => new Date(ms).toISOString();
  const line = (record) => `${JSON.stringify(record)}\n`;
  writeFileSync(
    join(projDir, 's1.jsonl'),
    line({ type: 'assistant', timestamp: iso(t), message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } }) +
      line({ type: 'user', timestamp: iso(t + 500), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'npm ERR! Test failed' }] } }) +
      line({ type: 'assistant', timestamp: iso(t + 1000), message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/x/a.ts' } }] } }) +
      line({ type: 'user', timestamp: iso(t + 1500), message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } }) +
      line({ type: 'assistant', timestamp: iso(t + 2000), message: { usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'npm test' } }] } }) +
      line({ type: 'user', timestamp: iso(t + 2500), message: { content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'passed' }] } }),
    'utf8',
  );
  return projDir;
}

test('audit parses Claude Code transcripts (fixture-tested parser)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-audit-'));
  claudeFixture(dir);
  const s = store();
  const report = auditHistory(s, { days: 30, source: 'claude-code', claudeProjectsDir: join(dir, '.claude', 'projects') });
  const cc = report.sources.find((source) => source.source === 'claude-code');
  assert.equal(cc.present, true);
  assert.equal(cc.scanned, 3, 'tu1-tu3 are the only tool calls');
  assert.equal(cc.failures, 1);
  assert.equal(cc.paired, 1, 'failed npm test, Edit, then passing npm test');
  assert.equal(cc.enqueued, 1);
  assert.ok(cc.note.includes('fixture-tested'), 'the unverified-parser note ships in the report');
  assert.equal(cc.medianRequestTokens, null, 'one usage sample is below the median bar');
  s.close();
});

test('audit dry-run enqueues nothing; max caps the enqueue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-audit-'));
  const dbPath = join(dir, 'db.sqlite');
  zcodeFixture(dbPath, { command: 'npm run build', errorText: 'npm ERR! missing script: build\nmore' });
  const s = store();
  const dry = auditHistory(s, { days: 30, source: 'zcode', sourceDb: dbPath, dryRun: true });
  assert.equal(dry.sources[0].enqueued, 1, 'the episode is counted, not stored');
  assert.equal(s.pendingJobCount(), 0, 'dry run stores nothing');

  // Two pairable episodes: add a second failure family to a fresh db.
  const db2 = join(dir, 'db2.sqlite');
  zcodeFixture(db2, { command: 'npm run build', errorText: 'npm ERR! missing script: build\nmore' });
  const raw = new DatabaseSync(db2);
  const now = Date.now();
  const extra = (id, status, error, cmd) => {
    raw.prepare('INSERT INTO tool_usage VALUES (?, ?, ?, ?, ?, ?)').run('sess_audit_z', id, 'Bash', status, error, now - 30_000);
    raw.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
      'sess_audit_z',
      JSON.stringify({ type: 'tool', callID: id, state: { input: { command: cmd }, output: '' } }),
      now - 30_000,
    );
  };
  extra('d1', 'error', 'vitest failed: 2 tests', 'vitest run');
  extra('d2', 'completed', null, 'vitest run');
  raw.close();
  const s2 = store();
  const uncapped = auditHistory(s2, { days: 30, source: 'zcode', sourceDb: db2 });
  assert.equal(uncapped.sources[0].enqueued, 2, 'both families pair without a cap');
  const s3 = store();
  const capped = auditHistory(s3, { days: 30, source: 'zcode', sourceDb: db2, max: 1 });
  assert.equal(capped.sources[0].enqueued, 1, 'max=1 stops further enqueues');
  assert.equal(s3.pendingJobCount(), 1);
  s.close();
  s2.close();
  s3.close();
});
