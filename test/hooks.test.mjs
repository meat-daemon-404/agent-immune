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
