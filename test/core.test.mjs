import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';
import { renderSkillMarkdown } from '../dsh-immune-system/dist/core/export.js';
import { redact } from '../dsh-immune-system/dist/core/redact.js';

function store() {
  return new ImmuneStore({ dbPath: ':memory:' });
}

test('stores an antibody and finds it by Chinese and English terms', () => {
  const s = store();
  const id = s.insert({
    trigger_pattern: 'vite.config.ts 环境变量 loadEnv',
    symptom: '直接用 process.env 读客户端变量',
    prescription: '在 vite.config.ts 用 loadEnv(mode, cwd) 读取',
  });
  assert.ok(id && id > 0);

  const byPath = s.match('帮我改一下 vite.config.ts');
  assert.equal(byPath.length, 1);
  assert.equal(byPath[0].id, id);

  const byChinese = s.match('环境变量读不到');
  assert.equal(byChinese.length, 1, 'trigram tokenizer must match CJK substrings');

  // Each successful match counts as one injection.
  assert.equal(s.listAll()[0].hit_count, 2);
  s.close();
});

test('a short token matches nothing instead of throwing', () => {
  const s = store();
  s.insert({ trigger_pattern: 'vite.config.ts', symptom: 'x', prescription: 'y' });
  assert.deepEqual(s.match('ab'), []);
  assert.deepEqual(s.match(''), []);
  s.close();
});

test('de-duplicates identical prescriptions', () => {
  const s = store();
  const a = s.insert({ trigger_pattern: 'one', symptom: 's', prescription: 'same fix' });
  const b = s.insert({ trigger_pattern: 'two', symptom: 's2', prescription: 'same fix' });
  assert.equal(a, b);
  assert.equal(s.listAll().length, 1);
  s.close();
});

test('pairs a failure with the next success on the same tool only once', () => {
  const s = store();
  s.recordFailure('sess-1', 'Bash', 'npm run build -> error');
  const claimed = s.claimFailure('sess-1', 'Bash');
  assert.ok(claimed);
  assert.equal(claimed.tool_name, 'Bash');
  assert.match(claimed.trace, /npm run build/);

  assert.equal(s.claimFailure('sess-1', 'Bash'), null, 'a failure pairs exactly once');
  assert.equal(s.claimFailure('sess-1', 'Edit'), null, 'a different tool does not match');
  s.close();
});

test('records which antibodies were injected so they can be blamed', () => {
  const s = store();
  const id = s.insert({
    trigger_pattern: 'vite.config.ts',
    symptom: 's',
    prescription: 'p',
  });
  s.match('vite.config.ts', { sessionId: 'sess-2' });
  s.recordFailure('sess-2', 'Bash', 'still broken');
  assert.deepEqual(s.claimFailure('sess-2', 'Bash')?.injected_ids, [id]);
  s.close();
});

test('retires an antibody after three injected-but-still-failing episodes', () => {
  const s = store();
  const id = s.insert({ trigger_pattern: 'flaky-rule', symptom: 's', prescription: 'p' });
  assert.ok(id);

  assert.deepEqual(s.penalize([id]), [], 'first failure only warns');
  assert.deepEqual(s.penalize([id]), [], 'second failure only warns');
  const retired = s.penalize([id]);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].status, 'retired');

  assert.equal(s.listAll(false).length, 0, 'retired antibodies are no longer injected');
  assert.equal(s.listAll(true).length, 1, 'but they are kept for audit');
  s.close();
});

test('an unrelated failure does not penalise a good antibody', () => {
  const s = store();
  const id = s.insert({
    trigger_pattern: 'vite.config.ts loadEnv 环境变量',
    symptom: 's',
    prescription: 'p',
  });
  assert.ok(id);
  s.match('vite.config.ts 环境变量', { sessionId: 'rel' });

  // The turn fails, but for an unrelated reason.
  s.recordFailure('rel', 'Bash', 'tool=Bash input={"command":"pytest"} error=AssertionError in foo.test.ts');
  const snap = s.claimFailure('rel', 'Bash');
  assert.ok(snap);

  const retired = s.penalize(snap.injected_ids, {
    failureText: snap.trace,
    toolName: 'Bash',
  });
  assert.deepEqual(retired, []);
  assert.equal(s.listAll()[0].fail_count, 0, 'unrelated failure must not cost credit');
  s.close();
});

test('a related failure does penalise the antibody', () => {
  const s = store();
  const id = s.insert({
    trigger_pattern: 'vite.config.ts loadEnv 环境变量',
    symptom: 's',
    prescription: 'p',
  });
  assert.ok(id);
  s.match('vite.config.ts 环境变量', { sessionId: 'rel2' });
  s.recordFailure('rel2', 'Bash', 'tool=Bash error=loadEnv undefined in vite.config.ts');
  const snap = s.claimFailure('rel2', 'Bash');
  assert.ok(snap);

  s.penalize(snap.injected_ids, { failureText: snap.trace, toolName: 'Bash' });
  assert.equal(s.listAll()[0].fail_count, 1);
  s.close();
});

test('exports only proven antibodies as SKILL.md', () => {
  const s = store();
  const id = s.insert({ trigger_pattern: 'a.ts', symptom: 'bad', prescription: 'good' });
  assert.ok(id);
  for (let i = 0; i < 3; i += 1) s.match('a.ts');

  assert.equal(s.exportable(3).length, 1);
  assert.equal(s.exportable(4).length, 0);

  const md = renderSkillMarkdown(s.exportable(3), { minHits: 3 });
  assert.match(md, /^---\nname: project-pitfalls/);
  assert.match(md, /\| a\.ts \| bad \| good \| 3 \|/);
  s.close();
});

test('trigger keywords are normalised: paths collapse to basenames, noise dropped', async () => {
  const { extractKeywords } = await import('../dsh-immune-system/dist/core/distiller.js');

  const text =
    'tool=Bash input={"command":"cat \\"C:\\\\Users\\\\x\\\\AppData\\\\verge.yaml\\" \'/home/x/verge.yaml\'"} ' +
    'error=PID UAC APPDATA failed';

  const keywords = extractKeywords(text);
  assert.ok(
    keywords.every((k) => !k.includes('/') && !k.includes('\\') && !k.includes(':')),
    `keywords must not carry paths: ${JSON.stringify(keywords)}`,
  );
  assert.ok(keywords.includes('verge.yaml'), 'basename should survive');
  assert.ok(!keywords.some((k) => k.toUpperCase() === 'APPDATA'), 'stoplist tokens must go');
  assert.ok(!keywords.some((k) => k.toUpperCase() === 'PID'), 'stoplist tokens must go');
});

test('structured failure payloads expose stderr, not a JSON dump', async () => {
  const { summarizeFailure } = await import('../dsh-immune-system/dist/zcode/src/format.js');

  const event = {
    tool_name: 'Bash',
    tool_input: { command: 'grep controller' },
    error_details: {
      stdout: '86:enable_external_controller: false\n',
      stderr: 'grep: pattern not found',
      interrupted: false,
      isImage: false,
    },
  };

  const text = summarizeFailure(event);
  assert.match(text, /grep: pattern not found/, 'stderr must surface');
  assert.doesNotMatch(text, /\{"stdout"/, 'JSON dump must not be the symptom');
});

test('one bloated antibody cannot dominate the injected block', async () => {
  const { formatImmuneContext } = await import('../dsh-immune-system/dist/zcode/src/format.js');

  const bloated = {
    id: 1,
    trigger_pattern: 'x'.repeat(500),
    symptom: 'y'.repeat(500),
    prescription: 'z'.repeat(500),
    hit_count: 0,
    fail_count: 0,
    status: 'active',
    tool_name: null,
    created_at: 0,
    updated_at: 0,
  };
  const tight = {
    ...bloated,
    id: 2,
    trigger_pattern: 'a.ts',
    symptom: 's',
    prescription: 'p',
  };

  const block = formatImmuneContext([bloated, tight]);
  assert.ok(block.length < 1200, `block should stay bounded, got ${block.length}`);
  assert.ok(block.includes('a.ts'), 'the small rule must still fit after the big one');
});

test('injects bilingual text by default and honours the locale override', async () => {
  const { resolveLocale, strings } = await import('../dsh-immune-system/dist/core/i18n.js');

  assert.equal(resolveLocale({}), 'both', 'bilingual is the default');

  const both = strings('both');
  assert.match(both.promptPreamble, /本项目/);
  assert.match(both.promptPreamble, /Pitfalls this project/);
  assert.match(both.trigger, /触发/);
  assert.match(both.trigger, /trigger/);

  assert.equal(resolveLocale({ IMMUNE_LOCALE: 'zh-CN' }), 'zh-CN');
  assert.equal(resolveLocale({ IMMUNE_LOCALE: 'en' }), 'en');

  const zh = strings('zh-CN');
  assert.doesNotMatch(zh.promptPreamble, /Pitfalls/, 'zh must not carry English');
  const en = strings('en');
  assert.doesNotMatch(en.promptPreamble, /本项目/, 'en must not carry Chinese');
});

test('classifies a non-zero exit code as a failure', async () => {
  const { classifyOutcome } = await import('../dsh-immune-system/dist/zcode/src/outcome.js');

  assert.equal(
    classifyOutcome({ tool_response: { exitCode: 127 }, tool_result_preview: 'command not found' }).failed,
    true,
  );
  assert.equal(classifyOutcome({ tool_response: { exitCode: 0 }, tool_result_preview: 'ok' }).failed, false);
  assert.equal(
    classifyOutcome({ tool_result_preview: 'npm ERR! missing script: build' }).failed,
    true,
    'output markers catch failures when no exit code is reported',
  );
  assert.equal(
    classifyOutcome({ tool_result_preview: 'build succeeded, 0 errors' }).failed,
    false,
    'a healthy log mentioning errors must not be treated as a failure',
  );
});

test('redacts credentials before they reach the database', () => {
  const raw =
    'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x.dev && API_KEY=supersecretvalue123';
  const clean = redact(raw);
  assert.doesNotMatch(clean, /abcdefghijklmnop1234/);
  assert.doesNotMatch(clean, /supersecretvalue123/);
  assert.match(clean, /<redacted>/);
});

test('pipes destructive SQL through bound parameters only', () => {
  const s = store();
  const id = s.insert({
    trigger_pattern: 'quote test',
    symptom: `'); DROP TABLE antibodies; --`,
    prescription: 'kept literal',
  });
  assert.ok(id);
  assert.equal(s.listAll().length, 1, 'injected SQL must stay data');
  s.close();
});
