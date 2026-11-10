/**
 * ROADMAP 4.2 — proactive stack pre-warming on SessionStart.
 *
 * Detect which stacks a workspace actually is (marker files only, no reads of
 * user content) and install the matching hand-authored seed packs ONCE per
 * workspace — before the first tool error, so the first call is already
 * covered. The marker lives in meta (`prewarmed:<stack>`), so a second
 * SessionStart adds nothing and `immune seed --remove` still works: the pack's
 * own tracking is untouched. IMMUNE_PREWARM=off opts out.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_PACKS } from './packs.js';
const MARKERS = [
    { stack: 'git-safety', files: ['.git'] },
    { stack: 'node-ts', files: ['package.json'] },
    { stack: 'python-uv', files: ['pyproject.toml', 'requirements.txt', 'uv.lock'] },
    { stack: 'docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml'] },
];
/** Which builtin stacks does this workspace use? Pure file-existence probe. */
export function detectStacks(cwd) {
    const out = [];
    for (const marker of MARKERS) {
        if (marker.files.some((file) => existsSync(join(cwd, file))))
            out.push(marker.stack);
    }
    return out;
}
/**
 * Install every detected stack's seed pack once. Idempotent across processes:
 * the meta marker is written in the same pass that installs, and
 * installSeedPack's insert-path dedupe keeps the rows correct even if two
 * sessions race on a cold workspace.
 */
export function prewarmStacks(store, cwd, now = Date.now()) {
    const detected = detectStacks(cwd);
    // Pre-warming is COLD-START content: a library that already learned its own
    // rules keeps its priming slots undiluted (a fresh seed pack would otherwise
    // occupy the top-3 by recency on the very next SessionStart).
    if (store.listAll(false).length > 0)
        return { detected, installed: [] };
    const installed = [];
    for (const stack of detected) {
        const key = `prewarmed:${stack}`;
        if (store.metaValue(key) > 0)
            continue;
        const pack = BUILTIN_PACKS.find((candidate) => candidate.id === stack);
        if (!pack)
            continue;
        try {
            store.seedPack(stack, pack.rules);
            store.setMetaValue(key, now);
            installed.push(stack);
        }
        catch {
            // A failed pre-warm must not block the session start.
        }
    }
    return { detected, installed };
}
