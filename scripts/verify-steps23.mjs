/**
 * Steps 2 + 3 of the handoff verification, driving the BUILT plugin through a
 * minimal fake Cordis context. IMMUNE_DB_PATH points at a throwaway file so the
 * assertions can read the real sqlite state afterwards.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'immune-verify-'));
const dbPath = join(dir, 'immune.sqlite');
process.env.IMMUNE_DB_PATH = dbPath;

const { apply, name, inject } = await import('../dsh-immune-system/dist/dsh/src/index.js');
const { DSH_EVENTS } = await import('../dsh-immune-system/dist/dsh/src/dsh-adapter.js');

console.log(`plugin name = ${name}, inject = ${JSON.stringify(inject)}`);
console.log(`db = ${dbPath}\n`);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`); }
}

// ---- minimal fake Cordis context -------------------------------------------
const listeners = new Map();
const injected = [];   // messages delivered through agent.inject()
const logs = [];
const effects = [];
const commands = new Map();

const ctx = {
  logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(listener);
    return () => true;
  },
  effect(execute) { effects.push(execute); return () => {}; },
  commands: { register(def) { commands.set(def.name, def); return () => {}; } },
};

apply(ctx);

check('registered session-start listener', listeners.has(DSH_EVENTS.sessionStart), true);
check('registered pre-step listener', listeners.has(DSH_EVENTS.preStep), true);
check('registered post-execute listener', listeners.has(DSH_EVENTS.postToolExecute), true);
check('registered turn-stopping listener', listeners.has(DSH_EVENTS.turnStopping), true);
check('registered commands', [...commands.keys()].sort(), ['immune', 'immune-export', 'immune-forget', 'immune-learn']);
check('logged storage path', logs.some(([, m]) => m.includes(dbPath)), true);

// ---- helpers ---------------------------------------------------------------
const agent = (id) => ({ id, session: { header: { id } }, inject: (m) => injected.push({ id, message: m }) });
const execFor = (a, command) => ({ callId: `c-${Math.random()}`, name: 'bash', arguments: { command }, agent: a, signal: { aborted: false } });

async function emitPostTool(a, command, text, value) {
  const exec = execFor(a, command);
  const result = { isError: false, value, content: [{ type: 'text', text }] };
  const next = async () => ({ kind: 'accept' });
  for (const l of listeners.get(DSH_EVENTS.postToolExecute)) await l(exec, result, next);
}

/** Emit a tool result for an arbitrary tool (the action-diff scenarios need Edit). */
async function emitTool(a, name, args, text, value = {}) {
  const exec = { callId: `c-${Math.random()}`, name, arguments: args, agent: a, signal: { aborted: false } };
  const result = { isError: false, value, content: [{ type: 'text', text }] };
  const next = async () => ({ kind: 'accept' });
  for (const l of listeners.get(DSH_EVENTS.postToolExecute)) await l(exec, result, next);
}

// ---- step 2: fail, then succeed, same session + same tool ------------------
console.log('\n[step 2] same session, same tool: failure -> success');
const a1 = agent('sess-1');

await emitPostTool(a1, 'npm run build', 'sh: tsc: command not found\n[exit code: 127]', { exitCode: 127 });
console.log('  ...failure recorded');
await emitPostTool(a1, 'npm run build', 'tsc compiled 42 files\n(clean exit)', { exitCode: 0 });
console.log('  ...success claimed');

// distillation is turn-end work, so close the turn before reading the table
async function closeTurn(a) {
  for (const l of listeners.get(DSH_EVENTS.turnStopping) ?? []) {
    await l({ agent: a, turn: 1, signal: { aborted: false } });
  }
}
await closeTurn(a1);
console.log('  ...turn closed (distillation runs here)');

// read the real sqlite file
const db = new DatabaseSync(dbPath);
const rows = db.prepare('SELECT id, trigger_pattern, symptom, prescription, tool_name, status FROM antibodies').all();
console.log(`  antibodies rows = ${rows.length}`);
for (const r of rows) console.log(`    #${r.id} tool=${r.tool_name} trigger=${JSON.stringify(r.trigger_pattern)} status=${r.status}`);
check('exactly one antibody distilled', rows.length, 1);
check('antibody is bound to the tool', rows[0]?.tool_name, 'bash');
check('antibody is active', rows[0]?.status, 'active');
check('trigger is non-empty', (rows[0]?.trigger_pattern ?? '').length > 0, true);

// ---- step 3: a NEW session asks a related question --------------------------
console.log('\n[step 3] new session asks a related question');
const a2 = agent('sess-2');
const question = rows[0]?.trigger_pattern ?? 'npm run build';
const prompt = { id: 'u1', role: 'user', content: [{ type: 'text', text: promptFallback(question) }], source: { kind: 'user' } };

function promptFallback(trigger) {
  // Use the distilled trigger itself so FTS matching cannot miss on phrasing.
  return `${trigger} 这个又失败了，帮我看看`;
}

const claimed = [prompt];
const next = async () => ({ kind: 'enter', messages: claimed });

let decision;
for (const l of listeners.get(DSH_EVENTS.preStep)) {
  decision = await l({ agent: a2, messages: claimed, turn: 1, step: 1, signal: { aborted: false } }, next);
}

const entered = decision.messages ?? [];
const block = entered.map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join('\n');
console.log(`  decision kind = ${decision.kind}, messages in = ${claimed.length}, out = ${entered.length}`);
console.log('  injected block:\n' + block.split('\n').map((l) => `    | ${l}`).join('\n'));

check('decision is enter', decision.kind, 'enter');
check('a message was spliced in', entered.length, claimed.length + 1);
check('block is wrapped in <immune_memory>', /<immune_memory>[\s\S]*<\/immune_memory>/.test(block), true);
check('block carries the distilled prescription', block.includes(rows[0]?.prescription ?? '\u0000'), true);
check('spliced message is labelled as plugin output', entered.some((m) => m.source?.kind === 'plugin'), true);
check('human prompt still present', entered.some((m) => m.source?.kind === 'user'), true);

// ---- [action diff] the repair write travels with the episode ----------------
console.log('\n[action diff] failure -> Edit repair -> same retry');
const a4 = agent('sess-4');
await emitPostTool(a4, 'cargo test', 'error[E0433]: could not compile\n[exit code: 101]', { exitCode: 101 });
// The repair happens under a DIFFERENT tool while the Bash episode is open.
await emitTool(a4, 'Edit', { file_path: '/w/Cargo.toml' }, 'patched');
await emitPostTool(a4, 'cargo test', 'test result: ok. 42 passed\n(clean exit)', { exitCode: 0 });
await closeTurn(a4);
const job4 = db
  .prepare("SELECT success_trace FROM distill_jobs WHERE tool_name = 'bash' ORDER BY id DESC LIMIT 1")
  .get();
check(
  'the repair action reached the distilled job',
  (job4?.success_trace ?? '').includes('repair actions: Edit Cargo.toml'),
  true,
);

// ---- [probe thrash] three same-target probes earn one nudge -----------------
console.log('\n[probe thrash] the nudge arrives at the next turn start');
const a5 = agent('sess-5');
for (let i = 0; i < 3; i += 1) await emitPostTool(a5, 'cat package.json', '{"name": "x"}');
const claimed5 = [
  { id: 'u5', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } },
];
let d5;
for (const l of listeners.get(DSH_EVENTS.preStep)) {
  d5 = await l(
    { agent: a5, messages: claimed5, turn: 2, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: claimed5 }),
  );
}
const block5 = (d5?.messages ?? [])
  .map((m) => (m.content ?? []).map((b) => b.text ?? '').join(''))
  .join('\n');
check('probe-thrash note delivered at turn start', block5.includes('probe note'), true);

// ---- extra: injected memory is a well-formed plugin message ------------------
console.log('\n[extra] session-start priming via agent.inject()');
const a3 = agent('sess-3');
for (const l of listeners.get(DSH_EVENTS.sessionStart)) l({ agent: a3, source: 'startup' });
const priming = injected.find((x) => x.id === 'sess-3')?.message;
check('inject() received a message', priming !== undefined, true);
check('role is user', priming?.role, 'user');
check('source is plugin', priming?.source, { kind: 'plugin', plugin: 'dsh-immune-system' });
check('has a uuid id', /^[0-9a-f-]{36}$/.test(priming?.id ?? ''), true);
check('priming mentions immune_memory', (priming?.content?.[0]?.text ?? '').includes('<immune_memory>'), true);

// ---- teardown effect --------------------------------------------------------
console.log('\n[extra] ctx.effect registered a dispose hook');
check('one effect registered', effects.length, 1);
effects[0]();
console.log('  dispose ran without throwing');

db.close();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows keeps the WAL handle briefly; the temp dir is throwaway either way.
}

console.log(`\n=== steps 2+3: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
