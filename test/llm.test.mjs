import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

const mod = '../dsh-immune-system/dist/core/llm.js';
const distillerMod = '../dsh-immune-system/dist/core/distiller.js';

/** Minimal OpenAI-compatible endpoint driven per-test. */
function startServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function respond(res, content, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
    }),
  );
}

test('endpoint validation blocks loopback by default and honours the opt-in', async () => {
  const { assertSafeEndpoint } = await import(mod);

  assert.throws(() => assertSafeEndpoint('http://127.0.0.1:11434/v1'), /loopback|private/);
  assert.throws(() => assertSafeEndpoint('http://localhost:8080/v1'), /loopback/);
  assert.throws(() => assertSafeEndpoint('http://192.168.1.5/v1'), /private/);
  assert.throws(() => assertSafeEndpoint('http://169.254.169.254/v1'), /private/, 'cloud metadata range');
  assert.throws(() => assertSafeEndpoint('file:///etc/passwd'), /http or https/);
  assert.equal(assertSafeEndpoint('http://127.0.0.1:11434/v1', true).hostname, '127.0.0.1');
});

test('model distillation parses, applies generic lessons, and degrades safely', async (t) => {
  const { distillEpisode } = await import(distillerMod);
  const { readLlmConfig } = await import(mod);

  let lastAuth = '';
  let lastModel = '';
  const server = await startServer((req, res, body) => {
    lastAuth = req.headers.authorization ?? '';
    const parsed = JSON.parse(body || '{}');
    lastModel = parsed.model;
    if (parsed.messages?.[1]?.content?.includes('conflict')) {
      respond(res, '{"trigger_pattern":"Edit a.ts conflict","symptom":"File has been modified since read","prescription":"re-read the file"}');
    } else if (parsed.messages?.[1]?.content?.includes('skipplease')) {
      respond(res, '{"skip": true}');
    } else if (parsed.messages?.[1]?.content?.includes('garbageplease')) {
      respond(res, 'not json at all <<<');
    } else {
      respond(res, 'ignored');
    }
  });
  t.after(() => server.close());
  const port = server.address().port;

  const llm = readLlmConfig({
    IMMUNE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    IMMUNE_LLM_MODEL: 'test-model',
    IMMUNE_LLM_API_KEY: 'test-key-123456',
    IMMUNE_ALLOW_PRIVATE_ENDPOINT: '1',
  });
  assert.ok(llm, 'config resolves from env');

  // A generic pitfall comes back normalised through the curated table.
  const generic = await distillEpisode('Edit', 'tool=Edit error=conflict', 'tool=Edit result=ok', { llm });
  assert.equal(generic.ok, true);
  assert.match(generic.antibody.trigger_pattern, /file-modified-since-read/, 'lesson table wins over the model wording');
  assert.equal(lastAuth, 'Bearer test-key-123456', 'api key reaches the endpoint');
  assert.equal(lastModel, 'test-model');

  // The model may decline; the rule distiller gets the final word and also skips.
  const skipped = await distillEpisode('Bash', 'tool=Bash error=skipplease', 'tool=Bash result=ok', { llm });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'skip');

  // Junk output degrades to the deterministic rule, never to a crash.
  const degraded = await distillEpisode('Bash', 'tool=Bash input={"command":"npm test"} error=garbageplease boom', 'tool=Bash result=ok', { llm });
  assert.equal(degraded.ok, true, 'fallback keeps the loop alive');
  assert.match(degraded.antibody.trigger_pattern, /^Bash /, 'fallback is the rule distiller');
});

test('readLlmConfig returns null when unconfigured', async () => {
  const { readLlmConfig } = await import(mod);
  assert.equal(readLlmConfig({}), null);
});

test('a rate-limited endpoint is retried with backoff, then succeeds', async (t) => {
  const { chat, readLlmConfig } = await import(mod);
  const previous = process.env.IMMUNE_LLM_BACKOFF_MS;
  process.env.IMMUNE_LLM_BACKOFF_MS = '10,20,30';
  t.after(() => {
    if (previous === undefined) delete process.env.IMMUNE_LLM_BACKOFF_MS;
    else process.env.IMMUNE_LLM_BACKOFF_MS = previous;
  });

  let calls = 0;
  const server = await startServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      // The public-beta gateway shape: 400 with a rate-limit body.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'inference exceeds tpm/rpm limit', type: 'rate_limit_error', code: '8' } }));
      return;
    }
    respond(res, 'ok after waiting');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const cfg = readLlmConfig({
    IMMUNE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    IMMUNE_LLM_MODEL: 'm',
    IMMUNE_LLM_ALLOW_PRIVATE_ENDPOINT: '1',
  });
  // The endpoint validator refuses loopback; opt in for the test.
  const localCfg = { ...cfg, allowPrivate: true };

  const reply = await chat(localCfg, 'sys', 'hello');
  assert.equal(reply, 'ok after waiting');
  assert.equal(calls, 2, 'one retry after the rate limit');
});

test('an auth failure is never retried', async (t) => {
  const { chat, readLlmConfig } = await import(mod);
  let calls = 0;
  const server = await startServer((_req, res) => {
    calls += 1;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const cfg = {
    ...readLlmConfig({ IMMUNE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, IMMUNE_LLM_MODEL: 'm' }),
    allowPrivate: true,
  };
  await assert.rejects(() => chat(cfg, 'sys', 'hello'), /403/);
  assert.equal(calls, 1, 'a permanent auth failure is not hammered');
});

test('the distill result reports which path produced it', async () => {
  const { distillEpisode } = await import(distillerMod);
  const { readLlmConfig } = await import(mod);

  const server = await startServer((_req, res) => {
    respond(res, '{"trigger_pattern":"npm ERESOLVE","symptom":"peer conflict","prescription":"align peer versions"}');
  });
  try {
    const { port } = server.address();
    const llm = {
      ...readLlmConfig({ IMMUNE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, IMMUNE_LLM_MODEL: 'm' }),
      allowPrivate: true,
    };
    const viaLlm = await distillEpisode('Bash', 'tool=Bash error=ERESOLVE boom', 'tool=Bash result=ok', { llm });
    assert.equal(viaLlm.ok, true);
    assert.equal(viaLlm.source, 'llm', 'the model path is reported as such');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // A configured but unreachable endpoint degrades — and says why.
  const dead = {
    ...readLlmConfig({ IMMUNE_LLM_BASE_URL: 'http://127.0.0.1:9/v1', IMMUNE_LLM_MODEL: 'm' }),
    allowPrivate: true,
    timeoutMs: 1500,
  };
  const degraded = await distillEpisode('Bash', 'tool=Bash input={"command":"npm test"} error=boom', 'tool=Bash result=ok', { llm: dead });
  assert.equal(degraded.ok, true, 'the loop keeps going');
  assert.equal(degraded.source, 'rule', 'the degradation is visible');
  assert.ok((degraded.degradedReason ?? '').length > 0, 'and carries a reason');
});

test('the drain only hands the model work the budget can cover', async (t) => {
  const { drainJobs } = await import('../dsh-immune-system/dist/zcode/src/drain.js');
  const { ImmuneStore } = await import('../dsh-immune-system/dist/core/store/index.js');
  const { readLlmConfig } = await import(mod);
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let calls = 0;
  const server = await startServer((_req, res) => {
    calls += 1;
    respond(res, '{"trigger_pattern":"npm ERESOLVE","symptom":"peer conflict","prescription":"align peer versions"}');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const llm = {
    ...readLlmConfig({ IMMUNE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, IMMUNE_LLM_MODEL: 'm' }),
    allowPrivate: true,
    timeoutMs: 5_000,
  };

  const dir = mkdtempSync(join(tmpdir(), 'immune-drainbudget-'));
  const store = new ImmuneStore({ dbPath: join(dir, 'immune.sqlite') });
  // Close the database before deleting its directory: Windows holds the WAL.
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  store.enqueueJob('Bash', 'tool=Bash input={"command":"npm i"} error=ERESOLVE', 'tool=Bash result=ok', []);

  // Budget smaller than the model's own timeout: do not start a call that
  // cannot finish. Distil with the rule path, count the degradation.
  const tight = await drainJobs(store, 1_000, { llm });
  assert.equal(calls, 0, 'no doomed model call');
  assert.equal(tight.processed, 1, 'the episode is still handled');
  assert.equal(tight.deferred, 1, 'and reported as deferred');
  assert.equal(store.stats().llmFallbacks, 1, 'the degradation is counted');

  // Budget that covers the call: the model is used.
  store.enqueueJob('Bash', 'tool=Bash input={"command":"npm i --legacy-peer-deps"} error=ERESOLVE two', 'tool=Bash result=ok', []);
  await drainJobs(store, 8_000, { llm });
  assert.equal(calls, 1, 'a covered budget reaches the model');
  assert.equal(store.stats().llmDistilled, 1);
});
