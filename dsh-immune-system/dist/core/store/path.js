import { resolve } from 'node:path';
/**
 * Resolve the database location from the environment, mirroring host
 * conventions so the same file is found by every hook process.
 *
 * Priority: explicit override, then the host's plugin data directory, then a
 * per-project `.dsh` folder. The project fallback keeps antibodies scoped to
 * the repository that produced them.
 */
export function resolveDbPath(env = process.env) {
    const explicit = env.IMMUNE_DB_PATH?.trim();
    if (explicit)
        return resolve(explicit);
    const pluginData = env.ZCODE_PLUGIN_DATA?.trim() || env.CLAUDE_PLUGIN_DATA?.trim();
    if (pluginData)
        return resolve(pluginData, 'immune.sqlite');
    const project = env.ZCODE_PROJECT_DIR?.trim() || env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
    return resolve(project, '.dsh', 'immune.sqlite');
}
