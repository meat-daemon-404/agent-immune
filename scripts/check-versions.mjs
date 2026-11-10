#!/usr/bin/env node
/**
 * Verify that the five version-carrying manifests agree.
 *
 * They drifted once by accident (package.json said 0.2.0 while the plugin
 * manifest said 0.3.8), and the npm publish flow publishes from the ROOT
 * manifest while ZCode reads the plugin manifest — a mismatch means users
 * install one version while the marketplace advertises another. This check is
 * wired into CI so drift fails the build instead of surfacing in the marketplace.
 *
 * The dsh.version field inside both package.json files must also agree, since
 * the hub displays it as the plugin's version.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const rootPkg = read('package.json');
const nestedPkg = read('dsh-immune-system/package.json');
const pluginManifest = read('dsh-immune-system/.zcode-plugin/plugin.json');
const market = read('marketplace.json');
const claudePlugin = read('.claude-plugin/plugin.json');

const versions = {
  'package.json': rootPkg.version,
  'package.json (dsh)': rootPkg.dsh?.version,
  'dsh-immune-system/package.json': nestedPkg.version,
  'dsh-immune-system/package.json (dsh)': nestedPkg.dsh?.version,
  'plugin.json': pluginManifest.version,
  'marketplace.json': market.plugins[0]?.version,
  '.claude-plugin/plugin.json': claudePlugin.version,
};

let failed = false;
const seen = new Set();
for (const [where, version] of Object.entries(versions)) {
  seen.add(version);
  console.log(`${version ? 'ok  ' : 'FAIL'} ${where}: ${version ?? '(missing)'}`);
  if (!version) failed = true;
}

if (seen.size > 1) {
  console.error(`\nversion drift: ${[...seen].join(' vs ')} — bump all five together`);
  process.exit(1);
}

const name = market.plugins[0]?.name;
if (name && name !== rootPkg.name) {
  console.error(`marketplace entry name (${name}) != root package name (${rootPkg.name})`);
  process.exit(1);
}

console.log(`\nall manifests agree on ${rootPkg.version}`);
