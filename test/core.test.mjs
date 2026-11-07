import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('the distill parser accepts fenced JSON, skips, and rejects junk', async () => {
  const { parseDistillOutput } = await import('../dsh-immune-system/dist/core/prompts.js');

  const good = {
    trigger_pattern: 'vite.config.ts loadEnv',
    symptom: '读不到变量',
    prescription: '用 loadEnv 读取',
  };

  const plain = parseDistillOutput(JSON.stringify(good));
  assert.equal(plain.ok, true);
  assert.equal(plain.antibody.trigger_pattern, 'vite.config.ts loadEnv');

  const fenced = parseDistillOutput('```json\n' + JSON.stringify(good) + '\n```');
  assert.equal(fenced.ok, true, 'a markdown fence must be tolerated');

  assert.deepEqual(parseDistillOutput('{"skip": true}'), { ok: false, reason: 'skip' });
  assert.equal(parseDistillOutput('not json at all').ok, false);
  assert.equal(parseDistillOutput('{"trigger_pattern":"","prescription":""}').ok, false);
});

test('JSON-shaped results surface their human field, not the wrapper', async () => {
  const { extractError } = await import('../dsh-immune-system/dist/core/trace.js');

  assert.equal(
    extractError('tool=Read input={} result={"message":"File has been modified since read"}'),
    'File has been modified since read',
    'message field wins',
  );
  assert.equal(
    extractError('tool=Read input={} result=[{"type":"text","text":"actual output"}]'),
    'actual output',
    'text field wins over the JSON wrapper',
  );
  assert.equal(extractError('tool=Bash input={} error=plain text'), 'plain text');
});

test('a retried invocation stays a learnable episode', async () => {
  const { ruleDistill } = await import('../dsh-immune-system/dist/core/distiller.js');

  // The host acceptance flow (verify-steps23) encodes exactly this shape:
  // same command fails, then succeeds — the lesson is the environment fix.
  const trace = 'tool=Bash input={"command":"npm test"} error=2 suites failed';
  const result = ruleDistill('Bash', trace, 'tool=Bash input={"command":"npm test"} result=all green');
  assert.equal(result.ok, true, 'fail-then-succeed with the same command is a lesson');
});

test('rules injected this session are not injected twice when asked to dedup', async () => {
  const s = store();
  const a = s.insert({ trigger_pattern: 'alpha.ts', symptom: 's', prescription: 'p1' });
  const b = s.insert({ trigger_pattern: 'beta.ts', symptom: 's', prescription: 'p2' });
  assert.ok(a && b);

  const opts = { sessionId: 'dup', excludeInjected: true };
  const first = s.match('alpha.ts beta.ts', opts);
  assert.equal(first.length, 2, 'first match injects both');
  const second = s.match('alpha.ts beta.ts', opts);
  assert.deepEqual(second, [], 'second match within the window injects nothing');
  assert.equal(s.match('alpha.ts beta.ts').length, 2, 'without the flag, per-turn re-injection is allowed');
  s.close();
});

test('the plugin does not learn from operating on itself', async () => {
  const { isSelfEpisode } = await import('../dsh-immune-system/dist/core/selfnoise.js');

  const markers = ['C:\\Users\\x\\.zcode\\cli\\plugins\\cache\\dev-dsh-plugin-immune'];

  assert.equal(
    isSelfEpisode(
      'tool=Edit input={"file_path":"C:\\Users\\x\\.zcode\\cli\\plugins\\cache\\dev-dsh-plugin-immune\\dsh-immune-system\\0.3.1\\dist\\core\\trace.js"} error=File modified',
      markers,
    ),
    true,
    'a trace touching the plugin install dir is self-noise',
  );
  assert.equal(
    isSelfEpisode('tool=Edit input={"file_path":"D:\\work\\app\\main.ts"} error=boom', markers),
    false,
    'a normal project file is a lesson',
  );
  assert.equal(isSelfEpisode('anything', []), false, 'no markers means never self-noise');
});

test('another clone of the plugin is recognised by its package fingerprint', async () => {
  const { isSelfEpisode } = await import('../dsh-immune-system/dist/core/selfnoise.js');

  // A dev checkout living entirely OUTSIDE the working project — the blind spot
  // that previously let maintenance noise through.
  const clone = mkdtempSync(join(tmpdir(), 'immune-clone-'));
  writeFileSync(join(clone, 'package.json'), JSON.stringify({ name: 'dsh-immune-system' }));
  const cloneFile = join(clone, 'core', 'x.ts');
  mkdirSync(join(clone, 'core'), { recursive: true });
  writeFileSync(cloneFile, 'export {}');

  const escape = (p) => p.replace(/\\/g, '\\\\');
  assert.equal(
    isSelfEpisode(`tool=Edit input={"file_path":"${escape(cloneFile)}"} error=File modified`, []),
    true,
    'no env markers, no shared prefix — the package name is enough',
  );

  // A genuinely unrelated project next to it must stay a lesson.
  const app = join(clone, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'my-app' }));
  const appFile = join(app, 'main.ts');
  writeFileSync(appFile, 'export {}');
  assert.equal(
    isSelfEpisode(`tool=Edit input={"file_path":"${escape(appFile)}"} error=boom`, []),
    false,
  );
});

test('a generic pitfall is stored once, not once per file', async () => {
  const { ruleDistill } = await import('../dsh-immune-system/dist/core/distiller.js');

  const conflict = (file) =>
    `tool=Edit input={"file_path":"${file}","old_string":"x"} error=File has been modified since read, either by the user or by a linter. Read it again before attempting to write.`;

  const first = ruleDistill('Edit', conflict('D:\\repo\\a.ts'), 'tool=Edit input={"file_path":"D:\\repo\\a.ts"} result=ok');
  assert.equal(first.ok, true);
  assert.match(first.antibody.trigger_pattern, /file-modified-since-read/, 'generic trigger, not the file name');
  assert.doesNotMatch(first.antibody.trigger_pattern, /a\.ts/, 'per-file keywords must be dropped');

  const s = store();
  s.insert(first.antibody);
  const second = ruleDistill('Edit', conflict('D:\\repo\\HANDOFF-DSH.md'), 'tool=Edit result=ok');
  s.insert(second.antibody);
  const rows = s.listAll();
  assert.equal(rows.length, 1, 'the second file merges into the same rule');
  assert.equal(rows[0].hit_count >= 0, true);
  s.close();
});

test('two-character CJK words recall through the LIKE fallback', () => {
  const s = store();
  s.insert({
    trigger_pattern: '跨域 CORS',
    symptom: '跨域请求被浏览器拦截',
    prescription: '服务端补 Access-Control-Allow-Origin',
  });

  // Trigram cannot index a 2-character term; the fallback must catch it, even
  // when the word sits inside a longer run in a natural sentence.
  assert.equal(s.match('怎么解决跨域').length, 1, 'embedded 2-char word must match');
  assert.equal(s.match('跨域').length, 1, 'bare 2-char word must match');
  assert.equal(s.match('端口冲突').length, 0, 'unrelated 2-char words must not match');
  s.close();
});

test('forget --last removes the newest rule, prune drops old never-hit ones', () => {
  const s = store();
  const old = s.insert({ trigger_pattern: 'old.ts', symptom: 's', prescription: 'p-old' });
  const recent = s.insert({ trigger_pattern: 'recent.ts', symptom: 's', prescription: 'p-new' });
  assert.ok(old && recent);

  assert.equal(s.forgetLast(), recent, '--last targets the newest active rule');
  assert.equal(s.listAll().length, 1);

  // Age the survivor past the 14-day window; it was never injected.
  const longAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
  s['db'].prepare('UPDATE antibodies SET created_at = ? WHERE id = ?').run(longAgo, old);

  const removed = s.pruneZombies(14 * 24 * 60 * 60 * 1000);
  assert.deepEqual(removed, [old]);
  assert.equal(s.listAll().length, 0);
  s.close();
});

test('a human explanation becomes the prescription, trivial ones do not', async () => {
  const { ruleDistill, isSubstantiveHint } = await import(
    '../dsh-immune-system/dist/core/distiller.js'
  );

  const failure = 'tool=Bash input={"command":"npm run build"} error=npm ERR! missing script';
  const success = 'tool=Bash input={"command":"pnpm build"} result=ok';

  const withHint = ruleDistill('Bash', failure, success, '这个仓库用的是 pnpm，不要用 npm');
  assert.equal(withHint.ok, true);
  assert.match(withHint.antibody.prescription, /pnpm/, 'the human rule must win over the diff');

  // Acknowledgements are turns, not explanations.
  assert.equal(isSubstantiveHint('继续'), false);
  assert.equal(isSubstantiveHint('ok'), false);
  assert.equal(isSubstantiveHint('好的，继续吧'), false);
  assert.equal(isSubstantiveHint('这个仓库用的是 pnpm，不要用 npm'), true);

  const noHint = ruleDistill('Bash', failure, success, '继续');
  assert.match(noHint.antibody.prescription, /pnpm build/, 'trivial hint falls back to the diff');
});

test('a database created by an older version gains the hint columns on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-migrate-'));
  const dbPath = join(dir, 'old.sqlite');

  // Simulate a pre-hint schema.
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE pending_failures (
    session_id TEXT NOT NULL, tool_name TEXT NOT NULL, trace TEXT NOT NULL,
    injected_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, tool_name))`);
  old.exec(`CREATE TABLE distill_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL,
    failure_trace TEXT NOT NULL, success_trace TEXT NOT NULL,
    injected_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
    note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  old.close();

  const s = new ImmuneStore({ dbPath });
  s.recordFailure('s1', 'Bash', 'old row');
  assert.equal(s.attachHumanHint('s1', '这个仓库用 pnpm，别用 npm'), 1);
  assert.equal(s.claimFailure('s1', 'Bash').human_hint, '这个仓库用 pnpm，别用 npm');

  const jobId = s.enqueueJob('Bash', 'f', 's', [], 'hint text');
  const job = s.claimJob();
  assert.equal(job.id, jobId);
  assert.equal(job.human_hint, 'hint text');
  s.close();
});

test('a generic lesson reaches a brand-new project through the shared library', async () => {
  const { isPromotable } = await import('../dsh-immune-system/dist/core/store/global.js');
  const { existsSync, rmSync } = await import('node:fs');

  // Promotion rule: curated generics always; otherwise only when the rule
  // names no project-shaped path and has proven itself.
  assert.equal(isPromotable({ trigger_pattern: 't', prescription: 'p' }, true), true);
  assert.equal(
    isPromotable({ trigger_pattern: 'Edit a.ts', prescription: 'p', hit_count: 9 }, false),
    false,
    'a file name is project-shaped, so it must not be shared',
  );
  assert.equal(isPromotable({ trigger_pattern: 'Edit quoting', prescription: 'quote the path', hit_count: 5 }, false), true);
  assert.equal(isPromotable({ trigger_pattern: 'Edit quoting', prescription: 'quote the path', hit_count: 2 }, false), false);

  const dir = mkdtempSync(join(tmpdir(), 'immune-global-'));
  try {
    // Project A learns a generic lesson.
    const a = new ImmuneStore({ dbPath: join(dir, 'a.sqlite') });
    a.insertShared(
      {
        trigger_pattern: 'Edit file-modified-since-read 重读 re-read',
        symptom: '文件被外部修改',
        prescription: '先重新 Read 拿到当前内容再改',
      },
      { generic: true },
    );
    a.close();
    assert.ok(existsSync(join(dir, 'global.sqlite')), 'the shared library is created');

    // Project B has never learned anything, yet inherits it.
    const b = new ImmuneStore({ dbPath: join(dir, 'b.sqlite') });
    assert.equal(b.listAll().length, 0, 'project B starts empty');
    const hits = b.match('文件被外部修改了怎么办', { limit: 3 });
    assert.equal(hits.length, 1, 'the shared rule is recalled in a fresh project');
    assert.equal(b.listAll().length, 0, 'recalling does not copy it into project B');
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared rules count their own hits and respect per-session dedup', async () => {
  const { GlobalStore } = await import('../dsh-immune-system/dist/core/store/global.js');
  const { rmSync } = await import('node:fs');

  const dir = mkdtempSync(join(tmpdir(), 'immune-global2-'));
  try {
    const a = new ImmuneStore({ dbPath: join(dir, 'a.sqlite') });
    a.insertShared(
      {
        trigger_pattern: 'Edit file-modified-since-read 重读',
        symptom: '文件被外部修改',
        prescription: '先重新 Read 再改',
      },
      { generic: true },
    );
    a.close();

    const b = new ImmuneStore({ dbPath: join(dir, 'b.sqlite') });
    const opts = { limit: 3, sessionId: 's1', excludeInjected: true };
    assert.equal(b.match('文件被外部修改了', opts).length, 1, 'recalled from the shared library');
    assert.equal(b.match('文件被外部修改了', opts).length, 0, 'not re-injected in the same session');

    // The shared library must be a library, not a read-only mirror: without
    // this its rules could never age, retire, or be pruned.
    const g = new GlobalStore(join(dir, 'global.sqlite'));
    assert.equal(g.listAll()[0].hit_count, 1, 'the shared library counts injections');
    g.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--prune retires, --purge deletes', () => {
  const s = store();
  const id = s.insert({ trigger_pattern: 'z.ts', symptom: 's', prescription: 'p-zombie' });
  assert.ok(id);
  const longAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
  s['db'].prepare('UPDATE antibodies SET created_at = ? WHERE id = ?').run(longAgo, id);

  assert.deepEqual(s.retireZombies(14 * 24 * 60 * 60 * 1000), [id]);
  assert.equal(s.listAll(true).length, 1, 'retiring keeps the row recoverable');
  assert.equal(s.listAll(false).length, 0, 'and stops it being injected');
  assert.deepEqual(s.pruneZombies(14 * 24 * 60 * 60 * 1000), [], 'an already-retired row is not purged');
  s.close();
});

test('a weak single-window match is ranked last, not dropped', () => {
  const s = store();
  const strong = s.insert({
    trigger_pattern: 'Edit 文件占用 权限',
    symptom: '文件被占用无法写入',
    prescription: '先关掉占用进程',
  });
  const weak = s.insert({
    trigger_pattern: 'Edit 文件写入权限',
    symptom: '写不进去',
    prescription: '检查只读属性',
  });
  assert.ok(strong && weak);

  // Equalise timestamps: time decay would otherwise order by insertion
  // millisecond, and this test pins the WINDOW-COUNT ranking basis.
  const stamp = Date.now() - 60 * 60 * 1000;
  s['db'].prepare('UPDATE antibodies SET updated_at = ?, created_at = ?').run(stamp, stamp);

  // "文件占用" shares two windows with `strong` (文件, 占用) and one with `weak`.
  const hits = s.match('文件占用', { limit: 3 });
  assert.equal(hits[0].id, strong, 'the two-window rule ranks first');
  assert.ok(
    hits.some((h) => h.id === weak),
    'the single-window rule is still offered — dropping it would lose real recalls',
  );
  s.close();
});

test('library snapshots round-trip and merge conservatively', async () => {
  const { exportLibrary, importLibrary, SNAPSHOT_FORMAT } = await import(
    '../dsh-immune-system/dist/core/sync.js'
  );

  // Machine A: two rules, one used heavily, one retired.
  const a = store();
  const used = a.insert({ trigger_pattern: 'pnpm-lock.yaml 这个仓库', symptom: 'npm 装错', prescription: '用 pnpm 装依赖' });
  const dead = a.insert({ trigger_pattern: 'old.ts', symptom: 's', prescription: 'old fix' });
  a.setStatus(dead, 'retired');
  a.match('pnpm-lock.yaml 这个仓库');
  a.match('pnpm-lock.yaml 这个仓库');

  const snapshot = exportLibrary(a);
  assert.equal(snapshot.format, SNAPSHOT_FORMAT);
  assert.equal(snapshot.count, 2);
  a.close();

  // Machine B: knows the pnpm rule with a DIFFERENT tally, lacks the dead one.
  const b = store();
  const existing = b.insert({
    trigger_pattern: 'pnpm-lock.yaml 那台机器',
    symptom: 'npm 装错',
    prescription: '用 pnpm 装依赖',
  });
  b.match('pnpm-lock.yaml 那台机器');

  const report = importLibrary(b, snapshot);
  assert.deepEqual(report, { added: 1, merged: 1, invalid: 0 });

  const rows = b.listAll(true);
  assert.equal(rows.length, 2);

  // Tallies take the max: two machines' independent counts do not multiply.
  const pnpm = rows.find((r) => r.prescription === '用 pnpm 装依赖');
  assert.equal(pnpm.hit_count, 2, 'max(a=2, b=1)');
  assert.equal(pnpm.status, 'active', 'active on either side wins');

  const restored = rows.find((r) => r.prescription === 'old fix');
  assert.equal(restored.status, 'retired', 'retirement survives the trip');
  b.close();
});

test('import rejects malformed rows without dying', async () => {
  const { importLibrary } = await import('../dsh-immune-system/dist/core/sync.js');
  const s = store();
  const report = importLibrary(s, {
    format: 'dsh-immune-library',
    version: 1,
    antibodies: [
      { trigger_pattern: 'ok.ts', symptom: 's', prescription: 'good fix' },
      { trigger_pattern: '', prescription: 'no trigger' },
      null,
      'a string',
    ],
  });
  assert.deepEqual(report, { added: 1, merged: 0, invalid: 3 });
  s.close();
});

test('shared-library zombies age out on pruneStale', async () => {
  const { GlobalStore, globalDbPathFor } = await import(
    '../dsh-immune-system/dist/core/store/global.js'
  );
  const { rmSync } = await import('node:fs');

  const dir = mkdtempSync(join(tmpdir(), 'immune-age-'));
  try {
    const a = new ImmuneStore({ dbPath: join(dir, 'a.sqlite') });
    a.insertShared(
      { trigger_pattern: 'Edit quoting', symptom: '路径含空格', prescription: '引号包住路径' },
      { generic: true },
    );
    a.close();

    // Age the shared rule past the 30-day window.
    const g = new GlobalStore(globalDbPathFor(join(dir, 'a.sqlite')));
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    g['db'].prepare('UPDATE antibodies SET created_at = ?').run(old);
    assert.equal(g.listAll(false).length, 1, 'still active before pruning');
    g.close();

    const b = new ImmuneStore({ dbPath: join(dir, 'b.sqlite') });
    b.pruneStale(); // <- the fix: this call is what ages the shared library
    b.close();

    const after = new GlobalStore(globalDbPathFor(join(dir, 'a.sqlite')));
    assert.equal(after.listAll(false).length, 0, 'retired by pruneStale');
    assert.equal(after.listAll(true).length, 1, 'kept recoverable, not deleted');
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('redacts provider token shapes: npm, GitHub fine-grained, GitLab, Google, Slack, Stripe', () => {
  const raw = [
    'npm publish --//registry.npmjs.org/:_authToken=npm_0123456789abcdefghij0123456789',
    'gh auth with github_pat_11ABCDEF0123456789abcdefgh',
    'git clone https://oauth2:glpat-0123456789abcdef012@gitlab.com/x/y.git',
    'curl "https://maps.googleapis.com/maps/api/js?key=AIza0AbCdEfGhIjKlMnOpQrStUvWxYz0123456"',
    'slack: xoxp-abcdefghij-klmnopqrst-uvwxyz01-234567',
    'STRIPE_KEY=sk_live_0123456789abcdefgh',
  ].join('\n');
  const clean = redact(raw);
  assert.doesNotMatch(clean, /npm_0123456789/);
  assert.doesNotMatch(clean, /github_pat_11ABCDEF/);
  assert.doesNotMatch(clean, /glpat-0123456789/);
  assert.doesNotMatch(clean, /AIza0AbCdEfGh/);
  assert.doesNotMatch(clean, /xoxp-abcdefghij/);
  assert.doesNotMatch(clean, /sk_live_0123456789/);
  assert.match(clean, /<redacted-token>/);
  assert.match(clean, /<redacted-api-key>/);
  assert.match(clean, /<redacted-key>/);
  // No false positive on a variable named npm_<15 chars>: the npm pattern
  // requires 20+ characters after the prefix.
  assert.match(redact('npm_config_registry=https://registry.npmjs.org'), /npm_config_registry/);
});

test('pruneStale reclaims terminal distill jobs and dead session-turn rows', () => {
  const s = store();
  const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const doneJob = s.enqueueJob('Bash', 'fail trace', 'ok trace', []);
  const pendJob = s.enqueueJob('Bash', 'fail trace 2', 'ok trace 2', []);
  s.finishJob(doneJob, 'done');
  const db = s['db'];
  db.prepare('UPDATE distill_jobs SET updated_at = ? WHERE id IN (?, ?)').run(weekAgo, doneJob, pendJob);
  const turn =
    db.prepare('INSERT INTO session_turns (session_id, signature, turns, updated_at) VALUES (?, ?, ?, ?)');
  turn.run('old-sess', '', 3, weekAgo);
  turn.run('fresh-sess', '', 0, Date.now());
  const counts = s.pruneStale();
  assert.equal(counts.jobs, 1, 'only the terminal job is deleted');
  assert.equal(counts.sessions, 1, 'only the dead session row is deleted');
  const doneLeft = db.prepare('SELECT COUNT(*) AS n FROM distill_jobs WHERE id = ?').get(doneJob).n;
  const pendLeft = db.prepare('SELECT COUNT(*) AS n FROM distill_jobs WHERE id = ?').get(pendJob).n;
  assert.equal(doneLeft, 0, 'done job from a week ago is gone');
  assert.equal(pendLeft, 1, 'pending job survives retention');
  const oldSess = db.prepare('SELECT COUNT(*) AS n FROM session_turns WHERE session_id = ?').get('old-sess').n;
  const freshSess = db.prepare('SELECT COUNT(*) AS n FROM session_turns WHERE session_id = ?').get('fresh-sess').n;
  assert.equal(oldSess, 0, 'stale session row is gone');
  assert.equal(freshSess, 1, 'fresh session row survives');
  s.close();
});

test('stats() reports row counts and the on-disk size', () => {
  const s = store();
  s.insert({
    trigger_pattern: 'stats probe',
    symptom: 'stats row probe',
    prescription: 'stats fix probe',
  });
  const s2 = s.stats();
  assert.equal(s2.active, 1);
  assert.equal(s2.jobsTotal, 0);
  assert.equal(s2.dbBytes, null, 'in-memory db has no file size');

  const dir = mkdtempSync(join(tmpdir(), 'immune-stats-'));
  const onDisk = new ImmuneStore({ dbPath: join(dir, 'disk.sqlite') });
  onDisk.insert({
    trigger_pattern: 'stats disk probe',
    symptom: 'stats disk row',
    prescription: 'stats disk fix',
  });
  const disk = onDisk.stats();
  assert.equal(disk.active, 1);
  assert.equal(
    typeof disk.dbBytes === 'number' && disk.dbBytes > 0,
    true,
    'db file size is measured on disk',
  );
  onDisk.close();
  s.close();
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
