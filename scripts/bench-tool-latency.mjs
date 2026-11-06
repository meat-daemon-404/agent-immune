/**
 * Benchmark: where does distillation cost land — on the tool path or the turn
 * boundary?
 *
 * The adapter queues a distill job in `tools/post-execute` and drains the queue
 * in `agent/turn-stopping`. This script measures both with a deliberately slow
 * mock LLM endpoint, so the two costs are visible separately:
 *
 *   post-execute  -> must stay in the sub-millisecond range (no HTTP here)
 *   turn-stopping -> pays one HTTP round trip per queued job
 *
 * The old design (drain inline in post-execute) would have added the
 * turn-stopping figure to *every* tool result on the path.
 *
 * Run: node scripts/bench-tool-latency.mjs
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DELAY_MS = Number(process.env.BENCH_DELAY_MS ?? '1500');
const EPISODES = Number(process.env.BENCH_EPISODES ?? '3');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------ *
 * A deliberately slow, OpenAI-compatible stand-in for the model endpoint
 * ------------------------------------------------------------------ */

function startSlowModelServer() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      setTimeout(() => {
        const payload = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  trigger: 'vite config env',
                  symptom: 'process.env reads undefined for client vars',
                  prescription: 'use loadEnv in vite.config.ts',
                }),
              },
            },
          ],
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      }, DELAY_MS);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ------------------------------------------------------------------ *
 * Minimal Cordis-shaped host, identical in behaviour to the unit tests
 * ------------------------------------------------------------------ */

function fakeContext() {
  const listeners = new Map();
  const disposers = [];
  const commands = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return () => true;
    },
    effect(execute, label) {
      const dispose = execute();
      const handle = { label, dispose: () => dispose?.() };
      disposers.push(handle);
      return handle;
    },
    commands: { register(definition) { commands.push(definition); return () => {}; } },
  };
  return {
    ctx,
    listeners,
    commands,
    disposers,
    waterfall(event, args, base) {
      const chain = [...(listeners.get(event) ?? [])];
      const step = (index) =>
        index >= chain.length
          ? Promise.resolve(base())
          : Promise.resolve(chain[index](...args, () => step(index + 1)));
      return step(0);
    },
    async mode(event, args) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        await listener(...args);
      }
    },
  };
}

function makeAgent(id) {
  const inbox = [];
  return { id, session: { header: { id } }, inject(m) { inbox.push(m); }, inbox };
}

function execFor(agent, command) {
  return {
    callId: `call-${Math.random().toString(36).slice(2)}`,
    name: 'bash',
    arguments: { command },
    agent,
    signal: { aborted: false },
  };
}

function failedResult(text) {
  return { isError: false, value: { exitCode: 127 }, content: [{ type: 'text', text }] };
}

function okResult(text) {
  return { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text }] };
}

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), 'immune-bench-'));
const dbPath = join(dir, 'immune.sqlite');
const server = await startSlowModelServer();
const port = server.address().port;

process.env.IMMUNE_DB_PATH = dbPath;
process.env.IMMUNE_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.IMMUNE_LLM_MODEL = 'bench-slow-model';
process.env.IMMUNE_ALLOW_PRIVATE_ENDPOINT = '1';
process.env.IMMUNE_LLM_TIMEOUT_MS = '30000';

// Import only after the environment is in place: the store resolves its path
// and the distiller reads its config at use time.
const plugin = await import(new URL('../dsh-immune-system/dist/dsh/src/index.js', import.meta.url).href);
const { DSH_EVENTS } = plugin;

const host = fakeContext();
plugin.apply(host.ctx);

const agent = makeAgent('bench-session');
const postToolSamples = [];

async function postTool(exec, result) {
  const started = process.hrtime.bigint();
  await host.waterfall(DSH_EVENTS.postToolExecute, [exec, result], async () => ({ kind: 'accept' }));
  return Number(process.hrtime.bigint() - started) / 1e6;
}

console.log(`mock model endpoint: http://127.0.0.1:${port}/v1  (delay ${DELAY_MS} ms per call)`);
console.log(`learning ${EPISODES} episodes...`);

for (let index = 0; index < EPISODES; index += 1) {
  const failure = execFor(agent, `npm run build --episode ${index}`);
  postToolSamples.push(await postTool(failure, failedResult('sh: tsc: command not found\n[exit code: 127]')));
  const success = execFor(agent, `npm run build --episode ${index}`);
  postToolSamples.push(await postTool(success, okResult('compiled ok')));
}

const turnStarted = process.hrtime.bigint();
await host.mode(DSH_EVENTS.turnStopping, [{ agent, turn: 1, signal: { aborted: false } }]);
const turnMs = Number(process.hrtime.bigint() - turnStarted) / 1e6;

const db = new DatabaseSync(dbPath);
const rows = db.prepare('SELECT id FROM antibodies').all();
db.close();

const postMedian = median(postToolSamples);
const postWorst = Math.max(...postToolSamples);

const line = (label, value, note) =>
  console.log(`  ${label.padEnd(34)} ${value.padStart(10)}   ${note}`);

console.log(`\n${'metric'.padEnd(36)}${'ms'.padStart(10)}`);
console.log('  ' + '-'.repeat(56));
line(`tools/post-execute  median (${postToolSamples.length} calls)`, postMedian.toFixed(3), 'no HTTP on the tool path');
line('tools/post-execute  worst', postWorst.toFixed(3), 'still includes rendering + judge');
line(`agent/turn-stopping  (${EPISODES} queued jobs)`, turnMs.toFixed(1), 'one model round trip per job');
line('derived: per-tool cost if drained inline', `${postMedian.toFixed(3)} + ${turnMs.toFixed(0)}`, `= ${(postMedian + turnMs).toFixed(1)} ms per call`);
console.log(`\nantibodies distilled: ${rows.length}`);
console.log(`budget check: turn-stopping ${turnMs.toFixed(0)} ms vs drain budget 8000 ms`);

let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
};

console.log('');
check('post-execute median stays under 25 ms (no model call on the tool path)', postMedian < 25, postMedian);
check('post-execute worst stays under 100 ms', postWorst < 100, postWorst);
check(`turn-stopping pays at least ${Math.round(DELAY_MS * 0.8)} ms`, turnMs >= DELAY_MS * 0.8, turnMs);
check('turn-stopping stays inside the 8000 ms drain budget', turnMs < 8000, turnMs);
check('every queued episode distilled', rows.length === EPISODES, rows.length);

server.close();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows keeps the WAL handle briefly; the temp dir is disposable.
}

console.log(`\n=== latency bench: ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failed) ===`);
process.exit(failed === 0 ? 0 : 1);
