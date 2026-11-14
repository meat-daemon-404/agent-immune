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
import { resolveDbPath, ROOT_MARKER } from '../../core/store/path.js';

export { ROOT_MARKER };

export function projectDirOf(): string {
  return (
    process.env.ZCODE_PROJECT_DIR?.trim() ||
    process.env.CLAUDE_PROJECT_DIR?.trim() ||
    process.env.ANTIGRAVITY_PROJECT_DIR?.trim() ||
    process.cwd()
  );
}

/** Directory holding the marker; also the natural place for the CLI's output. */
export function dshDirOf(): string {
  return join(projectDirOf(), '.dsh');
}

/**
 * Paths that mark an episode as "the plugin operating on itself".
 *
 * Failures while editing the plugin's own install or storage files are
 * maintenance, not pitfalls — learning from them fills the library with rules
 * no future session can use. Hooks share this one definition.
 *
 * When the session runs inside the plugin's own development repository (the
 * plugin root sits under the project directory), the whole project tree counts
 * as self: developing the plugin is maintenance by definition.
 */
export function selfMarkers(): string[] {
  const markers = [
    process.env.ZCODE_PLUGIN_ROOT ?? '',
    process.env.ZCODE_PLUGIN_DATA ?? '',
    process.env.CLAUDE_PLUGIN_ROOT ?? '',
    process.env.CLAUDE_PLUGIN_DATA ?? '',
    process.env.PLUGIN_ROOT ?? '',
    process.env.PLUGIN_DATA ?? '',
  ].filter((p) => p.trim().length > 0);

  const root = (
    process.env.ZCODE_PLUGIN_ROOT ??
    process.env.CLAUDE_PLUGIN_ROOT ??
    process.env.PLUGIN_ROOT ??
    ''
  )
    .trim()
    .toLowerCase();
  const project = projectDirOf().toLowerCase();
  if (root && project && root.startsWith(project)) markers.push(projectDirOf());
  return markers;
}

export function rememberPluginRoot(): void {
  const root =
    process.env.ZCODE_PLUGIN_ROOT?.trim() ||
    process.env.CLAUDE_PLUGIN_ROOT?.trim() ||
    process.env.PLUGIN_ROOT?.trim();
  if (!root) return;
  try {
    const dir = dshDirOf();
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, ROOT_MARKER);
    // Line 2 records the database the hooks actually use. Slash commands run
    // inside a model Bash call WITHOUT the hook environment, so the CLI cannot
    // see ZCODE_PLUGIN_DATA and would otherwise resolve to a different (empty)
    // file. Hooks rewrite the marker whenever it drifts, so it self-heals.
    const dbPath = resolveDbPath();
    const content = `${root}\n${dbPath}\n`;
    if (existsSync(marker) && readFileSync(marker, 'utf8') === content) return;
    writeFileSync(marker, content, 'utf8');
  } catch {
    // A read-only project must not break the hook.
  }
}
