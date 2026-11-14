import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** File the plugin uses to self-locate; line 1 root, line 2 database path. */
export const ROOT_MARKER = 'immune-root.txt';

/**
 * Resolve the database location from the environment, mirroring host
 * conventions so the same file is found by every hook process.
 *
 * Priority:
 *   1. explicit IMMUNE_DB_PATH override
 *   2. the host's plugin data directory (hook processes)
 *   3. the plugin's self-location marker, `<project>/.dsh/immune-root.txt`
 *      line 2 — slash commands run inside a model Bash call WITHOUT the hook
 *      environment, and this is how their CLI finds the hooks' database
 *   4. a per-project `.dsh` folder (fresh projects without a marker)
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.IMMUNE_DB_PATH?.trim();
  if (explicit) return resolve(explicit);

  const pluginData =
    env.ZCODE_PLUGIN_DATA?.trim() ||
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.PLUGIN_DATA?.trim();
  if (pluginData) return resolve(pluginData, 'immune.sqlite');

  const project =
    env.ZCODE_PROJECT_DIR?.trim() ||
    env.CLAUDE_PROJECT_DIR?.trim() ||
    env.ANTIGRAVITY_PROJECT_DIR?.trim() ||
    process.cwd();
  const marker = resolve(project, '.dsh', ROOT_MARKER);
  if (existsSync(marker)) {
    const line2 = readFileSync(marker, 'utf8').split('\n')[1]?.trim();
    if (line2) return line2;
  }

  return resolve(project, '.dsh', 'immune.sqlite');
}
