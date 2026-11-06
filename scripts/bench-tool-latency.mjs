/**
 * Benchmark: where does distillation cost land — on the tool path or the turn
 * boundary — and how does the turn-end drain scale with queue depth?
 *
 * The adapter queues a distill job in `tools/post-execute` and drains the queue
 * in `agent/turn-stopping`, under `IMMUNE_DISTILL_BUDGET_MS` (default 12 s).
 * A deliberately slow mock model makes both costs measurable:
 *
 *   post-execute  -> sub-millisecond, no HTTP on the tool path
 *   turn-stopping -> one model round trip per queued job, capped by the budget
 *
 * The old design (drain inline in post-execute) would have added the
 * turn-stopping figure to *every* tool result on the path.
 *
 * Run: node scripts/bench-tool-latency.mjs
 *   BENCH_DELAY_MS=1500  per-call model latency for the mock endpoint
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DELAY_MS = Number(process.env.BENCH_DELAY_MS ?? '1500');
const HEADLINE_EPISODES = 3;
const CURVE = [1, 2, 3, 5];
const BUDGET_TEST_EPISODES = 6;
const BUDGET_TEST_MS = 3000;

const dir = mkdtempSync(join(tmpdir(), 'immune-bench-'));
const dbs = [];

/* ------------------------------------------------------------------ *
 * A deliberately slow, OpenAI-compatible stand-in for the model endpoint
 * ------------------------------------------------------------------ */

function startSlowModelServer() {
  const server = createServer((req, res) => {
    req.on('data', () => {});
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

const failedResult = (text) => ({ isError: false, value: { exitCode: 127 }, content: [{ type: 'text', text }] });
const okResult = (text) => ({ isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text }] });

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/* ------------------------------------------------------------------ */

const server = await startSlowModelServer();
const port = server.address().port;

process.env.IMMUNE_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.IMMUNE_LLM_MODEL = 'bench-slow-model';
process.env.IMMUNE_ALLOW_PRIVATE_ENDPOINT = '1';
process.env.IMMUNE_LLM_TIMEOUT_MS = '30000';

const plugin = await import(new URL('../dsh-immune-system/dist/dsh/src/index.js', import.meta.url).href);
const { DSH_EVENTS } = plugin;

/**
 * Learn `episodes` fail→success pairs into a fresh database, then drain at the
 * turn boundary. Returns the measured latencies.
 */
async function runScenario(label, episodes, budgetMs) {
  const dbPath = join(dir, `${label}.sqlite`);
  dbs.push(dbPath);
  process.env.IMMUNE_DB_PATH = dbPath;
  if (budgetMs === undefined) delete process.env.IMMUNE_DISTILL_BUDGET_MS;
  else process.env.IMMUNE_DISTILL_BUDGET_MS = String(budgetMs);

  const host = fakeContext();
  plugin.apply(host.ctx);
  const agent = makeAgent(`bench-${label}`);
  const postToolSamples = [];

  const postTool = async (exec, result) => {
    const started = process.hrtime.bigint();
    await host.waterfall(DSH_EVENTS.postToolExecute, [exec, result], async () => ({ kind: 'accept' }));
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  for (let index = 0; index < episodes; index += 1) {
    postToolSamples.push(
      await postTool(execFor(agent, `npm run build --episode ${index}`), failedResult('sh: tsc: command not found\n[exit code: 127]')),
    );
    postToolSamples.push(
      await postTool(execFor(agent, `npm run build --episode ${index}`), okResult('compiled ok')),
    );
  }

  const turnStarted = process.hrtime.bigint();
  await host.mode(DSH_EVENTS.turnStopping, [{ agent, turn: 1, signal: { aborted: false } }]);
  const turnMs = Number(process.hrtime.bigint() - turnStarted) / 1e6;

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT id FROM antibodies').all().length;
  db.close();

  return { episodes, postMedian: median(postToolSamples), postWorst: Math.max(...postToolSamples), turnMs, rows };
}

console.log(`mock model endpoint: http://127.0.0.1:${port}/v1  (delay ${DELAY_MS} ms per call)\n`);

const headline = await runScenario('headline', HEADLINE_EPISODES);
console.log(`headline (${HEADLINE_EPISODES} episodes, default 12 s budget)`);
console.log(`  tools/post-execute  median ${headline.postMedian.toFixed(3)} ms | worst ${headline.postWorst.toFixed(3)} ms`);
console.log(`  agent/turn-stopping ${headline.turnMs.toFixed(0)} ms for ${headline.rows} distilled job(s)`);
console.log(`  if drained inline in post-execute: ${(headline.postMedian + headline.turnMs).toFixed(0)} ms added to EVERY tool result\n`);

console.log(`drain curve (default budget)            episodes   distilled   turn-stopping   post-exec median`);
const curve = [];
for (const episodes of CURVE) {
  const row = await runScenario(`curve-${episodes}`, episodes);
  curve.push(row);
  console.log(
    ' '.repeat(40) +
      String(row.episodes).padStart(8) +
      String(row.rows).padStart(12) +
      `${row.turnMs.toFixed(0)} ms`.padStart(15) +
      `${row.postMedian.toFixed(3)} ms`.padStart(18),
  );
}

const capped = await runScenario('budget', BUDGET_TEST_EPISODES, BUDGET_TEST_MS);
console.log(
  `\nbudget cap (IMMUNE_DISTILL_BUDGET_MS=${BUDGET_TEST_MS}, ${BUDGET_TEST_EPISODES} queued): ` +
    `turn-stopping ${capped.turnMs.toFixed(0)} ms, distilled ${capped.rows}/${capped.episodes}, ` +
    `${capped.episodes - capped.rows} left for the next boundary`,
);

/* ------------------------------------------------------------------ */

let failed = 0;
const check = (label, condition, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!condition) failed += 1;
};

console.log('');
check('post-execute median stays under 25 ms (no model call on the tool path)', headline.postMedian < 25, headline.postMedian);
check('post-execute worst stays under 100 ms', headline.postWorst < 100, headline.postWorst);
check(`headline turn-stopping pays at least ${Math.round(DELAY_MS * 0.8)} ms`, headline.turnMs >= DELAY_MS * 0.8, headline.turnMs);
check('headline distils every queued episode', headline.rows === HEADLINE_EPISODES, headline.rows);

for (const row of curve) {
  check(`curve(${row.episodes}): every episode distilled`, row.rows === row.episodes, row.rows);
  check(`curve(${row.episodes}): drain scales with queue depth`, row.turnMs >= row.episodes * DELAY_MS * 0.8, row.turnMs);
  check(`curve(${row.episodes}): tool path still free of the model`, row.postMedian < 25, row.postMedian);
}
check('drain curve is monotonic in wall-clock', curve.every((row, i) => i === 0 || row.turnMs > curve[i - 1].turnMs), curve.map((r) => Math.round(r.turnMs)));

check(`budget cap holds (<= ${BUDGET_TEST_MS + 2 * DELAY_MS} ms)`, capped.turnMs <= BUDGET_TEST_MS + 2 * DELAY_MS, capped.turnMs);
check('budget cap leaves work for the next boundary', capped.rows < capped.episodes, capped.rows);

server.close();
for (const dbPath of dbs) {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    // Windows can keep the WAL handle briefly; temp files are disposable.
  }
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // same
}

console.log(`\n=== latency bench: ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failed) ===`);
process.exit(failed === 0 ? 0 : 1);
