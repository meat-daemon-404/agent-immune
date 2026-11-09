/**
 * `immune connect <host>`: wire this engine into other agents' hook systems.
 *
 * The hook RUNTIME contract is shared — Claude Code, Codex and ZCode all feed
 * one JSON object on stdin and read `hookSpecificOutput` back (that is why
 * zcode/src/hook-io.ts and the CLAUDE_* env fallbacks already work for both
 * dialects). What differs is the manifest: this module only builds, merges and
 * removes hook ENTRIES in the host's own config file; it never touches any
 * other user setting.
 *
 * Scope guard: this is a config-file operation, deliberately separate from the
 * store. It must stay idempotent (a second connect adds nothing), removable
 * (only entries whose command matches our hook scripts are touched), and
 * must refuse to write a config it could not parse.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ConnectHostId = 'claude-code' | 'codex';

/** One hook script wired into a host event, in the shared `command` dialect. */
interface HookHandler {
  type: 'command';
  command: string;
  timeout: number;
}

/** A matcher group as both Claude Code settings.json and Codex hooks.json use. */
export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export interface HostDefinition {
  id: ConnectHostId;
  label: string;
  /** Config file, relative to the user's home directory. */
  relativeConfigPath: string;
  /**
   * Key inside the config JSON that holds the event table. Claude Code keeps
   * hooks under `hooks` in settings.json; a Codex hooks.json IS the table.
   */
  eventsKey: string | null;
  /** Codex has no PostToolUseFailure event; failures arrive via PostToolUse. */
  includesFailureHook: boolean;
  /** Extra steps the user must take after connecting. */
  notes: string[];
}

export const HOSTS: Record<ConnectHostId, HostDefinition> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    relativeConfigPath: join('.claude', 'settings.json'),
    eventsKey: 'hooks',
    includesFailureHook: true,
    notes: ['takes effect from the next Claude Code session (重启会话后生效)'],
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    relativeConfigPath: join('.codex', 'hooks.json'),
    eventsKey: null,
    includesFailureHook: false,
    notes: [
      'run /hooks in Codex to trust these commands before they run (需在 Codex 中运行 /hooks 信任)',
      'takes effect from the next Codex session (重启会话后生效)',
    ],
  },
};

/** Events in wiring order; timeouts in seconds (ZCode's manifest uses ms). */
const HOOK_SPECS: Array<{ event: string; script: string; timeout: number; matcher?: string }> = [
  { event: 'SessionStart', script: 'session-start.js', timeout: 20 },
  { event: 'UserPromptSubmit', script: 'user-prompt-submit.js', timeout: 5 },
  {
    event: 'PreToolUse',
    script: 'pre-tool-use.js',
    timeout: 4,
    matcher: 'Bash|Edit|Write|MultiEdit|Read|Grep|Glob',
  },
  { event: 'PostToolUse', script: 'post-tool-use.js', timeout: 5 },
  { event: 'PostToolUseFailure', script: 'post-tool-use-failure.js', timeout: 5 },
  { event: 'Stop', script: 'stop.js', timeout: 30 },
];

/**
 * Matches exactly the commands this module writes, across any install root
 * (repo checkout or `node_modules/dsh-immune-system/dsh-immune-system/…` —
 * decision #11's doubled prefix). `--remove` uninstalls every match so a dev
 * checkout and an npm copy never leave stragglers behind.
 */
const IMMUNE_COMMAND = /dsh-immune-system[\\/]dist[\\/]zcode[\\/]src[\\/]hooks[\\/]/;

export interface ConnectOptions {
  /** Override the user's home directory (tests). */
  home?: string;
  /** Override the dist hooks directory (tests). */
  scriptDir?: string;
}

export interface ConnectReport {
  host: string;
  label: string;
  configPath: string;
  scriptDir: string;
  /** Event names this host's runtime actually supports. */
  eventsWired: string[];
  added: number;
  alreadyPresent: number;
  removed: number;
  backupPath: string | null;
  notes: string[];
}

/** The compiled hooks directory that ships next to this module in dist/. */
export function defaultScriptDir(): string {
  // dist/core/connect.js -> dist/zcode/src/hooks
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'zcode', 'src', 'hooks');
}

function configPathOf(host: HostDefinition, home: string): string {
  return join(home, host.relativeConfigPath);
}

function commandFor(scriptDir: string, script: string): string {
  // Forward slashes keep the JSON readable and work for node on every platform.
  return `node "${join(scriptDir, script).replace(/\\/g, '/')}"`;
}

function eventTableOf(host: HostDefinition, config: Record<string, unknown>): Record<string, HookGroup[]> {
  if (host.eventsKey === null) return config as Record<string, HookGroup[]>;
  const table = config[host.eventsKey];
  if (table === undefined) {
    const created: Record<string, HookGroup[]> = {};
    config[host.eventsKey] = created;
    return created;
  }
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new Error(`${host.relativeConfigPath}: "${host.eventsKey}" is not a hook table`);
  }
  return table as Record<string, HookGroup[]>;
}

function specsFor(host: HostDefinition): typeof HOOK_SPECS {
  return HOOK_SPECS.filter((spec) => host.includesFailureHook || spec.event !== 'PostToolUseFailure');
}

/** Build the event table this module would write — exported for tests. */
export function buildEventTable(host: HostDefinition, scriptDir: string): Record<string, HookGroup[]> {
  const table: Record<string, HookGroup[]> = {};
  for (const spec of specsFor(host)) {
    table[spec.event] = [
      {
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: 'command', command: commandFor(scriptDir, spec.script), timeout: spec.timeout }],
      },
    ];
  }
  return table;
}

function isImmuneGroup(group: HookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some((hook) => IMMUNE_COMMAND.test(hook?.command ?? ''));
}

function readConfig(configPath: string): { existed: boolean; config: Record<string, unknown> } {
  if (!existsSync(configPath)) return { existed: false, config: {} };
  const raw = readFileSync(configPath, 'utf8');
  if (raw.trim() === '') return { existed: true, config: {} };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return { existed: true, config: parsed as Record<string, unknown> };
  } catch (error) {
    // Never clobber a config we cannot read; the user fixes it by hand.
    throw new Error(
      `${configPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it by hand first`,
    );
  }
}

function writeConfig(configPath: string, config: Record<string, unknown>, existed: boolean): string | null {
  if (existed) {
    // One reversible step before the first write; never overwritten afterwards.
    const backupPath = `${configPath}.bak-immune`;
    if (!existsSync(backupPath)) copyFileSync(configPath, backupPath);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return backupPath;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return null;
}

function resolveSetup(hostId: ConnectHostId, options?: ConnectOptions): {
  host: HostDefinition;
  configPath: string;
  scriptDir: string;
} {
  const host = HOSTS[hostId];
  const scriptDir = options?.scriptDir ?? defaultScriptDir();
  return { host, configPath: configPathOf(host, options?.home ?? homedir()), scriptDir };
}

function assertScriptsExist(host: HostDefinition, scriptDir: string): void {
  const missing = specsFor(host)
    .map((spec) => spec.script)
    .filter((script) => !existsSync(join(scriptDir, script)));
  if (missing.length > 0) {
    throw new Error(`hook scripts missing under ${scriptDir}: ${missing.join(', ')} — the install looks broken`);
  }
}

/** Add the immune hooks to the host's config. Idempotent. */
export function connectHost(hostId: ConnectHostId, options?: ConnectOptions): ConnectReport {
  const { host, configPath, scriptDir } = resolveSetup(hostId, options);
  assertScriptsExist(host, scriptDir);
  const { existed, config } = readConfig(configPath);
  const table = eventTableOf(host, config);

  let added = 0;
  let alreadyPresent = 0;
  const eventsWired: string[] = [];
  const wanted = buildEventTable(host, scriptDir);
  for (const [event, groups] of Object.entries(wanted)) {
    const current = Array.isArray(table[event]) ? (table[event] as HookGroup[]) : [];
    if (current.some(isImmuneGroup)) {
      alreadyPresent += 1;
    } else {
      table[event] = [...current, ...groups];
      added += 1;
    }
    eventsWired.push(event);
  }

  const backupPath = added > 0 ? writeConfig(configPath, config, existed) : null;
  return {
    host: host.id,
    label: host.label,
    configPath,
    scriptDir,
    eventsWired,
    added,
    alreadyPresent,
    removed: 0,
    backupPath,
    notes: host.notes,
  };
}

/** Remove every immune hook entry from the host's config. */
export function disconnectHost(hostId: ConnectHostId, options?: ConnectOptions): ConnectReport {
  const { host, configPath, scriptDir } = resolveSetup(hostId, options);
  if (!existsSync(configPath)) {
    return {
      host: host.id,
      label: host.label,
      configPath,
      scriptDir,
      eventsWired: [],
      added: 0,
      alreadyPresent: 0,
      removed: 0,
      backupPath: null,
      notes: host.notes,
    };
  }
  const { existed, config } = readConfig(configPath);
  const table = eventTableOf(host, config);
  let removed = 0;
  for (const event of Object.keys(table)) {
    const groups = table[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => {
        if (!isImmuneGroup(group)) return group;
        const hooks = group.hooks.filter((hook) => !IMMUNE_COMMAND.test(hook?.command ?? ''));
        removed += group.hooks.length - hooks.length;
        return hooks.length > 0 ? { ...group, hooks } : null;
      })
      .filter((group): group is HookGroup => group !== null);
    if (kept.length > 0) table[event] = kept;
    else delete table[event];
  }
  const backupPath = removed > 0 ? writeConfig(configPath, config, existed) : null;
  return {
    host: host.id,
    label: host.label,
    configPath,
    scriptDir,
    eventsWired: [],
    added: 0,
    alreadyPresent: 0,
    removed,
    backupPath,
    notes: host.notes,
  };
}

export type ConnectionState = 'connected' | 'not-connected' | 'no-config';

export interface ConnectStatusRow {
  host: string;
  label: string;
  configPath: string;
  state: ConnectionState;
  events: string[];
}

/** Which hosts already carry immune hooks, without writing anything. */
export function connectStatus(options?: ConnectOptions): ConnectStatusRow[] {
  return Object.values(HOSTS).map((host) => {
    const configPath = configPathOf(host, options?.home ?? homedir());
    if (!existsSync(configPath)) {
      return { host: host.id, label: host.label, configPath, state: 'no-config' as const, events: [] };
    }
    try {
      const table = eventTableOf(host, readConfig(configPath).config);
      const events = Object.entries(table)
        .filter(([, groups]) => Array.isArray(groups) && groups.some(isImmuneGroup))
        .map(([event]) => event);
      return {
        host: host.id,
        label: host.label,
        configPath,
        state: events.length > 0 ? ('connected' as const) : ('not-connected' as const),
        events,
      };
    } catch {
      return { host: host.id, label: host.label, configPath, state: 'no-config' as const, events: [] };
    }
  });
}
