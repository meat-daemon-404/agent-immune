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
function fakeContext(services = {}) {
  const listeners = new Map();
  const disposers = [];
  const logs = [];
  const commands = [];
  const injections = [];

  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message: String(message) }),
      warn: (message) => logs.push({ level: 'warn', message: String(message) }),
    },
    // cordis `ctx.get(name)` — a read-only service lookup, no inject edge.
    get(name) {
      return services[name];
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
    // cordis `ctx.inject(deps, cb)` — activate once the named services exist.
    // The fake immediately provides `services._child` (if any) so a test can
    // observe the startup web-tab report without a real module graph.
    inject(deps, callback) {
      injections.push({ deps, callback });
      if (services._child !== undefined) callback(services._child);
      return () => {};
    },
  };

  return {
    ctx,
    logs,
    commands,
    disposers,
    listeners,
    injections,
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
async function bootstrap(t, services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'immune-dsh-'));
  const dbPath = join(dir, 'immune.sqlite');
  const previous = process.env.IMMUNE_DB_PATH;
  process.env.IMMUNE_DB_PATH = dbPath;

  const fx = fakeContext(services);
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

/** Run the serial turn-end event the way cordis does: await every listener. */
async function runTurnStopping(fx, agent, turn) {
  const payload = { agent, turn, signal: { aborted: false } };
  for (const listener of [...(fx.listeners.get(DSH_EVENTS.turnStopping) ?? [])]) {
    await listener(payload);
  }
}

/** Pre-step waterfall at an explicit (turn, step) position. */
function preStepAt(fx, agent, messages, turn, step) {
  const payload = { agent, messages, turn, step, signal: { aborted: false } };
  return fx.waterfall(DSH_EVENTS.preStep, [payload], () => ({ kind: 'enter', messages }));
}

/* ================================================================== *
 * Step 2 / Step 3 — learn an antibody, then recall it
 * ================================================================== */

test('nothing is distilled inside the tool path; turn-stopping lands exactly one antibody', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const agent = makeAgent('sess-learn');

  await learnViteRule(fx, agent);
  assert.equal(
    queryAll(dbPath, 'SELECT id FROM antibodies').length,
    0,
    'a post-execute listener must not do turn-end distillation work',
  );

  await runTurnStopping(fx, agent, 1);
  const rows = queryAll(dbPath, 'SELECT tool_name, status, trigger_pattern FROM antibodies');
  assert.equal(rows.length, 1, 'exactly one antibody after the turn closes');
  assert.equal(rows[0].status, 'active');
  assert.ok(rows[0].trigger_pattern.length > 0);
});

test('pre-step recalls a matching antibody on the first step of a turn', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const agent = makeAgent('sess-recall');
  await learnViteRule(fx, agent);
  await runTurnStopping(fx, agent, 1);

  const [row] = queryAll(dbPath, 'SELECT trigger_pattern FROM antibodies');
  const prompt = userMessage('m-1', `how do I fix ${row.trigger_pattern} while building`);
  const decision = await preStepAt(fx, agent, [prompt], 2, 1);

  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2, 'one recalled block is spliced in');
  const injected = decision.messages.at(-1);
  assert.equal(injected.source.kind, 'plugin');
  assert.equal(messageText(injected).includes('<immune_memory>'), true);
  assert.equal(messageText(injected).includes('</immune_memory>'), true);
});

test('pre-step injects at most once per turn, and never after step 1', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const agent = makeAgent('sess-once');
  await learnViteRule(fx, agent);
  await runTurnStopping(fx, agent, 1);

  const [row] = queryAll(dbPath, 'SELECT trigger_pattern FROM antibodies');
  const prompt = userMessage('m-1', `how do I fix ${row.trigger_pattern} while building`);

  const first = await preStepAt(fx, agent, [prompt], 2, 1);
  assert.equal(first.messages.length, 2, 'the first step of the turn injects');
  const repeat = await preStepAt(fx, agent, [prompt], 2, 1);
  assert.equal(repeat.messages.length, 1, 'the same turn does not inject twice');
  const stepTwo = await preStepAt(fx, agent, [prompt], 2, 2);
  assert.equal(stepTwo.messages.length, 1, 'step 2 of a turn never injects');

  // Repeat suppression: an unchanged candidate set stays silent for
  // SUPPRESS_WINDOW turns, and must not inflate hit_count while it is silent.
  const nextTurn = await preStepAt(fx, agent, [prompt], 3, 1);
  assert.equal(nextTurn.messages.length, 1, 'an identical set is suppressed next turn');

  const hitsWhileSuppressed = queryAll(dbPath, 'SELECT hit_count FROM antibodies')[0].hit_count;
  assert.ok(hitsWhileSuppressed >= 1, 'the first injection still counted');

  // After the window expires the same set is delivered again.
  for (let turn = 4; turn <= 6; turn += 1) await preStepAt(fx, agent, [prompt], turn, 1);
  const afterWindow = await preStepAt(fx, agent, [prompt], 7, 1);
  assert.equal(afterWindow.messages.length, 2, 'after the window it injects again');
});

test('a changed candidate set is not suppressed', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const agent = makeAgent('sess-change');
  await learnViteRule(fx, agent);
  await runTurnStopping(fx, agent, 1);

  const [row] = queryAll(dbPath, 'SELECT trigger_pattern FROM antibodies');
  const first = await preStepAt(
    fx,
    agent,
    [userMessage('m-1', `how do I fix ${row.trigger_pattern} while building`)],
    2,
    1,
  );
  assert.equal(first.messages.length, 2);

  // A prompt that matches nothing has a different (empty) candidate set, so it
  // must not be treated as a repeat of the previous injection.
  const unrelated = await preStepAt(fx, agent, [userMessage('m-2', 'hello there')], 3, 1);
  assert.equal(unrelated.messages.length, 1, 'no candidates, nothing to inject');
});

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
    'sandboxDenied',
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

test('a structured success is NOT overturned by error words in its own output', () => {
  // A passing command may legitimately print "command not found" (grep over
  // docs), "Error:" (a handled branch), "npm ERR!" (a tolerated step). Exit 0
  // is authoritative for a shell tool, so the body text must not flip it.
  const result = bashResult({
    exitCode: 0,
    text: 'docs/troubleshooting.md: sh: foo: command not found\nError: handled\n[stderr]\nnpm ERR! tolerated',
  });
  const event = normaliseToolEvent(makeExec(makeAgent('sess-3')), result);

  assert.ok(event);
  assert.equal(event.ok, true, 'exit 0 wins over body heuristics');
  assert.equal(event.errorText, '');
});

test('a timeout that still reports exitCode 0 is a failure (flag, not text)', () => {
  const result = bashResult({ exitCode: 0, text: 'still running…', timedOut: true });
  const event = normaliseToolEvent(makeExec(makeAgent('sess-timeout')), result);

  assert.ok(event);
  assert.equal(event.ok, false);
  assert.equal(event.errorText, 'timed out');
});

test('a sandbox denial is flagged, and never becomes a learning episode', async (t) => {
  const denied = {
    isError: false,
    content: [{ type: 'text', text: '[sandbox: file access denied under read-only mode]' }],
    value: { exitCode: 1, signal: null, timedOut: false, aborted: false },
  };
  const event = normaliseToolEvent(makeExec(makeAgent('sess-sbx')), denied);
  assert.ok(event);
  assert.equal(event.ok, false);
  assert.equal(event.sandboxDenied, true);

  // A file tool that *throws* on a denied path carries the same marker in its
  // error message; it must be flagged the same way, not learned as a pitfall.
  const thrownDenial = thrownResult(
    'write failed: [sandbox: file access denied under workspace-write mode]',
  );
  const thrownEvent = normaliseToolEvent(makeExec(makeAgent('sess-sbx')), thrownDenial);
  assert.ok(thrownEvent);
  assert.equal(thrownEvent.ok, false);
  assert.equal(thrownEvent.sandboxDenied, true, 'a thrown sandbox denial is still a denial');

  // End to end: a denial followed by a success on the same tool must not
  // distil an antibody (there is nothing project-specific to learn).
  const { fx, dbPath } = await bootstrap(t);
  const agent = makeAgent('sess-sbx2');
  await postTool(fx, makeExec(agent, { arguments: { command: 'cat /etc/shadow' } }), denied);
  await postTool(
    fx,
    makeExec(agent, { arguments: { command: 'cat /etc/shadow' } }),
    bashResult({ exitCode: 0, text: 'root:x:0:0' }),
  );
  await runTurnStopping(fx, agent, 1);
  assert.equal(
    queryAll(dbPath, 'SELECT id FROM antibodies').length,
    0,
    'a sandbox denial must not seed an episode',
  );
});

test('a successful content tool is not failed by error words in its payload', () => {
  // `read` / `grep` return the file body or matches as the structured value.
  // Reading a log (or this repo's own docs) that contains `Error:` must not be
  // recorded as a failure — the payload is the verdict, the text is data.
  const readResult = {
    isError: false,
    content: [{ type: 'text', text: 'Error: disk quota exceeded (a line in the log we are reading)' }],
    value: { path: 'logs/app.log', content: 'Error: disk quota exceeded' },
  };
  const event = normaliseToolEvent(makeExec(makeAgent('sess-read'), { name: 'read' }), readResult);
  assert.ok(event);
  assert.equal(event.ok, true, 'a structured payload means the tool already succeeded');
});

test('a payload-less tool that reports failure only in text is still caught', () => {
  const result = {
    isError: false,
    content: [{ type: 'text', text: 'Error: connection refused' }],
    value: {},
  };
  const event = normaliseToolEvent(makeExec(makeAgent('sess-mcp'), { name: 'mcp_call' }), result);
  assert.ok(event);
  assert.equal(event.ok, false, 'no payload + a failure marker is still a failure');
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
  // Each name is pinned to its declaration in the DSH checkout; adding an event
  // is meant to break this test so the new name gets verified, not assumed.
  assert.deepEqual(DSH_EVENTS, {
    sessionStart: 'agent/session-start', // runtime-types.ts:217
    preStep: 'agent/pre-step', // runtime-types.ts:231
    preToolExecute: 'tools/pre-execute', // tools/src/index.ts:152
    postToolExecute: 'tools/post-execute', // tools/src/index.ts:175
    turnStopping: 'agent/turn-stopping', // runtime-types.ts:278
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

test('the DSH guard refuses a force-push only when asked', async (t) => {
  const { fx } = await bootstrap(t);
  const exec = { arguments: { command: 'git push --force origin main' } };
  const allow = { kind: 'allow' };
  const previous = process.env.IMMUNE_GUARD;

  t.after(() => {
    if (previous === undefined) delete process.env.IMMUNE_GUARD;
    else process.env.IMMUNE_GUARD = previous;
  });

  // Default: the waterfall delegates, so the call proceeds.
  delete process.env.IMMUNE_GUARD;
  assert.deepEqual(
    await fx.waterfall(DSH_EVENTS.preToolExecute, [exec], () => allow),
    allow,
  );

  // deny: PreToolDecision carries a reason, and next() is never reached.
  process.env.IMMUNE_GUARD = 'deny';
  const denied = await fx.waterfall(DSH_EVENTS.preToolExecute, [exec], () => allow);
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /force-push-main/);

  // A harmless command still passes through.
  const harmless = { arguments: { command: 'git push origin feature/x' } };
  assert.deepEqual(
    await fx.waterfall(DSH_EVENTS.preToolExecute, [harmless], () => allow),
    allow,
  );
});

test('immune-learn preserves free-text prescriptions via pipe separators', async (t) => {
  const { fx, dbPath } = await bootstrap(t);

  const learn = (raw) => {
    const command = fx.commands.find((c) => c.name === 'immune-learn');
    return command.handler({ rawInput: raw });
  };

  // The pipe form keeps every segment intact — this is the regression this
  // test pins: whitespace splitting once truncated the prescription to its
  // last word ("用 pnpm 不要用 npm" -> "npm").
  const piped = learn('pnpm-lock.yaml 这个仓库 | npm 装依赖报错 | 用 pnpm 不要用 npm');
  assert.match(piped.text, /Learned #\d+/);

  const rule = queryAll(
    dbPath,
    'SELECT trigger_pattern, symptom, prescription FROM antibodies WHERE prescription LIKE ?',
    '%pnpm%',
  )[0];
  assert.ok(rule, 'the full prescription survived');
  assert.equal(rule.symptom, 'npm 装依赖报错');

  // Two-segment form: trigger = first token, prescription = the rest.
  const two = learn('vite.config.ts | 用 loadEnv 读环境变量');
  assert.match(two.text, /Learned #\d+/);

  // Too many segments is refused loudly rather than silently mangled.
  const tooMany = learn('a | b | c | d');
  assert.equal(tooMany.kind, 'error');
  assert.match(tooMany.text, /expected/);
});

test('the immune command reports the distill budget and can override it per session', async (t) => {
  const { fx } = await bootstrap(t);
  const run = (raw) => fx.commands.find((c) => c.name === 'immune').handler({ rawInput: raw });

  process.env.IMMUNE_DISTILL_BUDGET_MS = '9000';
  try {
    // View: falls back to the env var, and the source is named.
    assert.match(run('--budget').text, /distill budget: 9000 ms \(env IMMUNE_DISTILL_BUDGET_MS/);

    // Set: an in-session override takes effect immediately.
    assert.match(run('--budget 2500').text, /set to 2500 ms/);
    assert.match(run('--budget').text, /distill budget: 2500 ms \(session override\)/);

    // Clamp both ends so a typo cannot hang a turn or starve the drain.
    assert.match(run('--budget 500').text, /set to 1000 ms/);
    assert.match(run('--budget 999999').text, /set to 60000 ms/);

    // Reset returns to the environment.
    assert.match(run('--budget auto').text, /reset to 9000 ms/);
    assert.match(run('--budget').text, /distill budget: 9000 ms \(env/);
  } finally {
    delete process.env.IMMUNE_DISTILL_BUDGET_MS;
  }
});

test('the immune listing footer surfaces queue depth and the database path', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const listed = fx.commands.find((c) => c.name === 'immune').handler({ rawInput: '' });
  assert.equal(listed.kind, 'success');
  assert.match(listed.text, /distill budget \d+ ms/);
  assert.match(listed.text, /queued \d+/);
  assert.match(listed.text, /web tab (not loaded|not registered|registered|unknown|error)/);
  assert.ok(listed.text.includes(dbPath), 'the footer names the database in use');
});

test('the footer reports whether the host composed the web client row', async (t) => {
  // client-modules serves /plugins/<id>/client.js only for a declared bundle and
  // caches a negative verdict for the process; /immune has to be able to say.
  const cases = [
    [{ clientModules: { clientPath: () => '/plugins/dsh-immune-system/client.js?rev=abc' } }, /web tab registered/],
    [{ clientModules: { clientPath: () => undefined } }, /web tab not registered/],
    [{ clientModules: {} }, /web tab not loaded/],
  ];
  for (const [services, expected] of cases) {
    const { fx } = await bootstrap(t, services);
    const listed = fx.commands.find((c) => c.name === 'immune').handler({ rawInput: '' });
    assert.match(listed.text, expected);
  }
});

test('startup logs the web-tab state once the client registry is available', async (t) => {
  const { fx } = await bootstrap(t, {
    _child: { clientModules: { clientPath: () => '/plugins/dsh-immune-system/client.js?rev=abc' } },
  });
  const line = fx.logs.find((entry) => /web tab:/.test(entry.message));
  assert.ok(line, 'a web-tab line was logged at startup');
  assert.match(line.message, /web tab: registered/);
  assert.ok(fx.injections.some((item) => item.deps.includes('clientModules')), 'asked for clientModules');
});

test('no web-tab line when the host has no client registry at all', async (t) => {
  const { fx } = await bootstrap(t);
  assert.equal(fx.logs.some((entry) => /web tab:/.test(entry.message)), false);
});

test('1.5-DSH: an undelivered stuck hypothesis rides the turn-start injection once', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const agent = makeAgent('sess-stuck');

  // Two consecutive failures of an uncovered target left a stuck row behind.
  const { ImmuneStore } = await import('../dsh-immune-system/dist/core/store/index.js');
  const store = new ImmuneStore({ dbPath });
  store.recordStuckFailure(agent.id, 'Bash:weirdtool:deploy');
  store.recordStuckFailure(agent.id, 'Bash:weirdtool:deploy');
  store.close();

  const prompt = userMessage('m-1', 'deploy the weird tool again');
  const first = await preStepAt(fx, agent, [prompt], 2, 1);
  assert.equal(first.kind, 'enter');
  const injected = first.messages.map((m) => messageText(m)).join('\n');
  assert.match(injected, /连续失败两次/, 'the hypothesis rides the turn-start block');
  assert.match(injected, /weirdtool/, 'it names the stuck target');

  // Once per streak: the next turn delivers nothing stuck (marked delivered).
  const second = await preStepAt(fx, agent, [userMessage('m-2', 'deploy again')], 3, 1);
  const secondText = second.messages.map((m) => messageText(m)).join('\n');
  assert.doesNotMatch(secondText, /连续失败两次/, 'no repeat delivery');
});

test('DSH parity: postToolExecute records stuck failures; sessionStart skips echo dumps & records injections', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const { ImmuneStore } = await import('../dsh-immune-system/dist/core/store/index.js');

  const s = new ImmuneStore({ dbPath });
  const echoId = s.insert({
    trigger_pattern: 'Bash long echo dump',
    symptom: 'long cmd failed',
    prescription: 'Bash: npx vite build --mode production --sourcemap --emptyOutDir',
    tool_name: 'Bash',
  });
  const adviceId = s.insert({
    trigger_pattern: 'Bash real advice rule',
    symptom: 'wrong pkg manager',
    prescription: 'Use pnpm instead of npm in this workspace',
    tool_name: 'Bash',
  });
  // Make the echo rule have higher hit_count so an unfiltered slice(0, 3) would prefer it.
  s['db'].prepare('UPDATE antibodies SET hit_count = 20 WHERE id = ?').run(echoId);
  s['db'].prepare('UPDATE antibodies SET hit_count = 5 WHERE id = ?').run(adviceId);
  s.close();

  const agent = makeAgent('sess-parity');
  fx.emit(DSH_EVENTS.sessionStart, { agent, source: 'startup' });
  assert.equal(agent.inbox.length, 1, 'sessionStart primes advice rule');
  const primeText = messageText(agent.inbox[0]);
  assert.match(primeText, /Use pnpm instead of npm/);
  assert.doesNotMatch(primeText, /--emptyOutDir/, 'echo-grade command dump is filtered from priming');

  const injected = queryAll(dbPath, 'SELECT ids FROM session_injections WHERE session_id = ?', agent.id);
  assert.equal(injected.length, 1);
  assert.deepEqual(
    JSON.parse(injected[0].ids),
    [adviceId],
    'sessionStart records primed antibody ids for anti-rot attribution',
  );

  // Drive two consecutive uncovered non-zero Bash failures through postToolExecute -> preStepAt sees hypothesis.
  const failExec1 = makeExec(agent, { arguments: { command: 'cargo build --release' } });
  const failExec2 = makeExec(agent, { arguments: { command: 'cargo build --release' } });
  await postTool(fx, failExec1, bashResult({ exitCode: 101, text: 'error[E0432]: unresolved import' }));
  await postTool(fx, failExec2, bashResult({ exitCode: 101, text: 'error[E0432]: unresolved import' }));

  const decision = await preStepAt(fx, agent, [userMessage('m-stuck', 'fix cargo build')], 2, 1);
  const injectedTurn = decision.messages.map((m) => messageText(m)).join('\n');
  assert.match(injectedTurn, /连续失败两次/, 'postToolExecute -> topStuck loop fires automatically on DSH');
});

test('DSH parity: normalises TargetFile repair paths and skips self-noise in drain', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const agent = makeAgent('sess-repair-rel');

  await postTool(
    fx,
    makeExec(agent, { arguments: { command: 'npm run lint' } }),
    thrownResult('config error in src/sub/config.json'),
  );
  await postTool(
    fx,
    makeExec(agent, {
      name: 'edit',
      arguments: { TargetFile: join(process.cwd(), 'src', 'sub', 'config.json') },
    }),
    { isError: false, content: [{ type: 'text', text: 'updated' }], value: { ok: true } },
  );
  await postTool(
    fx,
    makeExec(agent, { arguments: { command: 'npm run lint' } }),
    bashResult({ exitCode: 0, text: 'lint ok' }),
  );
  await runTurnStopping(fx, agent, 1);

  const jobs = queryAll(dbPath, "SELECT status, repair_path FROM distill_jobs WHERE status = 'done'");
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0].repair_path), ['edit src/sub/config.json']);

  // Self-noise job whose success trace touches the plugin itself is skipped at drain time
  const { ImmuneStore } = await import('../dsh-immune-system/dist/core/store/index.js');
  const s = new ImmuneStore({ dbPath });
  const jobId = s.enqueueJob(
    'Bash',
    'Bash {"command":"echo hello"} error=fail',
    `Bash {"command":"node ${join(process.cwd(), 'dsh', 'src', 'index.ts')}"} result=ok`,
    [],
  );
  s.close();

  await runTurnStopping(fx, agent, 2);
  const skipped = queryAll(dbPath, 'SELECT status, note FROM distill_jobs WHERE id = ?', jobId);
  assert.equal(skipped[0].status, 'skipped');
  assert.match(skipped[0].note, /self-noise/);
});

test('DSH /immune-export enforces the share gate when rules leak paths or emails', async (t) => {
  const { fx, dbPath } = await bootstrap(t);
  const { ImmuneStore } = await import('../dsh-immune-system/dist/core/store/index.js');
  const s = new ImmuneStore({ dbPath });
  const badId = s.insert({
    trigger_pattern: 'Edit C:\\Users\\alice\\config.ts',
    symptom: 'edited wrong file',
    prescription: 'read workspace relative file first',
  });
  s['db'].prepare('UPDATE antibodies SET hit_count = 5 WHERE id = ?').run(badId);
  s.close();

  const blocked = fx.commands.find((c) => c.name === 'immune-export').handler({ rawInput: '' });
  assert.equal(blocked.kind, 'error');
  assert.match(blocked.text, /export blocked by the share gate/);
});


