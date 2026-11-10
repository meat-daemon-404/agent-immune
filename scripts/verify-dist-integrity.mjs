/**
 * Dist integrity gate — the machine guard behind AGENTS.md decision #34.
 *
 * 1.0.37 shipped a cli.js that imported a connect.js the tarball did not
 * contain, because `npm pack` compiles the dirty tree. The human procedure
 * (clean export, --ignore-scripts, unpack and run the CLI) is necessary but
 * only catches this if someone actually runs the CLI path that imports every
 * module. This script checks the WHOLE graph statically: every relative
 * import in every dist .js (static `from` and dynamic `import()`), resolved
 * to a file that exists on disk, plus source→dist 1:1 correspondence and a
 * real CLI spawn. A module that is missing, orphaned, or wired to a stale
 * path fails here, in CI, before it can reach a tarball.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dsh-immune-system', 'dist');
const SOURCE_DIRS = ['core', 'zcode', 'dsh'];

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function walk(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, ext));
    else if (extname(entry.name) === ext) out.push(path);
  }
  return out;
}

// Static `from '…'`, side-effect `import '…'`, and dynamic `import('…')`.
const IMPORT_PATTERN =
  /(?:from\s*|import\s*\(?\s*|import\s+)['"](\.[^'"]+)['"]/g;

/** All relative .js imports in one source text, resolved against its file. */
function relativeImports(source, fromFile) {
  const out = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const spec = match[1];
    if (!spec.endsWith('.js')) continue; // node: builtins / packages handled separately
    out.push({ spec, target: resolve(dirname(fromFile), spec) });
  }
  return out;
}

// `--self-test`: prove the detector actually catches the 1.0.37 shape
// (cli.js importing a module the tarball does not contain), in memory —
// no source file is touched.
if (process.argv.includes('--self-test')) {
  const fake = join(DIST, 'zcode', 'src', 'cli.js');
  const imports = relativeImports(
    "import './ghost-module.js';\nconst x = await import('../../core/also-ghost.js');\n",
    fake,
  );
  const caught = imports.filter((i) => !existsSync(i.target));
  check('self-test: a dead static import is detected', imports.length === 2 && caught.length === 2);
  check('self-test: a real import is not flagged',
    relativeImports("import './format.js';", fake).every((i) => existsSync(i.target)));
  console.log(`\n=== dist integrity self-test: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

const distFiles = walk(DIST, '.js');
const broken = [];
let edges = 0;
for (const file of distFiles) {
  const source = readFileSync(file, 'utf8');
  for (const { spec, target } of relativeImports(source, file)) {
    edges += 1;
    if (!existsSync(target)) broken.push(`${relative(ROOT, file)} -> ${spec}`);
  }
}
check(`all ${edges} relative imports resolve to real dist files`, broken.length === 0, broken.join('; '));

// Every .ts under the source dirs has a compiled .js partner, and no dist
// file lacks a source (a stale artifact is exactly how 1.0.36/37 broke).
const srcFiles = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d), '.ts'))
  .filter((f) => !f.endsWith('.d.ts'));
const missingDist = srcFiles.filter(
  (f) => !existsSync(join(DIST, relative(ROOT, f)).replace(/\.ts$/, '.js')),
);
check(`every ${srcFiles.length} source file has a dist partner`, missingDist.length === 0, missingDist.join('; '));
const staleDist = distFiles.filter(
  (f) => !existsSync(join(ROOT, relative(DIST, f)).replace(/\.js$/, '.ts')),
);
check('no dist file exists without a source file', staleDist.length === 0, staleDist.join('; '));
check('source and dist counts match', srcFiles.length === distFiles.length,
  `src=${srcFiles.length} dist=${distFiles.length}`);

// A real spawn: the CLI loads its own graph. `list` is read-only against a
// temp db so this never touches a user's library.
const tmpDb = join(ROOT, '.dist-integrity-probe.sqlite');
const cli = join(DIST, 'zcode', 'src', 'cli.js');
const run = spawnSync(process.execPath, [cli, 'list'], {
  cwd: ROOT,
  env: { ...process.env, IMMUNE_DB_PATH: tmpDb },
  encoding: 'utf8',
  timeout: 15_000,
});
check('CLI starts and loads its module graph', run.status === 0,
  (run.stderr || run.stdout || '').slice(0, 300));
rmSync(tmpDb, { force: true });
for (const suffix of ['-wal', '-shm']) rmSync(`${tmpDb}${suffix}`, { force: true });

console.log(`\n=== dist integrity: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed === 0 ? 0 : 1;
