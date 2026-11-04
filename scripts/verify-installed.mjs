/**
 * Verify the plugin is actually installed and loadable by the running DSH.
 *
 * Mirrors what `packages/boot/app-boot/src/profile.ts` does at boot:
 *   1. the profile declares `dsh-immune-system` in `dsh.profile.bundles`;
 *   2. the package resolves from the profile's `node_modules`;
 *   3. its `package.json` declares `dsh.bundle.patch`, and that patch file
 *      exists and contains exactly one insert row for this package;
 *   4. the entry module imports by bare name and exposes the Cordis plugin shape.
 *
 * Read-only: installs nothing, starts no host.
 *
 * Run:  node scripts/verify-installed.mjs [profileName]
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const profile = process.argv[2] || 'web';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(DSH_HOME, 'profiles', profile);
const PKG = 'dsh-immune-system';

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
  }
};

console.log(`[profile] ${profileDir}`);
check('profile directory exists', existsSync(profileDir));

const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const bundles = profileManifest.dsh?.profile?.bundles ?? [];
check(`${PKG} is listed in dsh.profile.bundles`, bundles.includes(PKG));
check(`${PKG} is a declared dependency`, Boolean(profileManifest.dependencies?.[PKG]), profileManifest.dependencies?.[PKG]);

const pkgDir = join(profileDir, 'node_modules', PKG);
check('package resolves in the profile node_modules', existsSync(join(pkgDir, 'package.json')), pkgDir);

const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
check('manifest name matches', manifest.name === PKG, manifest.name);
const declaredPatch = manifest.dsh?.bundle?.patch;
check('manifest declares dsh.bundle.patch', typeof declaredPatch === 'string', declaredPatch);

const patchPath = declaredPatch ? join(pkgDir, declaredPatch) : '';
check('declared patch file exists', Boolean(declaredPatch) && existsSync(patchPath), patchPath);

if (patchPath && existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8');
  const insertRows = text.split('\n').filter((line) => /^\s*-\s*id:\s*/.test(line));
  check('patch has exactly one insert row', insertRows.length === 1, insertRows);
  check('insert row names this package', insertRows.length === 1 && insertRows[0].includes(PKG), insertRows);
  check('patch has no accidental client bundle', !/client/i.test(text.replace(/^\s*#.*$/gm, '')));
}

const entry = join(pkgDir, manifest.main || 'dist/dsh/src/index.js');
check('entry module exists', existsSync(entry), entry);

const mod = await import(pathToFileURL(entry).href);
check('module exports apply()', typeof mod.apply === 'function');
check('module exports a plugin name', mod.name === PKG, mod.name);
check('module declares inject = [commands]', JSON.stringify(mod.inject) === JSON.stringify(['commands']), mod.inject);
check('module exports normaliseToolEvent()', typeof mod.normaliseToolEvent === 'function');
check('DSH_EVENTS point at real host events', JSON.stringify(mod.DSH_EVENTS) === JSON.stringify({
  sessionStart: 'agent/session-start',
  preStep: 'agent/pre-step',
  postToolExecute: 'tools/post-execute',
}), mod.DSH_EVENTS);

console.log(`\n=== installed check (profile=${profile}): ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
