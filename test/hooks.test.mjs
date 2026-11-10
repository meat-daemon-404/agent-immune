import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const HOOKS = join(ROOT, 'dsh-immune-system', 'dist', 'zcode', 'src', 'hooks');
const CLI = join(ROOT, 'dsh-immune-system', 'dist', 'zcode', 'src', 'cli.js');

/** Run a hook exactly the way the runtime does: JSON in, JSON out. */
function runHook(name, event, env) {
  const result = spawnSync(process.execPath, [join(HOOKS, `${name}.js`)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return result;
}

test('a retired rule is retired, not re-distilled into a "previous rule" episode', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-retire-'));
  const dbPath = join(dir, 'immune.sqlite');
  const env = { IMMUNE_DB_PATH: dbPath, ZCODE_PROJECT_DIR: dir };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Seed a rule one failure away from retirement, and deliver it this turn.
  process.env.IMMUNE_DB_PATH = dbPath;
  const { ImmuneStore } = await import(
    pathToFileURL(join(ROOT, 'dsh-immune-system', 'dist', 'core', 'store', 'index.js')).href
  );
  const { DatabaseSync } = await import('node:sqlite');
  const store = new ImmuneStore();
  const id = store.insert({
    trigger_pattern: 'Bash npm run build vite',
    symptom: 'missing script: build',
    prescription: 'run the build through npx so the local binary is used',
    tool_name: 'Bash',
  });
  assert.ok(id, 'the seed rule must insert');
  store.match('npm run build', { sessionId: 'sess-R' });
  store.close();
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE antibodies SET fail_count = 2 WHERE id = ?').run(id);
  raw.close();

  // The rule fails to prevent this one, so anti-rot retires it.
  const failed = runHook(
    'post-tool-use-failure',
    {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-R',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      error: 'npm ERR! missing script: build',
    },
    env,
  );
  assert.equal(failed.status, 0);
  assert.equal(failed.stdout, '', 'retirement must not inject context either');

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const status = check.prepare('SELECT status FROM antibodies WHERE id = ?').get(id);
  assert.equal(status.status, 'retired', 'the failure must actually retire the rule');

  // AGENTS.md #24: the retired prescription must never become the success
  // trace of a new job — that is what produced the nested junk rule.
  const junk = check
    .prepare("SELECT COUNT(*) AS c FROM distill_jobs WHERE success_trace LIKE '%previous rule (retired%'")
    .get();
  assert.equal(junk.c, 0, 'no job may carry the retired rule as its repair evidence');
  check.close();
});

test('closed loop across separate hook processes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-'));
  const env = {
    IMMUNE_DB_PATH: join(dir, 'immune.sqlite'),
    ZCODE_PROJECT_DIR: dir,
    ZCODE_PLUGIN_ROOT: join(ROOT, 'dsh-immune-system'),
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = 'sess-A';

  // 1. A tool fails. The hook must stay silent and exit cleanly.
  const failed = runHook(
    'post-tool-use-failure',
    {
      hook_event_name: 'PostToolUseFailure',
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      error: 'ENOENT: vite.config.ts not found while reading VITE_APP_MODE',
    },
    env,
  );
  assert.equal(failed.status, 0);
  assert.equal(failed.stdout, '', 'a failure hook must not inject context');

  // 2. The same tool then succeeds: the pair should be queued.
  const succeeded = runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command: 'npx vite build --mode production' },
      tool_result_preview: 'build finished in 3.2s',
    },
    env,
  );
  assert.equal(succeeded.status, 0);
  assert.equal(succeeded.stdout, '');

  // 3. Turn end distils the queued episode into an antibody.
  const stopped = runHook('stop', { hook_event_name: 'Stop', session_id: session }, env);
  assert.equal(stopped.status, 0);

  const listed = spawnSync(process.execPath, [CLI, 'list'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /Bash/, 'distillation should have produced an antibody');
  assert.match(listed.stdout, /avoid:/);
  assert.match(listed.stdout, /do:/);

  // 4. A DIFFERENT session sees it — the whole point of the design.
  const injected = runHook(
    'user-prompt-submit',
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-B-new',
      prompt: '跑一下 npm run build 打包，vite.config.ts 那边老是报错',
    },
    env,
  );
  assert.equal(injected.status, 0);
  assert.notEqual(injected.stdout, '', 'the new session must receive the antibody');

  const payload = JSON.parse(injected.stdout);
  assert.deepEqual(
    Object.keys(payload),
    ['hookSpecificOutput'],
    'stdout must not carry extra top-level keys',
  );
  assert.deepEqual(Object.keys(payload.hookSpecificOutput).sort(), [
    'additionalContext',
    'hookEventName',
  ]);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(payload.hookSpecificOutput.additionalContext, /<immune_memory>/);
});

test('the guard is off by default and denies only when asked', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-guard-'));
  const base = { IMMUNE_DB_PATH: join(dir, 'immune.sqlite'), ZCODE_PROJECT_DIR: dir };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const call = {
    hook_event_name: 'PreToolUse',
    session_id: 'g1',
    tool_name: 'Bash',
    tool_input: { command: 'git push --force origin main' },
  };

  // Default: advisory system only, and nothing learned yet means no output.
  const silent = runHook('pre-tool-use', call, base);
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, '', 'guards must be opt-in');

  // deny: the call is refused through the documented PreToolUse shape.
  const denied = runHook('pre-tool-use', call, { ...base, IMMUNE_GUARD: 'deny' });
  assert.equal(denied.status, 0);
  const payload = JSON.parse(denied.stdout);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /force-push-main/);
  assert.deepEqual(
    Object.keys(payload.hookSpecificOutput).sort(),
    ['hookEventName', 'permissionDecision', 'permissionDecisionReason'],
    'an extra key would invalidate the hook and silently allow the call',
  );

  // warn: advisory, never a decision.
  const warned = runHook('pre-tool-use', call, { ...base, IMMUNE_GUARD: 'warn' });
  const warnPayload = JSON.parse(warned.stdout);
  assert.equal(warnPayload.hookSpecificOutput.permissionDecision, undefined);
  assert.match(warnPayload.hookSpecificOutput.additionalContext, /immune_guard/);
});

test('PreToolUse warns before a call that is known to fail', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-'));
  const env = {
    IMMUNE_DB_PATH: join(dir, 'immune.sqlite'),
    ZCODE_PROJECT_DIR: dir,
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Learn one antibody through the normal loop.
  runHook(
    'post-tool-use-failure',
    {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'p1',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      error: 'ENOENT: vite.config.ts not found',
    },
    env,
  );
  runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: 'p1',
      tool_name: 'Bash',
      tool_input: { command: 'npx vite build --mode production' },
      tool_result_preview: 'ok',
    },
    env,
  );
  runHook('stop', { hook_event_name: 'Stop', session_id: 'p1' }, env);

  // A call touching the same file is warned about before it runs.
  const warned = runHook(
    'pre-tool-use',
    {
      hook_event_name: 'PreToolUse',
      session_id: 'p2',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build -- vite.config.ts' },
    },
    env,
  );
  assert.equal(warned.status, 0);
  assert.match(warned.stdout, /<immune_memory>/, 'expected a just-in-time warning');

  // An unrelated command must stay silent: the tool name alone is not a signal.
  const quiet = runHook(
    'pre-tool-use',
    {
      hook_event_name: 'PreToolUse',
      session_id: 'p3',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
    },
    env,
  );
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '', 'a bare Bash call must not trigger every Bash antibody');
});

test('a hook with malformed stdin still exits cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-'));
  try {
    const result = spawnSync(process.execPath, [join(HOOKS, 'user-prompt-submit.js')], {
      input: '{ this is not json',
      encoding: 'utf8',
      env: { ...process.env, IMMUNE_DB_PATH: join(dir, 'i.sqlite'), ZCODE_PROJECT_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unmatched prompt injects nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-'));
  try {
    const result = runHook(
      'user-prompt-submit',
      { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hello there' },
      { IMMUNE_DB_PATH: join(dir, 'i.sqlite'), ZCODE_PROJECT_DIR: dir },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'no antibodies means no context block');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a human correction between failure and retry reaches the antibody', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-hint-'));
  const env = { IMMUNE_DB_PATH: join(dir, 'immune.sqlite'), ZCODE_PROJECT_DIR: dir };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = 'hint-1';

  // Turn 1: the command fails.
  runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_response: { exitCode: 127 },
      tool_result_preview: 'npm ERR! missing script: build',
    },
    env,
  );

  // Turn 2: the human explains the rule.
  runHook(
    'user-prompt-submit',
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: session,
      prompt: '这个仓库用的是 pnpm，不要用 npm，重新跑一次',
    },
    env,
  );

  // Turn 2 continues: the retry works.
  runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command: 'pnpm build' },
      tool_response: { exitCode: 0 },
      tool_result_preview: 'build ok',
    },
    env,
  );
  runHook('stop', { hook_event_name: 'Stop', session_id: session }, env);

  const listed = spawnSync(process.execPath, [CLI, 'list'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.match(listed.stdout, /pnpm/, 'the human explanation must survive into the rule');
});

test('session-start priming skips echo rules; a hint-grade rule still primes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-'));
  const env = {
    IMMUNE_DB_PATH: join(dir, 'immune.sqlite'),
    ZCODE_PROJECT_DIR: dir,
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // ECHO rule: distilled without a model, its prescription is the command
  // that worked. It must NOT prime (no context at startup says this session
  // will run that command), but prompt-time recall may still deliver it.
  runHook(
    'post-tool-use-failure',
    {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'p1',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      error: 'npm ERR! missing script: build',
    },
    env,
  );
  runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: 'p1',
      tool_name: 'Bash',
      tool_input: { command: 'npx vite build --mode production' },
      tool_response: { exitCode: 0 },
      tool_result_preview: 'ok',
    },
    env,
  );
  runHook('stop', { hook_event_name: 'Stop', session_id: 'p1' }, env);

  // HINT rule: a human explanation distils into real advice, and THAT is
  // what priming is for.
  runHook(
    'post-tool-use-failure',
    {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'h1',
      tool_name: 'Bash',
      tool_input: { command: 'python -X utf8 script.py' },
      error: 'SyntaxError: invalid syntax',
    },
    env,
  );
  runHook(
    'user-prompt-submit',
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'h1',
      prompt: '用 UTF-8 模式跑，别用默认编码',
    },
    env,
  );
  runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: 'h1',
      tool_name: 'Bash',
      tool_input: { command: 'python -X utf8 script.py' },
      tool_response: { exitCode: 0 },
      tool_result_preview: 'ok',
    },
    env,
  );
  runHook('stop', { hook_event_name: 'Stop', session_id: 'h1' }, env);

  // A NEW session primes with the hint rule only.
  const primed = runHook(
    'session-start',
    { hook_event_name: 'SessionStart', session_id: 'p2', source: 'startup' },
    env,
  );
  assert.match(primed.stdout, /<immune_memory>/, 'the hint-grade rule primes');
  assert.doesNotMatch(primed.stdout, /vite build/, 'the echo-grade rule does not ride along');

  // The primed hint rule must not be delivered again at the first prompt...
  const prompted = runHook(
    'user-prompt-submit',
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'p2',
      prompt: '帮我处理 python 编码问题',
    },
    env,
  );
  // ...whatever it delivers, it must not repeat the primed prescriptions.
  if (prompted.stdout.includes('<immune_memory>')) {
    assert.doesNotMatch(prompted.stdout, /UTF-8/, 'the same session must not pay for the primed rule twice');
  }
});

test('1.5 stuck detection: hypothesis fires once on the third attempt and the fix crystallizes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-stuck-'));
  const dbPath = join(dir, 'immune.sqlite');
  const env = { IMMUNE_DB_PATH: dbPath, ZCODE_PROJECT_DIR: dir };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const COMMAND = 'weirdtool deploy --env staging';

  // Two consecutive non-probe failures of an uncovered target...
  for (let i = 0; i < 2; i += 1) {
    const failed = runHook(
      'post-tool-use-failure',
      {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'sess-S',
        tool_name: 'Bash',
        tool_input: { command: COMMAND },
        error: `weirdtool: unknown env "${i}"`,
      },
      env,
    );
    assert.equal(failed.status, 0);
  }

  // ...so the NEXT attempt (the third) receives the diagnostic hypothesis.
  const third = runHook(
    'pre-tool-use',
    {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-S',
      tool_name: 'Bash',
      tool_input: { command: COMMAND },
    },
    env,
  );
  assert.match(third.stdout, /连续失败两次/, 'the diagnostic hypothesis rides additionalContext');
  assert.match(third.stdout, /minimal diagnostic/i);

  // Exactly once per streak: the fourth attempt gets nothing.
  const fourth = runHook(
    'pre-tool-use',
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'sess-S',
      tool_input: { command: COMMAND },
    },
    env,
  );
  assert.doesNotMatch(fourth.stdout, /连续失败两次/, 'hypothesis fires once per streak');

  // A covered target never hypothesizes: seed a rule whose trigger matches the
  // failing trace, and the failure must not open a stuck row for it.
  process.env.IMMUNE_DB_PATH = dbPath;
  const { ImmuneStore } = await import(
    pathToFileURL(join(ROOT, 'dsh-immune-system', 'dist', 'core', 'store', 'index.js')).href
  );
  const store = new ImmuneStore();
  store.insert({
    trigger_pattern: 'Bash coveredtool sync ERR_LOCK',
    symptom: 'covered tool lock error',
    prescription: 'remove the stale lock file first',
    tool_name: 'Bash',
  });
  store.close();
  runHook(
    'post-tool-use-failure',
    {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-S2',
      tool_name: 'Bash',
      tool_input: { command: 'coveredtool sync' },
      error: 'coveredtool: ERR_LOCK held',
    },
    env,
  );
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const coveredStuck = raw
    .prepare("SELECT fail_streak FROM stuck_state WHERE session_id = 'sess-S2'")
    .get();
  assert.equal(coveredStuck, undefined, 'a covered target does not enter stuck state');

  // A probe-class failure never counts (AGENTS.md #25).
  runHook(
    'post-tool-use-failure',
    {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-S3',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      error: 'fatal: not a git repository',
      tool_result_preview: 'fatal: not a git repository',
    },
    env,
  );
  const probeStuck = raw
    .prepare("SELECT fail_streak FROM stuck_state WHERE session_id = 'sess-S3'")
    .get();
  assert.equal(probeStuck, undefined, 'probe failures never count toward stuck state');

  // The fix closes the episode: the job's origin records the experiment, and
  // the stuck row is gone (suppression once resolved).
  const done = runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-S',
      tool_name: 'Bash',
      tool_input: { command: COMMAND },
      tool_response: { stdout: 'deployed', stderr: '', exitCode: 0 },
    },
    env,
  );
  assert.equal(done.status, 0);
  const job = raw
    .prepare("SELECT origin FROM distill_jobs WHERE tool_name = 'Bash' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(job?.origin, 'self_healing_experiment', 'the fix crystallizes with experiment origin');
  const stuckLeft = raw.prepare("SELECT 1 FROM stuck_state WHERE session_id = 'sess-S'").get();
  assert.equal(stuckLeft, undefined, 'suppression once resolved: the streak row is gone');
  raw.close();
});

test('2.3b convergent detour: 4+ same-target probes then success = telemetry, never a rule', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-detour-'));
  const dbPath = join(dir, 'immune.sqlite');
  const env = { IMMUNE_DB_PATH: dbPath, ZCODE_PROJECT_DIR: dir };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Four read-only probes of one target...
  for (let i = 0; i < 4; i += 1) {
    runHook(
      'post-tool-use',
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-D',
        tool_name: 'Bash',
        tool_input: { command: 'cat package.json' },
        tool_response: { stdout: '{}', stderr: '', exitCode: 0 },
      },
      env,
    );
  }
  // ...and the successful real command that finally landed.
  runHook(
    'post-tool-use',
    {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-D',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_response: { stdout: 'built', stderr: '', exitCode: 0 },
    },
    env,
  );

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const detour = raw.prepare('SELECT probes, signature FROM detours ORDER BY id DESC LIMIT 1').get();
  assert.ok(detour, 'the detour telemetry row exists');
  assert.equal(Number(detour.probes), 4);
  assert.ok(String(detour.signature).startsWith('Bash:cat:'), 'the detoured target is the probe family');
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM antibodies').get().n,
    0,
    'telemetry only — no echo-grade rule was distilled from a successful trace',
  );
  raw.close();
});

test('4.1 swarm freshness: a rule crystallized by process A is recalled by process B', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-swarm-'));
  const dbPath = join(dir, 'immune.sqlite');
  const env = { IMMUNE_DB_PATH: dbPath, ZCODE_PROJECT_DIR: dir };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Worker A (its own process): distills a rule into the shared project db.
  const writer = spawnSync(
    process.execPath,
    [
      '-e',
      `import('${pathToFileURL(join(ROOT, 'dsh-immune-system', 'dist', 'core', 'store', 'index.js')).href}')
        .then(({ ImmuneStore }) => {
          const s = new ImmuneStore({ dbPath: ${JSON.stringify(dbPath)} });
          s.insert({
            trigger_pattern: 'Bash swarmpkg publish ERR_PUBLISH',
            symptom: 'publish conflict',
            prescription: 'bump the version field before republishing',
            tool_name: 'Bash',
          });
          s.close();
          console.log('inserted');
        })
        .catch((error) => { console.error(error.message); process.exit(1); });`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(writer.status, 0, `worker A insert failed: ${writer.stderr}`);

  // Worker B (another process, the real PreToolUse hook path) hits the same
  // pitfall and must recall A's rule on its very first call — no restart, no
  // watermark: every hook is a fresh process over the same SQLite file.
  const reader = runHook(
    'pre-tool-use',
    {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-B',
      tool_name: 'Bash',
      tool_input: { command: 'swarmpkg publish' },
    },
    env,
  );
  assert.match(reader.stdout, /bump the version field/, 'worker B recalls the fresh rule');
});

test('4.2 stack pre-warming: markers install matching seed packs once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-prewarm-'));
  const dbPath = join(dir, 'immune.sqlite');
  // A node-ts + git workspace: package.json + .git exist in a temp dir? .git
  // is NOT created by mkdtemp — write both markers explicitly.
  const { writeFileSync, mkdirSync: mk } = await import('node:fs');
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}', 'utf8');
  mk(join(dir, '.git'), { recursive: true });
  const env = { IMMUNE_DB_PATH: dbPath, ZCODE_PROJECT_DIR: dir };

  const first = runHook('session-start', { hook_event_name: 'SessionStart', session_id: 'pw1', source: 'startup' }, env);
  assert.equal(first.status, 0);

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const count = () => Number(raw.prepare('SELECT COUNT(*) AS n FROM antibodies').get().n);
  const afterFirst = count();
  assert.ok(afterFirst > 0, 'the matching packs installed rules');

  // Second session: the meta markers hold; nothing new installs.
  runHook('session-start', { hook_event_name: 'SessionStart', session_id: 'pw2', source: 'startup' }, env);
  assert.equal(count(), afterFirst, 'pre-warming is once per workspace');

  // The marker keys are the proof of what ran.
  const markers = raw.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'prewarmed:%'").get().n;
  assert.equal(Number(markers), 2, 'git-safety + node-ts markers written');
  raw.close();
});
