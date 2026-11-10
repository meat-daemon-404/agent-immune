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
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersion } from './version.js';

/**
 * The vendored install: connect copies this package's dist into
 * `~/.dsh-immune/` and points the host hooks there, so the commands survive
 * an npx cache cleanup or an upgrade of the copy that ran `connect`. Without
 * this, `npx dsh-immune-system@latest connect …` writes a _npx cache path
 * into the host config and the hooks die silently on the next cache sweep.
 */
export function vendorRootOf(home: string): string {
  return join(home, '.dsh-immune');
}

/** This module's compiled dist root (…/dist), wherever the package lives. */
function ownDistRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/** The running package's version — both repo and npm layouts (core/version.ts). */
export function ownVersion(): string {
  return packageVersion();
}

export interface VendorInfo {
  dir: string;
  distDir: string;
  version: string;
  /** True when the dist tree was (re)copied during this call. */
  refreshed: boolean;
}

function readVendorVersion(vendorRoot: string): string | null {
  try {
    const raw = readFileSync(join(vendorRoot, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Copy the dist tree into the vendor root unless that version is already
 * there. `force` re-copies (a dev checkout can change code without a version
 * bump). The version marker records what is vendored and when.
 */
export function vendorDist(home: string, opts: { force?: boolean } = {}): VendorInfo {
  const vendorRoot = vendorRootOf(home);
  const distDir = join(vendorRoot, 'dist');
  const version = ownVersion();
  const existing = readVendorVersion(vendorRoot);
  // The version marker alone is not enough: a half-deleted vendor tree (an
  // interrupted cleanup, a paranoid antivirus) keeps its marker while the
  // scripts are gone. A missing canary forces the re-copy too.
  const canary = join(distDir, 'zcode', 'src', 'hooks', 'session-start.js');
  const refreshed =
    opts.force === true || existing === null || existing !== version || !existsSync(canary);
  if (refreshed) {
    rmSync(distDir, { recursive: true, force: true });
    cpSync(ownDistRoot(), distDir, { recursive: true });
    mkdirSync(vendorRoot, { recursive: true });
    // The package fingerprint is what core/selfnoise.ts walks up to: without
    // it, a host connected through the vendor copy would learn "episodes"
    // from failures on the immune install itself (maintenance, not pitfalls).
    writeFileSync(
      join(vendorRoot, 'package.json'),
      `${JSON.stringify({ name: 'dsh-immune-system', version, private: true }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(vendorRoot, 'version.json'),
      `${JSON.stringify({ version, connectedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  }
  return { dir: vendorRoot, distDir, version, refreshed };
}

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
 * Matches every command layout this module has ever written: the npm/repo
 * layout (`dsh-immune-system/dist/zcode/src/hooks/…`) and the vendored one
 * (`~/.dsh-immune/dist/zcode/src/hooks/…`). `--remove` uninstalls every
 * match, so an upgrade never leaves stragglers behind.
 */
const IMMUNE_COMMAND = /(\.dsh-immune|dsh-immune-system)[\\/]dist[\\/]zcode[\\/]src[\\/]hooks[\\/]/;

export interface ConnectOptions {
  /** Override the user's home directory (tests). */
  home?: string;
  /** Override the dist hooks directory (tests). */
  scriptDir?: string;
  /** Re-copy the vendored dist even when the version matches (dev refresh). */
  refresh?: boolean;
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
  /** Immune entries replaced because their command was stale. */
  upgraded: number;
  removed: number;
  backupPath: string | null;
  notes: string[];
  /** The vendored install, when connect (re)built it. */
  vendorDir: string | null;
  vendorVersion: string | null;
  vendorRefreshed: boolean;
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

function resolveSetup(
  hostId: ConnectHostId,
  options?: ConnectOptions,
): { host: HostDefinition; configPath: string; scriptDir: string; vendor: VendorInfo | null } {
  const host = HOSTS[hostId];
  const home = options?.home ?? homedir();
  // Production: vendor the dist tree and point hooks at the FIXED copy, so an
  // npx cache sweep cannot break them. Tests pass scriptDir explicitly and
  // skip the vendor step.
  if (options?.scriptDir) {
    return { host, configPath: configPathOf(host, home), scriptDir: options.scriptDir, vendor: null };
  }
  const vendor = vendorDist(home, { force: options?.refresh === true });
  return { host, configPath: configPathOf(host, home), scriptDir: join(vendor.distDir, 'zcode', 'src', 'hooks'), vendor };
}

function assertScriptsExist(host: HostDefinition, scriptDir: string): void {
  const missing = specsFor(host)
    .map((spec) => spec.script)
    .filter((script) => !existsSync(join(scriptDir, script)));
  if (missing.length > 0) {
    throw new Error(`hook scripts missing under ${scriptDir}: ${missing.join(', ')} — the install looks broken`);
  }
}

/** Add the immune hooks to the host's config. Idempotent; upgrades stale paths. */
export function connectHost(hostId: ConnectHostId, options?: ConnectOptions): ConnectReport {
  const { host, configPath, scriptDir, vendor } = resolveSetup(hostId, options);
  assertScriptsExist(host, scriptDir);
  const { existed, config } = readConfig(configPath);
  const table = eventTableOf(host, config);

  let added = 0;
  let alreadyPresent = 0;
  let upgraded = 0;
  const eventsWired: string[] = [];
  const wanted = buildEventTable(host, scriptDir);
  for (const [event, groups] of Object.entries(wanted)) {
    const current = Array.isArray(table[event]) ? (table[event] as HookGroup[]) : [];
    const wantedCommand = groups[0]?.hooks[0]?.command ?? '';
    const stale = current.filter(
      (group) => isImmuneGroup(group) && group.hooks[0]?.command !== wantedCommand,
    );
    const currentHasWanted = current.some(
      (group) => isImmuneGroup(group) && group.hooks[0]?.command === wantedCommand,
    );
    // An immune entry whose command differs from what this connect would
    // write is a stale install (an npx cache path, an old vendor root, a dev
    // checkout): replace it, or the upgrade never reaches users who already
    // connected with the broken layout.
    const kept = current.filter((group) => !stale.includes(group));
    if (currentHasWanted) {
      alreadyPresent += 1;
      table[event] = kept.length > 0 ? kept : current;
    } else if (stale.length > 0) {
      // A stale install on this event is an upgrade, not a new wiring.
      upgraded += stale.length;
      table[event] = [...kept, ...groups];
    } else {
      table[event] = [...current, ...groups];
      added += 1;
    }
    eventsWired.push(event);
  }

  const backupPath = added > 0 || upgraded > 0 ? writeConfig(configPath, config, existed) : null;
  return {
    host: host.id,
    label: host.label,
    configPath,
    scriptDir,
    eventsWired,
    added,
    alreadyPresent,
    upgraded,
    removed: 0,
    backupPath,
    notes: host.notes,
    vendorDir: vendor?.dir ?? null,
    vendorVersion: vendor?.version ?? null,
    vendorRefreshed: vendor?.refreshed ?? false,
  };
}

/** Read-only look at the vendored install (never copies). */
export function vendorInfoOf(home: string): { dir: string; version: string | null } {
  const dir = vendorRootOf(home);
  return { dir, version: readVendorVersion(dir) };
}

/** Immune command strings currently wired into a host's config. */
export function listImmuneCommands(hostId: ConnectHostId, home?: string): string[] {
  const host = HOSTS[hostId];
  const configPath = configPathOf(host, home ?? homedir());
  if (!existsSync(configPath)) return [];
  try {
    const table = eventTableOf(host, readConfig(configPath).config);
    const commands: string[] = [];
    for (const groups of Object.values(table)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isImmuneGroup(group)) continue;
        for (const hook of group.hooks) commands.push(hook.command);
      }
    }
    return commands;
  } catch {
    return [];
  }
}

export interface ConnectPathIssue {
  host: string;
  label: string;
  /** Command strings whose quoted script file no longer exists. */
  broken: string[];
}

/**
 * The npx-cache failure mode, made visible: a connected host whose hook
 * commands point at files that no longer exist. `immune doctor` reports it;
 * the fix is one `connect <host>` re-run.
 */
export function verifyConnectedPaths(home?: string): ConnectPathIssue[] {
  const issues: ConnectPathIssue[] = [];
  for (const hostId of Object.keys(HOSTS) as ConnectHostId[]) {
    if (connectStatus({ home }).find((row) => row.host === hostId)?.state !== 'connected') continue;
    const host = HOSTS[hostId];
    const broken = listImmuneCommands(hostId, home)
      .map((command) => command.match(/"(.+)"/)?.[1] ?? '')
      .filter((path) => path.length > 0 && !existsSync(path));
    if (broken.length > 0) issues.push({ host: hostId, label: host.label, broken });
  }
  return issues;
}

/**
 * Delete the vendored install once NO host config carries immune entries any
 * more. Only ever removes the directory this module created (its version
 * marker is the proof of ownership).
 */
function maybeCleanupVendor(home: string): boolean {
  const vendorRoot = vendorRootOf(home);
  if (!existsSync(join(vendorRoot, 'version.json'))) return false;
  const stillConnected = connectStatus({ home }).some((row) => row.state === 'connected');
  if (stillConnected) return false;
  rmSync(vendorRoot, { recursive: true, force: true });
  return true;
}

/** Remove every immune hook entry from the host's config. */
export function disconnectHost(hostId: ConnectHostId, options?: ConnectOptions): ConnectReport {
  const home = options?.home ?? homedir();
  const vendor = vendorInfoOf(home);
  // Disconnect must not CREATE a vendored install; it only reports where the
  // scripts would live (the vendor copy when present, else the package dist).
  const host = HOSTS[hostId];
  const configPath = configPathOf(host, home);
  const scriptDir = options?.scriptDir ?? join(vendorRootOf(home), 'dist', 'zcode', 'src', 'hooks');
  if (!existsSync(configPath)) {
    return {
      host: host.id,
      label: host.label,
      configPath,
      scriptDir,
      eventsWired: [],
      added: 0,
      alreadyPresent: 0,
      upgraded: 0,
      removed: 0,
      backupPath: null,
      notes: host.notes,
      vendorDir: null,
      vendorVersion: null,
      vendorRefreshed: false,
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
  const vendorRemoved = removed > 0 ? maybeCleanupVendor(home) : false;
  return {
    host: host.id,
    label: host.label,
    configPath,
    scriptDir,
    eventsWired: [],
    added: 0,
    alreadyPresent: 0,
    upgraded: 0,
    removed,
    backupPath,
    notes: host.notes,
    vendorDir: vendorRemoved ? vendor.dir : null,
    vendorVersion: null,
    vendorRefreshed: false,
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
