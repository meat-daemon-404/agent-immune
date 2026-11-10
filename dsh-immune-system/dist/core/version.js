/**
 * The running package's own version, from the package.json that ships next to
 * dist. Two layouts exist (AGENTS.md #11's doubled prefix):
 *   repo checkout:  <root>/dsh-immune-system/dist/...  -> package.json inside
 *   npm install:    node_modules/dsh-immune-system/{package.json, dsh-immune-system/dist/...}
 * The inner package.json is not shipped by npm, so both candidates are tried.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** dist root, derived from this module's compiled location (…/dist/core). */
function distRoot() {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
}
export function packageVersion() {
    const root = distRoot();
    for (const candidate of [join(root, '..', 'package.json'), join(root, '..', '..', 'package.json')]) {
        try {
            const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
            if (typeof parsed.version === 'string')
                return parsed.version;
        }
        catch {
            // Try the next layout; a missing file is not worth surfacing.
        }
    }
    return 'unknown';
}
