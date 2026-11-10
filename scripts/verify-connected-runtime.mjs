/**
 * verify-connected-runtime.mjs — the connect'd hook chain, driven for real.
 *
 * `connect claude-code` / `connect codex` promise that the vendored hook
 * scripts run under the HOST's environment — which has none of the
 * ZCODE_ or CLAUDE_ plugin variables the plugin-world hooks get for free. This
 * script proves that shape without needing the real host CLIs: it connects
 * into a temp home, then feeds Claude-Code-dialect payloads on stdin to the
 * VENDORED scripts as real child processes, cwd in a temp project, env
 * scrubbed. The database must land in <project>/.dsh/immune.sqlite through
 * the no-env fallback chain, an episode must distil at Stop, and a fresh
 * session must receive the injection.
 *
 * Not covered here (needs the real CLIs): host-side hook dispatch itself.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectHost } from '../dsh-immune-system/dist/core/connect.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const home = mkdtempSync(join(tmpdir(), 'immune-conrt-home-'));
const project = mkdtempSync(join(tmpdir(), 'immune-conrt-proj-'));
try {
  const report = connectHost('claude-code', { home });
  const hooksDir = join(report.vendorDir, 'dist', 'zcode', 'src', 'hooks');

  // The host environment: none of the plugin variables exist. The child env
  // is built by DELETING them from ours so the test cannot inherit any.
  function runHook(script, payload) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ZCODE|CLAUDE)_/.test(key)) delete env[key];
    }
    delete env.IMMUNE_DB_PATH; // the fallback chain must land the db itself
    return spawnSync(process.execPath, [join(hooksDir, script)], {
      input: JSON.stringify(payload),
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  const dbPath = join(project, '.dsh', 'immune.sqlite');

  // --- session 1: fail, repair, succeed, turn end -------------------------
  const s1 = 'conn-rt-1';
  const ss1 = runHook('session-start.js', { hook_event_name: 'SessionStart', session_id: s1, source: 'startup' });
  check('session-start exits 0 with no host env', ss1.status === 0, ss1.stderr.slice(0, 200));

  const pre1 = runHook('pre-tool-use.js', {
    hook_event_name: 'PreToolUse',
    session_id: s1,
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
  });
  check('pre-tool-use exits 0 (empty library, no crash)', pre1.status === 0, pre1.stderr.slice(0, 200));

  const fail = runHook('post-tool-use.js', {
    hook_event_name: 'PostToolUse',
    session_id: s1,
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    tool_response: { exitCode: 1, stderr: 'npm ERR! missing script: install' },
  });
  check('failing PostToolUse (exitCode=1) records a pending failure', fail.status === 0, fail.stderr.slice(0, 200));

  const repair = runHook('post-tool-use.js', {
    hook_event_name: 'PostToolUse',
    session_id: s1,
    tool_name: 'Edit',
    tool_input: { file_path: join(project, 'package.json'), old_string: 'a', new_string: 'b' },
    tool_response: { ok: true },
  });
  check('repairing Edit completes', repair.status === 0, repair.stderr.slice(0, 200));

  const success = runHook('post-tool-use.js', {
    hook_event_name: 'PostToolUse',
    session_id: s1,
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    tool_response: { exitCode: 0, stdout: 'added 300 packages' },
  });
  check('successful PostToolUse closes the episode', success.status === 0, success.stderr.slice(0, 200));

  check('database landed at <project>/.dsh/immune.sqlite via the no-env fallback', existsSync(dbPath));

  const stop = runHook('stop.js', { hook_event_name: 'Stop', session_id: s1 });
  check('Stop drains and distils', stop.status === 0, stop.stderr.slice(0, 200));

  let rules = 0;
  {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    rules = db
      .prepare("SELECT COUNT(*) AS n FROM antibodies WHERE status = 'active'")
      .get().n;
    db.close();
  }
  check('one active rule distilled from the episode', rules === 1, `got ${rules}`);

  // --- session 2: the same wall, met by an injection ----------------------
  const s2 = 'conn-rt-2';
  const ss2 = runHook('session-start.js', { hook_event_name: 'SessionStart', session_id: s2, source: 'startup' });
  check(
    'new session-start injects the learned rule',
    ss2.status === 0 && /immune_memory/.test(ss2.stdout) && /npm/.test(ss2.stdout),
    ss2.stdout.slice(0, 200) || ss2.stderr.slice(0, 200),
  );

  const pre2 = runHook('pre-tool-use.js', {
    hook_event_name: 'PreToolUse',
    session_id: s2,
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
  });
  check(
    'pre-tool-use recalls the rule for the same command',
    pre2.status === 0 && /immune_memory/.test(pre2.stdout),
    pre2.stdout.slice(0, 200) || pre2.stderr.slice(0, 200),
  );
  check(
    'hook output obeys the strict schema (hookSpecificOutput only)',
    (() => {
      try {
        const parsed = JSON.parse(pre2.stdout);
        return Object.keys(parsed).length === 1 && 'hookSpecificOutput' in parsed;
      } catch {
        return pre2.stdout.trim() === '';
      }
    })(),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

console.log(`\n=== connected runtime: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed === 0 ? 0 : 1;
