import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
