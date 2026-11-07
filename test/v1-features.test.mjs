import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';
import { prescriptionSimilarity, charTrigrams, jaccard } from '../dsh-immune-system/dist/core/similarity.js';
import {
  canCloseEpisode,
  parseCommand,
  targetSignature,
} from '../dsh-immune-system/dist/core/pairing.js';
import { rerank, timeDecay } from '../dsh-immune-system/dist/core/store/rerank.js';
import { distillBatch } from '../dsh-immune-system/dist/core/distiller.js';
import { parseBatchOutput } from '../dsh-immune-system/dist/core/prompts.js';

const store = () => new ImmuneStore({ dbPath: ':memory:' });

/* ---------------------------------------------------------------- *
 * Task 1 — repeat suppression
 * ---------------------------------------------------------------- */

test('an identical candidate set is suppressed without counting a hit', () => {
  const s = store();
  const id = s.insert({ trigger_pattern: 'vite.config.ts 构建', symptom: 's', prescription: 'p' });
  assert.ok(id);

  const opts = { limit: 3, sessionId: 'sess-r', suppressRepeats: true };

  const first = s.match('vite.config.ts 构建', opts);
  assert.equal(first.length, 1, 'first turn injects');
  assert.equal(s.listAll()[0].hit_count, 1, 'and counts one hit');

  for (let turn = 0; turn < 3; turn += 1) {
    assert.deepEqual(s.match('vite.config.ts 构建', opts), [], 'identical set stays silent');
  }
  assert.equal(s.listAll()[0].hit_count, 1, 'silent turns must not inflate hit_count');

  // The fourth silent turn exhausts the window: the set is delivered again.
  s.match('vite.config.ts 构建', opts);
  const after = s.match('vite.config.ts 构建', opts);
  assert.equal(after.length, 1, 'after SUPPRESS_WINDOW turns it injects again');
  s.close();
});

test('suppressed repeats accumulate in the value counter', () => {
  const s = store();
  s.insert({ trigger_pattern: 'vite.config.ts 构建', symptom: 's', prescription: 'pv' });
  const opts = { limit: 3, sessionId: 'sess-val', suppressRepeats: true };
  assert.equal(s.match('vite.config.ts 构建', opts).length, 1, 'first turn injects');
  const before = s.stats().suppressedRepeats;
  assert.equal(s.match('vite.config.ts 构建', opts).length, 0, 'identical second turn is silent');
  assert.equal(
    s.stats().suppressedRepeats,
    before + 1,
    'each prevented repeat is counted once',
  );
  s.close();
});

test('a changed candidate set resets suppression', () => {
  const s = store();
  const a = s.insert({ trigger_pattern: 'alpha.ts 构建', symptom: 's', prescription: 'pa' });
  const b = s.insert({ trigger_pattern: 'beta.ts 部署', symptom: 's', prescription: 'pb' });
  assert.ok(a && b);

  const opts = { limit: 3, sessionId: 'sess-c', suppressRepeats: true };
  s.match('alpha.ts 构建', opts);
  // Different query, different set: must inject immediately.
  const second = s.match('beta.ts 部署', opts);
  assert.equal(second.length, 1, 'a different set is never suppressed');
  s.close();
});

test('resume/clear/compact reset the suppression state', () => {
  const s = store();
  s.insert({ trigger_pattern: 'gamma.ts 构建', symptom: 's', prescription: 'pg' });
  const opts = { limit: 3, sessionId: 'sess-rs', suppressRepeats: true };
  s.match('gamma.ts 构建', opts);
  assert.deepEqual(s.match('gamma.ts 构建', opts), [], 'suppressed');

  s.resetTurnState('sess-rs');
  assert.equal(s.match('gamma.ts 构建', opts).length, 1, 'after a reset it injects again');
  s.close();
});

/* ---------------------------------------------------------------- *
 * Task 2 — target-scoped pairing
 * ---------------------------------------------------------------- */

test('read-only probes never close a failure episode', () => {
  const s = store();
  s.recordFailure('sess-p', 'Bash', 'npm run build -> error', targetSignature('Bash', { command: 'npm run build' }).signature);

  const probe = targetSignature('Bash', { command: 'git status' });
  assert.equal(probe.probeOnly, true);
  assert.equal(s.claimFailure('sess-p', 'Bash', probe), null, 'a probe leaves the episode open');

  // The real fix does close it.
  const fix = targetSignature('Bash', { command: 'npm install' });
  assert.ok(s.claimFailure('sess-p', 'Bash', fix), 'the same toolchain closes it');
  s.close();
});

test('unrelated tools are not paired, same-toolchain calls are', () => {
  const fail = targetSignature('Bash', { command: 'npm run build' });
  assert.equal(
    canCloseEpisode(fail.signature, targetSignature('Bash', { command: 'npx vite build' })),
    true,
    'npm -> npx is the same toolchain (a real fix shape)',
  );
  assert.equal(
    canCloseEpisode(fail.signature, targetSignature('Bash', { command: 'git status' })),
    false,
    'npm -> git status is unrelated',
  );
  assert.equal(
    canCloseEpisode(fail.signature, targetSignature('Edit', { file_path: 'a.ts' })),
    false,
    'a different tool never closes it',
  );
});

test('file tools pair on the same path, not on the tool name alone', () => {
  const failed = targetSignature('Edit', { file_path: 'C:\\repo\\src\\a.ts' }, 'C:\\repo');
  assert.equal(failed.signature, 'Edit:src/a.ts', 'paths normalise to project-relative');

  assert.equal(
    canCloseEpisode(failed.signature, targetSignature('Edit', { file_path: 'src/a.ts' })),
    true,
  );
  assert.equal(
    canCloseEpisode(failed.signature, targetSignature('Edit', { file_path: 'src/b.ts' })),
    false,
    'a different file is a different episode',
  );
});

test('command parsing extracts program and first non-flag subcommand', () => {
  assert.deepEqual(parseCommand('npm test'), { program: 'npm', sub: 'test' });
  assert.deepEqual(parseCommand('npm --silent run build'), { program: 'npm', sub: 'run' });
  assert.deepEqual(parseCommand('CI=1 pnpm -w build'), { program: 'pnpm', sub: 'build' });
  assert.equal(parseCommand('git status').program, 'git');
});

/* ---------------------------------------------------------------- *
 * Task 2 — Jaccard merge
 * ---------------------------------------------------------------- */

test('Jaccard similarity is computed over character trigrams', () => {
  assert.equal(jaccard(charTrigrams(''), charTrigrams('')), 0);
  assert.equal(prescriptionSimilarity('用 pnpm 装依赖', '用 pnpm 装依赖'), 1);
  const close = prescriptionSimilarity('用 pnpm 装依赖', '用 pnpm 安装依赖');
  assert.ok(close > 0.7, `near-duplicates should exceed 0.7, got ${close}`);
  const far = prescriptionSimilarity('用 pnpm 装依赖', '给路由加权限校验');
  assert.ok(far < 0.2, `unrelated text should stay low, got ${far}`);
});

test('a near-duplicate prescription merges instead of adding a row', () => {
  const s = store();
  const first = s.insert({
    trigger_pattern: 'pnpm-lock.yaml',
    symptom: 'npm 装依赖报错',
    prescription: '用 pnpm 装依赖',
  });
  assert.ok(first);

  const second = s.insert({
    trigger_pattern: 'pnpm-lock.yaml',
    symptom: 'npm 装依赖报错',
    prescription: '用 pnpm 安装依赖',
  });
  assert.equal(second, first, 'the near-duplicate merges into the existing rule');
  assert.equal(s.listAll().length, 1, 'no second row');

  const merged = s.listAll()[0];
  assert.equal(merged.hit_count, 1, 'a merge counts as another hit');
  s.close();
});

test('a human-corrected near-duplicate overwrites the stored wording', () => {
  const s = store();
  const id = s.insert({
    trigger_pattern: 'build',
    symptom: 'old symptom',
    prescription: '用 npm 构建项目',
  });
  assert.ok(id);

  const updated = s.insertShared(
    { trigger_pattern: 'build', symptom: '新症状', prescription: '用 pnpm 构建项目' },
    { humanHint: true },
  );
  assert.equal(updated, id);

  const row = s.listAll()[0];
  assert.equal(row.prescription, '用 pnpm 构建项目', 'human correction wins');
  assert.equal(row.symptom, '新症状');
  s.close();
});

test('a dissimilar prescription about the same trigger is kept separate', () => {
  const s = store();
  s.insert({ trigger_pattern: 'vite.config.ts', symptom: 's1', prescription: '用 loadEnv 读取环境变量' });
  s.insert({ trigger_pattern: 'vite.config.ts', symptom: 's2', prescription: '把 base 设为相对路径' });
  assert.equal(s.listAll().length, 2, 'different lessons about one file stay separate');
  s.close();
});

/* ---------------------------------------------------------------- *
 * Task 4 — rerank
 * ---------------------------------------------------------------- */

test('path affinity outranks a bare relevance win', () => {
  const s = store();
  const about = s.insert({
    trigger_pattern: 'src/app/vite.config.ts 构建',
    symptom: 's',
    prescription: 'px',
  });
  const unrelated = s.insert({
    trigger_pattern: 'deploy.sh 发布',
    symptom: 's',
    prescription: 'py',
  });
  assert.ok(about && unrelated);

  const rows = s.peek('vite.config.ts', 10);
  const ranked = rerank(rows, { query: '改一下 src/app/vite.config.ts' });
  assert.equal(ranked[0].id, about, 'the rule about the named file comes first');
  s.close();
});

test('time decay and shared discount are monotone', () => {
  assert.equal(timeDecay(0), 1);
  // 1 / (1 + 0.02 * days) — the factor specified by the design, so 30 days is
  // 0.625, not below 0.5. Asserting the formula, not an invented threshold.
  assert.ok(Math.abs(timeDecay(30 * 24 * 60 * 60 * 1000) - 0.625) < 1e-9);
  assert.ok(timeDecay(365 * 24 * 60 * 60 * 1000) < 0.15, 'a year is heavily discounted');

  const now = Date.now();
  const fresh = {
    id: 1, trigger_pattern: 'a.ts', symptom: 's', prescription: 'p',
    hit_count: 1, fail_count: 0, status: 'active', tool_name: null,
    created_at: now, updated_at: now,
  };
  const stale = { ...fresh, id: 2, created_at: now - 400 * 24 * 60 * 60 * 1000, updated_at: now - 400 * 24 * 60 * 60 * 1000 };
  const ranked = rerank([stale, fresh], { query: 'a.ts', now });
  assert.equal(ranked[0].id, 1, 'the fresh rule wins');
});

/* ---------------------------------------------------------------- *
 * Task 3 — batch distillation
 * ---------------------------------------------------------------- */

test('a malformed batch falls back to the rule path for every episode', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const llm = {
    endpoint: `http://127.0.0.1:${port}/v1`,
    apiKey: '',
    model: 'mock',
    allowPrivate: true,
    timeoutMs: 5000,
    maxTokens: 400,
  };

  const results = await distillBatch(
    [
      { id: 1, toolName: 'Bash', failedTrace: 'tool=Bash input={"command":"npm run build"} error=npm ERR! missing script', fixedTrace: 'tool=Bash result=ok' },
      { id: 2, toolName: 'Edit', failedTrace: 'tool=Edit input={"file_path":"a.ts"} error=File has been modified', fixedTrace: 'tool=Edit result=ok' },
    ],
    { llm },
  );

  assert.equal(results.size, 2, 'every episode gets a result despite the junk reply');
  assert.equal(results.get(1).ok, true, 'fallback still produces a rule');
  assert.equal(results.get(2).ok, true);
});

test('a valid batch answer is applied per id, with skips respected', () => {
  const parsed = parseBatchOutput(
    JSON.stringify([
      { id: 1, trigger_pattern: 'npm build', symptom: 's', prescription: 'use npx' },
      { id: 2, skip: true },
      { id: 99, trigger_pattern: 'made up', symptom: 's', prescription: 'p' },
    ]),
    [1, 2],
    'batch',
  );
  assert.equal(parsed.get(1)?.ok, true);
  assert.equal(parsed.get(2)?.ok, false);
  assert.equal(parsed.has(99), false, 'ids the model invented are refused');
});
