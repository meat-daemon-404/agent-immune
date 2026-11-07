/**
 * Self-noise detection.
 *
 * Two proven failure modes drove this design:
 *
 *  1. The plugin was learning from failures while editing its OWN files. These
 *     are maintenance, not reusable pitfalls, and they occupied the injection
 *     budget of every later session.
 *  2. A path-prefix check against the working directory missed the dev checkout
 *     whenever it lived OUTSIDE the project (or behind a junction / pnpm link),
 *     so a documented blind spot let several such rules through.
 *
 * Detection therefore works from two physical facts instead of configuration:
 *  - the real location this module is loaded from (survives junction/symlink),
 *  - the `package.json` fingerprint of any path named in the trace, which
 *    identifies another clone of the plugin wherever it sits on disk.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Package names that mean "this is the immune system itself". */
const SELF_PACKAGE_NAMES = new Set(['dsh-immune-system', 'dsh-plugin-immune']);
/** How far up to look for a package.json before giving up. */
const MAX_UPWARD = 8;
/** Cap on paths pulled out of one trace. */
const MAX_PATHS = 6;
/** `realpath` that never throws (missing files are normal here). */
function safeRealpath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
/**
 * Normalise a path or a raw trace fragment for comparison.
 *
 * Traces carry JSON-escaped Windows separators (`C:\\a\\b`), so doubled
 * backslashes are collapsed first; both sides are then lowered and unified so a
 * case or separator difference can never hide a match.
 */
function normalizePath(value) {
    return value.replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase();
}
/**
 * Parent directory that treats BOTH separators as separators, on every platform.
 *
 * `path.dirname` uses the platform separator: on Linux a Windows path like
 * `D:\work\app\src\main.ts` has no `/`, so dirname returns '.' and an upward
 * walk would scan the current workspace instead of the named path — that exact
 * false positive failed CI (the workspace root has a package.json whose name is
 * this plugin's).
 *
 * A drive root (`D:`, `D:/`) has no parent and returns null: resolving against
 * it would use the process's drive-relative cwd, which is how the CI false
 * positive happened.
 */
function parentDir(path) {
    const normalised = path.replace(/\\/g, '/');
    const cut = normalised.lastIndexOf('/');
    if (cut <= 0)
        return null;
    const parent = normalised.slice(0, cut);
    if (/^[A-Za-z]:$/.test(parent))
        return null; // drive root
    return parent.length >= 2 ? parent : null;
}
/** Nearest directory at or above `start` that holds a package.json. */
function findPackageRoot(start) {
    let dir = start;
    for (let i = 0; i < MAX_UPWARD; i += 1) {
        if (existsSync(resolve(dir, 'package.json')))
            return dir;
        const parent = parentDir(dir);
        if (parent === null || parent === dir)
            return null;
        dir = parent;
    }
    return null;
}
/** The `name` field of a package.json, or null. */
function packageNameAt(root) {
    try {
        const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
        if (typeof pkg !== 'object' || pkg === null)
            return null;
        const name = pkg.name;
        return typeof name === 'string' ? name : null;
    }
    catch {
        return null;
    }
}
let cachedModuleRoot;
/** Physical package root this module runs from (junction/symlink resolved). */
export function moduleRoot() {
    if (cachedModuleRoot !== undefined)
        return cachedModuleRoot;
    try {
        const here = fileURLToPath(import.meta.url);
        const real = safeRealpath(here) ?? here;
        const root = findPackageRoot(parentDir(real) ?? real);
        cachedModuleRoot = root ? normalizePath(root) : null;
    }
    catch {
        cachedModuleRoot = null;
    }
    return cachedModuleRoot;
}
/** Push every quoted path-ish value out of a trace. */
function collectPaths(trace) {
    const found = [];
    const pattern = /"(?:file_path|path|old_string|content)"\s*:\s*"((?:[^"\\]|\\.){3,300})"/g;
    for (const match of trace.matchAll(pattern)) {
        const raw = match[1];
        if (!raw)
            continue;
        const unescaped = raw.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
        if (!/[\\/]/.test(unescaped))
            continue;
        found.push(unescaped);
        if (found.length >= MAX_PATHS)
            break;
    }
    return found;
}
/**
 * True when `trace` describes the plugin operating on itself.
 *
 * `markers` are host-supplied path hints (plugin install / data directories);
 * they are still honoured, but the two physical checks above no longer depend
 * on them being complete.
 */
export function isSelfEpisode(trace, markers = []) {
    if (!trace)
        return false;
    const haystack = normalizePath(trace);
    const root = moduleRoot();
    if (root && haystack.includes(root))
        return true;
    for (const marker of markers) {
        const needle = normalizePath(marker.trim());
        if (needle && haystack.includes(needle))
            return true;
    }
    // Fingerprint: another clone of the plugin, wherever it lives.
    for (const candidate of collectPaths(trace)) {
        const real = safeRealpath(candidate) ?? candidate;
        // Starting from the file path itself (not its dir) is deliberate: on POSIX
        // a Windows-style path has no dirname, so parentDir would lose the walk.
        const pkgRoot = findPackageRoot(real);
        if (!pkgRoot)
            continue;
        const name = packageNameAt(pkgRoot);
        if (name && SELF_PACKAGE_NAMES.has(name))
            return true;
    }
    return false;
}
