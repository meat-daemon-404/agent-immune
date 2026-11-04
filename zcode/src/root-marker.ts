/**
 * Remember where this plugin is installed.
 *
 * Slash commands are plain Markdown prompts, so `${ZCODE_PLUGIN_ROOT}` is not
 * expanded inside them and the model has no reliable way to find the CLI. Each
 * hook therefore writes the plugin root into the project's `.dsh` folder once,
 * and the commands read it back. Best-effort: a read-only project is fine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT_MARKER = 'immune-root.txt';

export function projectDirOf(): string {
  return (
    process.env.ZCODE_PROJECT_DIR?.trim() ||
    process.env.CLAUDE_PROJECT_DIR?.trim() ||
    process.cwd()
  );
}

/** Directory holding the marker; also the natural place for the CLI's output. */
export function dshDirOf(): string {
  return join(projectDirOf(), '.dsh');
}

export function rememberPluginRoot(): void {
  const root = process.env.ZCODE_PLUGIN_ROOT?.trim() || process.env.CLAUDE_PLUGIN_ROOT?.trim();
  if (!root) return;
  try {
    const dir = dshDirOf();
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, ROOT_MARKER);
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === root) return;
    writeFileSync(marker, root, 'utf8');
  } catch {
    // A read-only project must not break the hook.
  }
}
