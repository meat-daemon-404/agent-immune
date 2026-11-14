import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectProjectBaseline, detectProjectBaselineDetail, filterRulesByBaseline } from '../dsh-immune-system/dist/core/baseline.js';
import { BUILTIN_PACKS } from '../dsh-immune-system/dist/core/packs.js';
import { detectStacks, prewarmStacks } from '../dsh-immune-system/dist/core/prewarm.js';
import { shareSanityCheck } from '../dsh-immune-system/dist/core/share-guard.js';
import { ingestSkillPaths, normalizeSkillPackId, parseSkillMarkdown } from '../dsh-immune-system/dist/core/skill-ingest.js';
import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';

const CLI_PATH = join(import.meta.dirname, '..', 'dsh-immune-system', 'dist', 'zcode', 'src', 'cli.js');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'immune-modern-web-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('modern-web detection activates for frontend markers but stays off for plain Node packages', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain-cli' }), 'utf8');
    assert.deepEqual(detectStacks(dir), ['git-safety', 'node-ts']);

    const webVite = mkdtempSync(join(tmpdir(), 'immune-vite-'));
    const webDeps = mkdtempSync(join(tmpdir(), 'immune-deps-'));
    try {
      writeFileSync(join(webVite, 'package.json'), JSON.stringify({ name: 'ui-app' }), 'utf8');
      writeFileSync(join(webVite, 'vite.config.ts'), 'export default {};\n', 'utf8');
      assert.deepEqual(detectStacks(webVite), ['node-ts', 'modern-web']);

      writeFileSync(
        join(webDeps, 'package.json'),
        JSON.stringify({ name: 'react-app', dependencies: { react: '^19.0.0' } }),
        'utf8',
      );
      assert.deepEqual(detectStacks(webDeps), ['node-ts', 'modern-web']);
    } finally {
      rmSync(webVite, { recursive: true, force: true });
      rmSync(webDeps, { recursive: true, force: true });
    }
  });
});

test('baseline detection respects .browserslistrc, package.json, and tsconfig target', () => {
  withTempDir((dir) => {
    assert.equal(detectProjectBaseline(dir), 'newly');

    writeFileSync(join(dir, '.browserslistrc'), 'defaults\n', 'utf8');
    const detailRc = detectProjectBaselineDetail(dir);
    assert.equal(detailRc.level, 'widely');
    assert.equal(detailRc.source, '.browserslistrc');

    // Negated legacy rules like `not ie <= 11` with modern floors stay newly-compatible.
    writeFileSync(join(dir, '.browserslistrc'), 'not ie <= 11\nchrome >= 126\nsafari >= 18\n', 'utf8');
    assert.equal(detectProjectBaseline(dir), 'newly');

    rmSync(join(dir, '.browserslistrc'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'legacy-app', browserslist: ['last 4 versions', '> 1%'] }),
      'utf8',
    );
    assert.equal(detectProjectBaseline(dir), 'widely');

    rmSync(join(dir, 'package.json'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      '{\n  // Legacy transpilation target\n  "compilerOptions": {\n    "target": "ES2017"\n  }\n}\n',
      'utf8',
    );
    assert.equal(detectProjectBaseline(dir), 'widely');
  });
});

test('prewarmStacks scopes modern-web rules by project Baseline', () => {
  withTempDir((dir) => {
    const pack = BUILTIN_PACKS.find((p) => p.id === 'modern-web');
    assert.ok(pack);
    const widelyOnly = filterRulesByBaseline(pack.rules, 'widely');
    const newlyAll = filterRulesByBaseline(pack.rules, 'newly');
    assert.ok(widelyOnly.length >= 5 && widelyOnly.length < newlyAll.length);

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'legacy-spa' }), 'utf8');
    writeFileSync(join(dir, 'vite.config.ts'), 'export default {};\n', 'utf8');
    writeFileSync(join(dir, '.browserslistrc'), '> 0.5%\nlast 2 versions\n', 'utf8');

    const legacyStore = new ImmuneStore({ dbPath: ':memory:' });
    const legacyReport = prewarmStacks(legacyStore, dir, 1000);
    assert.equal(legacyReport.baseline, 'widely');
    assert.ok(legacyReport.installed.includes('modern-web'));
    assert.equal(legacyStore.seededPackCounts().get('modern-web'), widelyOnly.length);
    const rules = legacyStore.listAll(false);
    assert.ok(
      !rules.some((r) => r.prescription.includes('CSS Anchor Positioning')),
      'widely baseline must exclude newly-only CSS Anchor Positioning rule',
    );
    legacyStore.close();

    rmSync(join(dir, '.browserslistrc'));
    const modernStore = new ImmuneStore({ dbPath: ':memory:' });
    const modernReport = prewarmStacks(modernStore, dir, 1000);
    assert.equal(modernReport.baseline, 'newly');
    assert.equal(modernStore.seededPackCounts().get('modern-web'), newlyAll.length);
    modernStore.close();
  });
});

test('parseSkillMarkdown and ingestSkillPaths index SKILL/guidance on demand and scrub secrets', () => {
  withTempDir((dir) => {
    const fakeToken = `ghp_${'A'.repeat(36)}`;
    const sampleSkill = `---
name: modern-web-guidance
description: Curated modern web guidelines
---

## License
MIT License notice only.

## Native Dialog Top Layer
- Avoid: Hand-rolling portal overlays with z-index: 9999 and manual Escape key handlers.
- Prefer: Use native \`<dialog>\` with \`showModal()\` and \`::backdrop\` for accessible top-layer modals.
- Baseline: Widely available

## CSS Anchor Positioning
- Tool: Edit
- Avoid: Measuring \`getBoundingClientRect()\` inside scroll listeners for floating tooltips.
- Prefer: Use CSS Anchor Positioning (\`anchor-name\`, \`position-anchor\`, \`position-try-fallbacks\`) instead of JS layout probes.
- Baseline: Newly available

## Secret Safety Leak Test
- Avoid: Committing token ${fakeToken} or path C:\\Users\\alice\\secrets.txt in build scripts.
- Prefer: Pass credentials via environment variables rather than C:\\Users\\alice\\.env and gh tokens.
`;
    const parsed = parseSkillMarkdown(sampleSkill);
    assert.equal(parsed.frontmatterName, 'modern-web-guidance');
    assert.equal(parsed.rules.length, 3);
    assert.equal(parsed.rules[0].baseline, 'widely');
    assert.equal(parsed.rules[1].baseline, 'newly');
    assert.equal(parsed.rules[1].tool_name, 'Edit');
    assert.ok(!parsed.rules[2].symptom.includes(fakeToken));
    assert.ok(!parsed.rules[2].prescription.includes('alice'));

    const docFile = join(dir, 'SKILL.md');
    writeFileSync(docFile, sampleSkill, 'utf8');
    writeFileSync(join(dir, '.browserslistrc'), 'defaults\n', 'utf8');

    const store = new ImmuneStore({ dbPath: ':memory:' });
    const report = ingestSkillPaths(store, [docFile], { cwd: dir });
    assert.equal(report.packId, 'skill:modern-web-guidance');
    assert.equal(report.filesRead, 1);
    assert.equal(report.parsed, 3);
    assert.equal(report.baseline, 'widely');
    assert.equal(report.baselineFiltered, 1);
    assert.equal(report.inserted, 2);

    // On-demand FTS5 recall surfaces the relevant rule cleanly.
    const hits = store.match('modal dialog z-index backdrop escape', { limit: 3 });
    assert.ok(hits.some((r) => r.prescription.includes('<dialog>')));
    assert.equal(shareSanityCheck(hits).length, 0);
    store.close();
  });
});

test('parseSkillMarkdown parses guidance tables cleanly', () => {
  const tableMd = `# Web Table Guide

| Legacy / Avoid | Modern Prefer | Baseline |
| --- | --- | --- |
| JSON.parse(JSON.stringify(obj)) loses Date and Map | Use native structuredClone(obj) for deep cloning objects | Widely available |
| Manual setTimeout abort races around fetch calls | Pass AbortSignal.timeout(ms) directly into fetch options | Widely available |
| Document view clones with timers during SPA navigation | Use document.startViewTransition with @supports fallback | Newly available |
`;
  const parsed = parseSkillMarkdown(tableMd);
  assert.equal(parsed.rules.length, 3);
  assert.equal(parsed.rules[0].baseline, 'widely');
  assert.equal(parsed.rules[2].baseline, 'newly');
  assert.equal(normalizeSkillPackId('Modern Web Guide'), 'skill:modern-web-guide');
});

test('CLI supports seed --baseline and ingest-skill lifecycle', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'immune.sqlite');
    const mdPath = join(dir, 'frontend-guide.md');
    writeFileSync(
      mdPath,
      [
        '## Native Popover API',
        '- Avoid: Global document click-outside listeners for dropdown menus.',
        '- Prefer: Use HTML popover attribute and popovertarget for native light-dismiss.',
        '- Baseline: Widely available',
        '',
        '## View Transitions Routing',
        '- Avoid: Manual cloned DOM animation timers between route changes.',
        '- Prefer: Use document.startViewTransition with progressive enhancement fallback.',
        '- Baseline: Newly available',
      ].join('\n'),
      'utf8',
    );
    const env = { ...process.env, IMMUNE_DB_PATH: dbPath };

    const seedRes = spawnSync(process.execPath, [CLI_PATH, 'seed', 'modern-web', '--baseline', 'widely'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    assert.equal(seedRes.status, 0, seedRes.stderr);
    assert.match(seedRes.stdout, /seeded modern-web \(baseline: widely, filtered \d+ newly-only\)/);

    const ingestRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'ingest-skill', mdPath, '--pack', 'frontend-guide', '--baseline', 'widely'],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(ingestRes.status, 0, ingestRes.stderr);
    assert.match(ingestRes.stdout, /ingested skill:frontend-guide: 1 rule\(s\) indexed on demand/);
    assert.match(ingestRes.stdout, /filtered 1 newly-only/);

    const listRes = spawnSync(process.execPath, [CLI_PATH, 'seed'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.match(listRes.stdout, /skill:frontend-guide/);

    const removeRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'ingest-skill', '--remove', '--pack', 'frontend-guide'],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(removeRes.status, 0, removeRes.stderr);
    assert.match(removeRes.stdout, /removed 1 ingested rule\(s\) from skill:frontend-guide/);
  });
});
