/**
 * Live host verification — runs the plugin inside a REAL Cordis host.
 *
 * Unlike `test/dsh.test.mjs` (a minimal fake Context, runnable anywhere), this
 * mounts the actual `@deepseek-ai/*` service plugins in a real `Context`, loads
 * the built plugin through `ctx.plugin()`, and drives the REAL event buses:
 *
 *   1. `tools/post-execute` waterfall — a bash non-zero exit must be judged a
 *      failure; the failure→fix pair must distil one antibody into SQLite.
 *   2. `agent/pre-step` waterfall — a *new* session asking a related question
 *      must receive an `<immune_memory>` block in its messages.
 *
 * This needs the DSH profile dependency tree to resolve `@deepseek-ai/*`.
 * Resolution order for that directory:
 *   1. `$DSH_NODE_MODULES` if set
 *   2. `~/.dsh/profiles/node_modules`
 *   If neither has `@deepseek-ai/cordis`, the script prints SKIP and exits 0
 *   (so it is safe to run on a machine without DSH installed).
 *
 * Run:  node scripts/verify-live-host.mjs
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const candidates = [];
if (process.env.DSH_NODE_MODULES) candidates.push(process.env.DSH_NODE_MODULES);
candidates.push(join(homedir(), '.dsh', 'profiles', 'node_modules'));

const base = candidates.find((dir) => existsSync(join(dir, '@deepseek-ai', 'cordis', 'package.json')));
if (!base) {
  console.log('SKIP: no @deepseek-ai/* dependency tree found (set DSH_NODE_MODULES).');
  process.exit(0);
}

/** Import a package out of the DSH dependency tree by absolute file URL. */
const dep = async (pkg) => import(pathToFileURL(join(base, '@deepseek-ai', pkg, 'lib', 'index.js')).href);

const { Context } = await dep('cordis');
const Commands = (await dep('dsh-commands')).default;
const Llm = (await dep('dsh-llm')).default;
const Session = (await dep('dsh-session')).default;
const SystemPrompt = (await dep('dsh-system-prompt')).default;
const Tools = (await dep('dsh-tools')).default;
const Agent = (await dep('dsh-agent')).default;
const { DatabaseSync } = await import('node:sqlite');

const dbDir = mkdtempSync(join(tmpdir(), 'immune-live-'));
process.env.IMMUNE_DB_PATH = join(dbDir, 'immune.sqlite');

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
  }
};

const ctx = new Context();
for (const svc of [Llm, Session, SystemPrompt, Tools, Agent, Commands]) {
  await ctx.plugin(svc);
}

const plugin = await import(pathToFileURL(join(import.meta.dirname, '..', 'dsh-immune-system', 'dist', 'dsh', 'src', 'index.js')).href);
const fiber = ctx.plugin(plugin);
await fiber;

console.log('[mount] real Cordis host');
check('service `tools` is live', typeof ctx.get('tools') === 'object');
check('service `commands` is live', typeof ctx.get('commands') === 'object');
check('plugin declares inject=[commands]', JSON.stringify(plugin.inject) === JSON.stringify(['commands']));
check('plugin name', plugin.name === 'dsh-immune-system', plugin.name);

const agent = (id) => ({ id, session: { header: { id } }, inject() {} });
const exec = (a, args) => ({ callId: 'call-' + Math.random().toString(36).slice(2), name: 'bash', arguments: args, agent: a, signal: { aborted: false } });
const acceptOnly = async () => ({ kind: 'accept' });

// ---- 1. real tools/post-execute waterfall: non-zero exit is a failure ----
console.log('[1] tools/post-execute waterfall under a real event bus');
const failText = { type: 'text', text: 'npm ERR! Missing script: "buidl"\n[exit code: 1]' };
const failRes = { isError: false, value: { exitCode: 1 }, content: [failText] };
const d1 = await ctx.waterfall('tools/post-execute', exec(agent('sess-A'), { command: 'npm run buidl' }), failRes, acceptOnly);
check('listener returns an accept decision', d1 && d1.kind === 'accept', d1);

const okText = { type: 'text', text: 'added 0 packages' };
const okRes = { isError: false, value: { exitCode: 0 }, content: [okText] };
const d2 = await ctx.waterfall('tools/post-execute', exec(agent('sess-A'), { command: 'npm run buidl' }), okRes, acceptOnly);
check('second listener call also accepts', d2 && d2.kind === 'accept', d2);

// Distillation is turn-end work now, so close the turn and wait for the row.
console.log('[1b] agent/turn-stopping — distillation runs at turn close');
const { emitAgentEvent } = await dep('dsh-agent');
const agentA = agent('sess-A');
emitAgentEvent(ctx, agentA, 'agent/turn-stopping', { agent: agentA, turn: 1, signal: { aborted: false } });
const readAntibodies = () => {
  const handle = new DatabaseSync(process.env.IMMUNE_DB_PATH);
  try {
    return handle.prepare('select id, tool_name, status, trigger_pattern, prescription from antibodies').all();
  } finally {
    handle.close();
  }
};
let antibodies = [];
for (let attempt = 0; attempt < 240; attempt += 1) {
  antibodies = readAntibodies();
  if (antibodies.length > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}

console.log('[2] sqlite antibodies after fail->success');
console.log('     ', JSON.stringify(antibodies));
check('exactly one antibody distilled', antibodies.length === 1, antibodies.length);
check('antibody is active and from bash', antibodies[0] && antibodies[0].status === 'active' && antibodies[0].tool_name === 'bash');

// ---- 2. real agent/pre-step waterfall: a new session gets the recall block ----
console.log('[3] agent/pre-step waterfall for a fresh session');
const userMsg = { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'how do I run the build script?' }], source: { kind: 'user' } };
const enterWith = (messages) => async () => ({ kind: 'enter', messages: [userMsg] });
const payload = { agent: agent('sess-B'), messages: [userMsg], turn: 1, step: 1, signal: { aborted: false } };
const decision = await ctx.waterfall('agent/pre-step', payload, enterWith([userMsg]));
check('decision is enter', decision.kind === 'enter', decision.kind);
const injected = decision.messages.filter((m) => m.source && m.source.kind === 'plugin');
check('one plugin message injected', injected.length === 1, injected.length);
const block = injected.length === 1 ? injected[0].content.map((b) => b.text || '').join('') : '';
check('block is wrapped in <immune_memory>', block.startsWith('<immune_memory>') && block.trimEnd().endsWith('</immune_memory>'));
check('block carries the distilled prescription', block.includes('bash: npm run buidl'));
check('human prompt survives', decision.messages.some((m) => m.source && m.source.kind === 'user'));
console.log('--- injected block ---');
console.log(block);

// ---- 3. real agent/session-start emit: priming reaches agent.inject() ----
console.log('[4] agent/session-start through the host emit path');
const primed = [];
const agentC = { id: 'sess-C', session: { header: { id: 'sess-C' } }, inject(m) { primed.push(m); } };
check('host exposes emitAgentEvent', typeof emitAgentEvent === 'function');
emitAgentEvent(ctx, agentC, 'agent/session-start', { source: 'startup' });
check('session-start primed exactly one message', primed.length === 1, primed.length);
const primedText = primed.length === 1 ? primed[0].content.map((b) => b.text || '').join('') : '';
check('primed message is a frozen plugin message', primed.length === 1 && primed[0].role === 'user' && primed[0].source.kind === 'plugin' && primed[0].source.plugin === 'dsh-immune-system');
check('primed message carries the recall block', primedText.includes('<immune_memory>') && primedText.includes('bash: npm run buidl'));

// ---- 4. cold resume: no human prompt in the batch, recall still fires ----
// A `resume`/`compact` start rebuilds the inbox from post-seed events only, so
// the first `agent/pre-step` batch has no human message. The plugin records
// prompts from the durable `user/message` stream to cover that gap.
console.log('[5] cold resume: recall from the remembered prompt');
const resumeSession = { header: { id: 'sess-R' }, id: 'sess-R' };
ctx.emit('session/event', resumeSession, {
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: { id: 'u-R', role: 'user', content: [{ type: 'text', text: 'how do I run the build script?' }], source: { kind: 'user' } },
});
const emptyNext = async () => ({ kind: 'enter', messages: [] });
const resumeDecision = await ctx.waterfall('agent/pre-step', { agent: agent('sess-R'), messages: [], turn: 1, step: 1, signal: { aborted: false } }, emptyNext);
const resumeInjected = resumeDecision.messages.filter((m) => m.source && m.source.kind === 'plugin');
check('resume batch had no human prompt but recall still injected', resumeInjected.length === 1, resumeInjected.length);
const resumeBlock = resumeInjected.length === 1 ? resumeInjected[0].content.map((b) => b.text || '').join('') : '';
check('resume block carries the antibody', resumeBlock.includes('bash: npm run buidl'));

// A plugin-sourced user/message must NOT be mistaken for a human prompt.
const before = await ctx.waterfall('agent/pre-step', { agent: agent('sess-X'), messages: [], turn: 1, step: 1, signal: { aborted: false } }, emptyNext);
check('unknown session injects nothing', before.messages.filter((m) => m.source && m.source.kind === 'plugin').length === 0);

console.log(`\n=== live host: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
