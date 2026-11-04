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
