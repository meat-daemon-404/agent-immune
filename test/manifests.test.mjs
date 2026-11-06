/**
 * Manifest consistency guards.
 *
 * `AGENTS.md` warns that a release must bump **four** manifests to the same
 * version, and that the installable package must keep every path inside
 * itself (the doubled `dsh-immune-system/` prefix is deliberate). Both are
 * easy to break silently during a release, so they are pinned here.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

/** Every version field a release has to keep in step. */
function versionFields() {
  const root = readJson('package.json');
  const pkg = readJson('dsh-immune-system/package.json');
  const zcode = readJson('dsh-immune-system/.zcode-plugin/plugin.json');
  const market = readJson('marketplace.json');
  return {
    'package.json version': root.version,
    'package.json dsh.version': root.dsh?.version,
    'dsh-immune-system/package.json version': pkg.version,
    'dsh-immune-system/package.json dsh.version': pkg.dsh?.version,
    '.zcode-plugin/plugin.json version': zcode.version,
    'marketplace.json plugins[0].version': market.plugins?.[0]?.version,
  };
}

test('the four manifests agree on one version', () => {
  const fields = versionFields();
  const versions = Object.values(fields);
  assert.equal(
    new Set(versions).size,
    1,
    `manifests drifted: ${JSON.stringify(fields, null, 2)}`,
  );
  assert.match(versions[0], /^\d+\.\d+\.\d+$/u);
});

test('the installable package references only files inside itself', () => {
  const pkg = readJson('dsh-immune-system/package.json');
  assert.equal(pkg.name, 'dsh-immune-system');
  assert.equal(pkg.main, './dist/dsh/src/index.js');
  assert.equal(pkg.exports?.['.'], './dist/dsh/src/index.js');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');

  for (const relative of [pkg.main, pkg.exports['.'], pkg.dsh.bundle.patch]) {
    assert.ok(!relative.startsWith('..'), `${relative} escapes the package root`);
    assert.ok(
      existsSync(join(ROOT, 'dsh-immune-system', relative)),
      `${relative} does not exist in the package`,
    );
  }
});

test('the ZCode and marketplace entries name the same plugin', () => {
  const pkg = readJson('dsh-immune-system/package.json');
  const zcode = readJson('dsh-immune-system/.zcode-plugin/plugin.json');
  const market = readJson('marketplace.json');
  assert.equal(zcode.name, pkg.name);
  assert.equal(market.plugins?.[0]?.name, pkg.name);
});
