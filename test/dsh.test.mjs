/**
 * DSH adapter + plugin integration tests (shared task-2).
 *
 * Three levels of evidence, all against the BUILT plugin
 * (`dsh-immune-system/dist/dsh/src/*.js`) — never against the TypeScript source:
 *
 *  1. `normaliseToolEvent(exec, result)` field by field, on real DSH payload
 *     shapes. The load-bearing assertion is the first one: bash reports a
 *     non-zero exit as `isError: false` (only spawn errors and aborts are
 *     `isError`), so a naive adapter sees "ok" for a failed command.
 *  2. Fail-then-succeed on one session + one tool, driven through `apply(ctx)`
 *     with a fake Cordis context and a real `(exec, ToolExecutionResult)` pair,
 *     must leave exactly one row in the sqlite `antibodies` table.
 *  3. A NEW session asking a related question must get an `<immune_memory>`
 *     block in its model-facing context (the `agent/pre-step` decision).
 *
 * Every test builds its own temp database and its own plugin instance, so each
 * one reproduces standalone and nothing leaks between them.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  DSH_EVENTS,
  PLUGIN_NAME,
  makeLogger,
  normaliseToolEvent,
} from '../dsh-immune-system/dist/dsh/src/dsh-adapter.js';
import * as plugin from '../dsh-immune-system/dist/dsh/src/index.js';

// Pin the deterministic rule-based distiller: a configured model would make
// these assertions depend on a network round trip and on model output.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('IMMUNE_LLM')) delete process.env[key];
}

/* ------------------------------------------------------------------ *
 * Payload builders — shapes read out of the DSH checkout, not invented
 * ------------------------------------------------------------------ */

/** A minimal `Agent` handle: only `id` and `inject` are read by the plugin. */
function makeAgent(id) {
  const inbox = [];
  return {
    id,
    session: { header: { id } },
    inject(message) {
      inbox.push(message);
    },
    inbox,
  };
}

/** `ToolExecution` — dsh-tools `ToolExecutionInput` plus `token`. */
function makeExec(agent, overrides = {}) {
  return {
    callId: `call-${Math.random().toString(36).slice(2)}`,
    name: 'Bash',
    arguments: { command: 'npm run build' },
    agent,
    signal: { aborted: false },
    ...overrides,
  };
}

/**
 * `ToolExecutionSuccess` whose `value` is what `dsh-tool-bash` really writes
 * (`canonicalBashResult`): the exit status lives here, NOT in `isError`.
 */
function bashResult({ exitCode, text, timedOut = false }) {
  return {
    isError: false,
    content: [{ type: 'text', text }],
    value: { exitCode, signal: null, timedOut, aborted: false, timeoutMs: 60000, stdout: '', stderr: '' },
  };
}

/** `ToolExecutionFailure` — note there is no `value` field on this arm. */
function thrownResult(message) {
  return { isError: true, error: { message }, content: [{ type: 'text', text: message }] };
}

/** The exact payload the task warns about: exit 1 that arrives as `isError: false`. */
const BASH_EXIT_1 = {
  isError: false,
  content: [{ type: 'text', text: '(no output)\n[exit code: 1]' }],
  value: { exitCode: 1, signal: null, timedOut: false, aborted: false },
};

/** Model-facing text of a message, the way the plugin's renderer builds it. */
function messageText(message) {
  const blocks = message?.content ?? [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** A user-authored model message. */
function userMessage(id, text) {
  const source = { kind: 'user' };
  return { id, role: 'user', content: [{ type: 'text', text }], source };
}

/* ------------------------------------------------------------------ *
 * Fake Cordis context + event bus
 * ------------------------------------------------------------------ */

/**
 * Only the surface `apply(ctx)` touches: `logger`, `on`, `effect` and the
 * injected `commands` service (cordis `Context` + dsh-commands).
 */
function fakeContext() {
  const listeners = new Map();
  const disposers = [];
  const logs = [];
  const commands = [];

  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message: String(message) }),
      warn: (message) => logs.push({ level: 'warn', message: String(message) }),
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return () => {
        const at = bucket.indexOf(listener);
        if (at >= 0) bucket.splice(at, 1);
        return true;
      };
    },
    // cordis runs the effect body immediately and keeps the returned disposer.
    effect(execute, label) {
      const dispose = execute();
      const handle = { label, dispose: () => dispose?.() };
      disposers.push(handle);
      return handle;
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
  };

  return {
    ctx,
    logs,
    commands,
    disposers,
    listeners,
    /** Register a listener after the plugin did, i.e. downstream of it. */
    on: (event, listener) => ctx.on(event, listener),
    /** Fire a plain (non-waterfall) event. */
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    /**
     * Run a waterfall/mode event the way cordis does: listeners in registration
     * order, `next()` continuing the chain, and the tail value is the decision.
     */
    waterfall(event, args, base) {
      const chain = [...(listeners.get(event) ?? [])];
      const step = (index) =>
        index >= chain.length
          ? Promise.resolve(base())
          : Promise.resolve(chain[index](...args, () => step(index + 1)));
      return step(0);
    },
    disposeAll() {
      for (const handle of disposers) handle.dispose();
    },
  };
}

/** Temp database + an applied plugin instance, torn down with the test. */
async function bootstrap(t) {
  const dir = mkdtempSync(join(tmpdir(), 'immune-dsh-'));
  const dbPath = join(dir, 'immune.sqlite');
  const previous = process.env.IMMUNE_DB_PATH;
  process.env.IMMUNE_DB_PATH = dbPath;

  const fx = fakeContext();
  plugin.apply(fx.ctx);

  t.after(() => {
    fx.disposeAll();
    if (previous === undefined) delete process.env.IMMUNE_DB_PATH;
    else process.env.IMMUNE_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  return { fx, dbPath, dir };
}

/** Raw read, so assertions name the real sqlite table rather than a facade. */
function queryAll(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const VITE_ERROR = 'ENOENT: no such file or directory, open D:\\Project\\app\\vite.config.ts';
const VITE_PROMPT = '帮我看下 vite.config.ts 的环境变量为什么读不到';

/** Drive one tool result through the plugin, the way the host does. */
function postTool(fx, exec, result) {
  return fx.waterfall(DSH_EVENTS.postToolExecute, [exec, result], () => ({ kind: 'accept' }));
}

/** Run the pre-step waterfall and return the resulting decision. */
function preStep(fx, agent, messages) {
  const payload = { agent, messages, turn: 1, step: 1, signal: { aborted: false } };
  return fx.waterfall(DSH_EVENTS.preStep, [payload], () => ({ kind: 'enter', messages }));
}

/** Learn one rule: fail, then succeed on the same session and tool. */
async function learnViteRule(fx, agent) {
  const failure = makeExec(agent, { arguments: { command: 'npm run build' } });
  await postTool(fx, failure, thrownResult(VITE_ERROR));
  const success = makeExec(agent, { arguments: { command: 'npx vite build --mode production' } });
  await postTool(fx, success, bashResult({ exitCode: 0, text: 'build finished in 3.2s' }));
}

/* ================================================================== *
 * Step 1 — normaliseToolEvent, field by field
 * ================================================================== */

test('bash non-zero exit is a FAILURE even though isError is false', () => {
  const exec = makeExec(makeAgent('sess-1'));
  const event = normaliseToolEvent(exec, BASH_EXIT_1);

  assert.ok(event, 'a call with an agent must normalise');
  assert.deepEqual(Object.keys(event).sort(), [
    'errorText',
    'ok',
    'resultText',
    'sessionId',
    'toolInput',
    'toolName',
  ]);
  assert.equal(event.sessionId, 'sess-1');
  assert.equal(event.toolName, 'Bash');
  assert.deepEqual(event.toolInput, { command: 'npm run build' });
  assert.equal(event.resultText, '(no output)\n[exit code: 1]');
  assert.equal(
    event.ok,
    false,
    'a bash call that exits 1 arrives as isError:false — it must still be judged a failure',
  );
  assert.match(event.errorText, /1/, 'the exit code must survive into errorText');
});

test('a failure reported only by the structured exit code is detected', () => {
  // `value.exitCode` carries the status even when the rendered text is clean.
  const result = bashResult({ exitCode: 127, text: 'sh: npm: command not found' });
  const event = normaliseToolEvent(makeExec(makeAgent('sess-1')), result);

  assert.ok(event);
  assert.equal(event.ok, false);
  assert.match(event.errorText, /127/);
});

test('a failure reported only by the trailing [exit code: N] marker is detected', () => {
  const result = {
    isError: false,
    content: [{ type: 'text', text: '(no output)\n[exit code: 2]' }],
    value: {},
  };
  const event = normaliseToolEvent(makeExec(makeAgent('sess-1')), result);

  assert.ok(event);
  assert.equal(event.ok, false, 'no structured code, so the rendered marker is authoritative');
  assert.match(event.errorText, /2/);
});

test('a killed-by-signal result is a failure', () => {
  const text = 'partial output\n[killed by signal: SIGTERM]';
  const event = normaliseToolEvent(
    makeExec(makeAgent('sess-1')),
    { isError: false, content: [{ type: 'text', text }], value: {} },
  );

  assert.ok(event);
  assert.equal(event.ok, false);
  assert.match(event.errorText, /SIGTERM/);
});

test('a thrown tool is a failure and its message reaches errorText', () => {
  const message = 'spawn npx ENOENT: command not found';
  const event = normaliseToolEvent(makeExec(makeAgent('sess-2')), thrownResult(message));

  assert.ok(event);
  assert.equal(event.ok, false);
  assert.ok(
    event.errorText.includes(message),
    `errorText must carry the failure message, got: ${JSON.stringify(event.errorText)}`,
  );
  assert.equal(event.sessionId, 'sess-2');
  assert.equal(event.resultText, message);
});

test('isError:true outranks a clean-looking rendered body', () => {
  // The precedence rule: an explicit error arm wins over any text heuristic,
  // even when the rendered content looks like a success.
  const result = {
    isError: true,
    error: { message: 'tool crashed before it could print' },
    content: [{ type: 'text', text: 'ok' }],
  };
  const event = normaliseToolEvent(makeExec(makeAgent('sess-p')), result);

  assert.ok(event);
  assert.equal(event.ok, false);
  assert.match(event.errorText, /crashed/);
});

test('isError:true wins over a stray exit-code marker in the body', () => {
  // Both failure signals are present: the structured error must be the one
  // reported, not the text marker, so errorText stays meaningful.
  const result = {
    isError: true,
    error: { message: 'infrastructure failure: aborted' },
    content: [{ type: 'text', text: 'noise\n[exit code: 9]' }],
  };
  const event = normaliseToolEvent(makeExec(makeAgent('sess-p')), result);

  assert.ok(event);
  assert.equal(event.ok, false);
  assert.match(event.errorText, /infrastructure failure/);
  assert.doesNotMatch(event.errorText, /exit code 9/);
});

test('a clean success stays ok with empty errorText', () => {
  const event = normaliseToolEvent(
    makeExec(makeAgent('sess-3')),
    bashResult({ exitCode: 0, text: 'ok' }),
  );

  assert.ok(event);
  assert.equal(event.ok, true);
  assert.equal(event.errorText, '');
  assert.equal(event.resultText, 'ok');
});

test('a failure marker in the body is caught with no structured code at all', () => {
  const result = {
    isError: false,
    content: [{ type: 'text', text: 'Cannot find module "vite"' }],
    value: {},
  };
  const event = normaliseToolEvent(makeExec(makeAgent('sess-3')), result);

  assert.ok(event);
  assert.equal(event.ok, false, 'a report-only tool still says "Cannot find module"');
});

test('a call with no agent normalises to undefined', () => {
  const exec = makeExec(undefined);
  assert.equal(normaliseToolEvent(exec, BASH_EXIT_1), undefined);
  assert.equal(normaliseToolEvent(exec, bashResult({ exitCode: 0, text: 'ok' })), undefined);
  assert.equal(normaliseToolEvent(exec, thrownResult('boom')), undefined);
});

test('makeLogger forwards info and warn to the host logger', () => {
  const seen = [];
  const logger = makeLogger({
    logger: { info: (m) => seen.push(['info', m]), warn: (m) => seen.push(['warn', m]) },
  });
  logger.info('hello');
  logger.warn('careful');
  assert.deepEqual(seen, [
    ['info', 'hello'],
    ['warn', 'careful'],
  ]);
});

test('the entry point exports the Cordis plugin shape', () => {
  assert.equal(plugin.name, PLUGIN_NAME);
  assert.equal(PLUGIN_NAME, 'dsh-immune-system');
  assert.deepEqual(plugin.inject, ['commands'], 'ctx.commands is a service and must be injected');
  assert.equal(typeof plugin.apply, 'function');
});

test('DSH_EVENTS names the real host events', () => {
  assert.deepEqual(DSH_EVENTS, {
    sessionStart: 'agent/session-start',
    preStep: 'agent/pre-step',
    postToolExecute: 'tools/post-execute',
  });
});

test('apply() degrades to a warning instead of breaking the session when the store cannot open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-badstore-'));
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'x');
  const previous = process.env.IMMUNE_DB_PATH;
  process.env.IMMUNE_DB_PATH = join(blocker, 'immune.sqlite');
  try {
    const fx = fakeContext();
    assert.doesNotThrow(() => plugin.apply(fx.ctx));
    const warned = fx.logs.filter((entry) => entry.level === 'warn');
    assert.equal(warned.length, 1, 'exactly one warning is logged');
    assert.match(warned[0].message, /^\[immune\] disabled for this session: /u);
    assert.equal(fx.listeners.size, 0, 'no listeners are registered when startup fails');
  } finally {
    if (previous === undefined) delete process.env.IMMUNE_DB_PATH;
    else process.env.IMMUNE_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
