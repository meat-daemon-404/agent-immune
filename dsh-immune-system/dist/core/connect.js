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
export function vendorRootOf(home) {
    return join(home, '.dsh-immune');
}
/** This module's compiled dist root (…/dist), wherever the package lives. */
function ownDistRoot() {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
}
/** The running package's version — both repo and npm layouts (core/version.ts). */
export function ownVersion() {
    return packageVersion();
}
function readVendorVersion(vendorRoot) {
    try {
        const raw = readFileSync(join(vendorRoot, 'version.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed.version === 'string' ? parsed.version : null;
    }
    catch {
        return null;
    }
}
function hasVendorModuleType(vendorRoot) {
    try {
        const raw = readFileSync(join(vendorRoot, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed.type === 'module';
    }
    catch {
        return false;
    }
}
/**
 * Copy the dist tree into the vendor root unless that version is already
 * there. `force` re-copies (a dev checkout can change code without a version
 * bump). The version marker records what is vendored and when.
 */
export function vendorDist(home, opts = {}) {
    const vendorRoot = vendorRootOf(home);
    const distDir = join(vendorRoot, 'dist');
    const version = ownVersion();
    const existing = readVendorVersion(vendorRoot);
    // The version marker alone is not enough: a half-deleted vendor tree (an
    // interrupted cleanup, a paranoid antivirus) keeps its marker while the
    // scripts are gone. A missing canary forces the re-copy too.
    const canary = join(distDir, 'zcode', 'src', 'hooks', 'session-start.js');
    const refreshed = opts.force === true ||
        existing === null ||
        existing !== version ||
        !existsSync(canary) ||
        !hasVendorModuleType(vendorRoot);
    if (refreshed) {
        rmSync(distDir, { recursive: true, force: true });
        cpSync(ownDistRoot(), distDir, { recursive: true });
        mkdirSync(vendorRoot, { recursive: true });
        // The package fingerprint is what core/selfnoise.ts walks up to: without
        // it, a host connected through the vendor copy would learn "episodes"
        // from failures on the immune install itself (maintenance, not pitfalls).
        writeFileSync(join(vendorRoot, 'package.json'), `${JSON.stringify({ name: 'dsh-immune-system', version, type: 'module', private: true }, null, 2)}\n`, 'utf8');
        writeFileSync(join(vendorRoot, 'version.json'), `${JSON.stringify({ version, connectedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    }
    return { dir: vendorRoot, distDir, version, refreshed };
}
export const HOSTS = {
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
    antigravity: {
        id: 'antigravity',
        label: 'Antigravity',
        relativeConfigPath: join('.gemini', 'config', 'hooks.json'),
        eventsKey: 'dsh-immune-system',
        includesFailureHook: false,
        dialect: 'antigravity',
        notes: [
            'takes effect from the next Antigravity session or invocation (重启或新开对话后生效)',
        ],
    },
};
/** Events in wiring order; timeouts in seconds (ZCode's manifest uses ms). */
const HOOK_SPECS = [
    { event: 'SessionStart', script: 'session-start.js', timeout: 20, antigravityFlat: true },
    {
        event: 'UserPromptSubmit',
        antigravityEvent: 'PreInvocation',
        script: 'user-prompt-submit.js',
        timeout: 5,
        antigravityFlat: true,
    },
    {
        event: 'PreToolUse',
        script: 'pre-tool-use.js',
        timeout: 4,
        // Codex names its tools differently: shell_command / apply_patch. A
        // ZCode-shaped matcher would never fire there, silently killing recall
        // and guards on that host. Antigravity names them run_command / edit_file / etc.
        matcher: 'Bash|Edit|Write|MultiEdit|Read|Grep|Glob',
        codexMatcher: 'shell_command|exec_command|shell|local_shell|apply_patch',
        antigravityMatcher: 'run_command|edit_file|write_file|read_file|replace_file_content|multi_replace_file_content|write_to_file|view_file|grep_search|find_by_name|list_dir',
    },
    { event: 'PostToolUse', script: 'post-tool-use.js', timeout: 5, antigravityMatcher: '*' },
    { event: 'PostToolUseFailure', script: 'post-tool-use-failure.js', timeout: 5 },
    { event: 'Stop', script: 'stop.js', timeout: 30, antigravityFlat: true },
];
/**
 * Matches every command layout this module has ever written: the npm/repo
 * layout (`dsh-immune-system/dist/zcode/src/hooks/…`) and the vendored one
 * (`~/.dsh-immune/dist/zcode/src/hooks/…`). `--remove` uninstalls every
 * match, so an upgrade never leaves stragglers behind.
 */
const IMMUNE_COMMAND = /(\.dsh-immune|dsh-immune-system)[\\/]dist[\\/]zcode[\\/]src[\\/]hooks[\\/]/;
/** The compiled hooks directory that ships next to this module in dist/. */
export function defaultScriptDir() {
    // dist/core/connect.js -> dist/zcode/src/hooks
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'zcode', 'src', 'hooks');
}
function configPathOf(host, home) {
    return join(home, host.relativeConfigPath);
}
function commandFor(scriptDir, script) {
    // Forward slashes keep the JSON readable and work for node on every platform.
    return `node "${join(scriptDir, script).replace(/\\/g, '/')}"`;
}
function eventTableOf(host, config) {
    if (host.eventsKey === null)
        return config;
    const table = config[host.eventsKey];
    if (table === undefined) {
        const created = {};
        config[host.eventsKey] = created;
        return created;
    }
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
        throw new Error(`${host.relativeConfigPath}: "${host.eventsKey}" is not a hook table`);
    }
    return table;
}
function specsFor(host) {
    return HOOK_SPECS.filter((spec) => host.includesFailureHook || spec.event !== 'PostToolUseFailure');
}
function isFlatHandler(entry) {
    return (typeof entry === 'object' &&
        entry !== null &&
        typeof entry.command === 'string' &&
        !Array.isArray(entry.hooks));
}
function entryHandlers(entry) {
    if (isFlatHandler(entry))
        return [entry];
    return Array.isArray(entry?.hooks) ? entry.hooks : [];
}
/** Build the event table this module would write — exported for tests. */
export function buildEventTable(host, scriptDir) {
    const table = {};
    for (const spec of specsFor(host)) {
        const eventName = host.dialect === 'antigravity' ? (spec.antigravityEvent ?? spec.event) : spec.event;
        const handler = {
            type: 'command',
            command: commandFor(scriptDir, spec.script),
            timeout: spec.timeout,
        };
        if (host.dialect === 'antigravity' && spec.antigravityFlat) {
            table[eventName] = [handler];
            continue;
        }
        const matcher = host.id === 'codex'
            ? (spec.codexMatcher ?? spec.matcher)
            : host.dialect === 'antigravity'
                ? (spec.antigravityMatcher ?? spec.matcher)
                : spec.matcher;
        table[eventName] = [
            {
                ...(matcher ? { matcher } : {}),
                hooks: [handler],
            },
        ];
    }
    return table;
}
function isImmuneEntry(entry) {
    return entryHandlers(entry).some((hook) => IMMUNE_COMMAND.test(hook?.command ?? ''));
}
function readConfig(configPath) {
    if (!existsSync(configPath))
        return { existed: false, config: {} };
    const raw = readFileSync(configPath, 'utf8');
    if (raw.trim() === '')
        return { existed: true, config: {} };
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('not a JSON object');
        }
        return { existed: true, config: parsed };
    }
    catch (error) {
        // Never clobber a config we cannot read; the user fixes it by hand.
        throw new Error(`${configPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it by hand first`);
    }
}
function writeConfig(configPath, config, existed) {
    if (existed) {
        // One reversible step before the first write; never overwritten afterwards.
        const backupPath = `${configPath}.bak-immune`;
        if (!existsSync(backupPath))
            copyFileSync(configPath, backupPath);
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        return backupPath;
    }
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return null;
}
function resolveSetup(hostId, options) {
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
function assertScriptsExist(host, scriptDir) {
    const missing = specsFor(host)
        .map((spec) => spec.script)
        .filter((script) => !existsSync(join(scriptDir, script)));
    if (missing.length > 0) {
        throw new Error(`hook scripts missing under ${scriptDir}: ${missing.join(', ')} — the install looks broken`);
    }
}
/** Add the immune hooks to the host's config. Idempotent; upgrades stale paths. */
export function connectHost(hostId, options) {
    const { host, configPath, scriptDir, vendor } = resolveSetup(hostId, options);
    assertScriptsExist(host, scriptDir);
    const { existed, config } = readConfig(configPath);
    const table = eventTableOf(host, config);
    let added = 0;
    let alreadyPresent = 0;
    let upgraded = 0;
    const eventsWired = [];
    const wanted = buildEventTable(host, scriptDir);
    for (const [event, entries] of Object.entries(wanted)) {
        const current = Array.isArray(table[event]) ? table[event] : [];
        const wantedEntry = entries[0];
        const wantedCommand = entryHandlers(wantedEntry)[0]?.command ?? '';
        const wantedMatcher = isFlatHandler(wantedEntry) ? undefined : wantedEntry.matcher;
        const wantFlat = isFlatHandler(wantedEntry);
        // Stale means the command, matcher, or handler layout (flat vs grouped)
        // no longer matches what this connect would write: an npx cache path, an
        // old vendor root, a dev checkout, or a dialect whose tool-name matcher
        // was wrong (the Codex PreToolUse matcher fix). Upgrading in place is what
        // actually reaches users who connected with the broken layout.
        const matchesWanted = (entry) => isImmuneEntry(entry) &&
            isFlatHandler(entry) === wantFlat &&
            entryHandlers(entry)[0]?.command === wantedCommand &&
            (wantFlat || entry.matcher === wantedMatcher);
        const stale = current.filter((entry) => isImmuneEntry(entry) && !matchesWanted(entry));
        const currentHasWanted = current.some(matchesWanted);
        const kept = current.filter((entry) => !stale.includes(entry));
        if (currentHasWanted) {
            alreadyPresent += 1;
            table[event] = kept.length > 0 ? kept : current;
        }
        else if (stale.length > 0) {
            // A stale install on this event is an upgrade, not a new wiring.
            upgraded += stale.length;
            table[event] = [...kept, ...entries];
        }
        else {
            table[event] = [...current, ...entries];
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
export function vendorInfoOf(home) {
    const dir = vendorRootOf(home);
    return { dir, version: readVendorVersion(dir) };
}
/** Immune command strings currently wired into a host's config. */
export function listImmuneCommands(hostId, home) {
    const host = HOSTS[hostId];
    const configPath = configPathOf(host, home ?? homedir());
    if (!existsSync(configPath))
        return [];
    try {
        const table = eventTableOf(host, readConfig(configPath).config);
        const commands = [];
        for (const entries of Object.values(table)) {
            if (!Array.isArray(entries))
                continue;
            for (const entry of entries) {
                if (!isImmuneEntry(entry))
                    continue;
                for (const hook of entryHandlers(entry))
                    commands.push(hook.command);
            }
        }
        return commands;
    }
    catch {
        return [];
    }
}
/**
 * The npx-cache failure mode, made visible: a connected host whose hook
 * commands point at files that no longer exist. `immune doctor` reports it;
 * the fix is one `connect <host>` re-run.
 */
export function verifyConnectedPaths(home) {
    const issues = [];
    for (const hostId of Object.keys(HOSTS)) {
        if (connectStatus({ home }).find((row) => row.host === hostId)?.state !== 'connected')
            continue;
        const host = HOSTS[hostId];
        const broken = listImmuneCommands(hostId, home)
            .map((command) => command.match(/"(.+)"/)?.[1] ?? '')
            .filter((path) => path.length > 0 && !existsSync(path));
        if (broken.length > 0)
            issues.push({ host: hostId, label: host.label, broken });
    }
    return issues;
}
/**
 * Delete the vendored install once NO host config carries immune entries any
 * more. Only ever removes the directory this module created (its version
 * marker is the proof of ownership).
 */
function maybeCleanupVendor(home) {
    const vendorRoot = vendorRootOf(home);
    if (!existsSync(join(vendorRoot, 'version.json')))
        return false;
    const stillConnected = connectStatus({ home }).some((row) => row.state === 'connected');
    if (stillConnected)
        return false;
    rmSync(vendorRoot, { recursive: true, force: true });
    return true;
}
/** Remove every immune hook entry from the host's config. */
export function disconnectHost(hostId, options) {
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
        const entries = table[event];
        if (!Array.isArray(entries))
            continue;
        const kept = entries
            .map((entry) => {
            if (!isImmuneEntry(entry))
                return entry;
            if (isFlatHandler(entry)) {
                removed += 1;
                return null;
            }
            const hooks = entry.hooks.filter((hook) => !IMMUNE_COMMAND.test(hook?.command ?? ''));
            removed += entry.hooks.length - hooks.length;
            return hooks.length > 0 ? { ...entry, hooks } : null;
        })
            .filter((entry) => entry !== null);
        if (kept.length > 0)
            table[event] = kept;
        else
            delete table[event];
    }
    if (host.dialect === 'antigravity' && host.eventsKey !== null && Object.keys(table).length === 0) {
        delete config[host.eventsKey];
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
/** Which hosts already carry immune hooks, without writing anything. */
export function connectStatus(options) {
    return Object.values(HOSTS).map((host) => {
        const configPath = configPathOf(host, options?.home ?? homedir());
        if (!existsSync(configPath)) {
            return { host: host.id, label: host.label, configPath, state: 'no-config', events: [] };
        }
        try {
            const table = eventTableOf(host, readConfig(configPath).config);
            const events = Object.entries(table)
                .filter(([, entries]) => Array.isArray(entries) && entries.some(isImmuneEntry))
                .map(([event]) => event);
            return {
                host: host.id,
                label: host.label,
                configPath,
                state: events.length > 0 ? 'connected' : 'not-connected',
                events,
            };
        }
        catch {
            return { host: host.id, label: host.label, configPath, state: 'no-config', events: [] };
        }
    });
}
export function detectHosts(home) {
    const detected = [];
    if (existsSync(join(home, '.claude'))) {
        detected.push({ host: 'claude-code', label: 'Claude Code', marker: '~/.claude', wired: true });
    }
    if (existsSync(join(home, '.codex'))) {
        detected.push({ host: 'codex', label: 'Codex CLI', marker: '~/.codex', wired: true });
    }
    if (existsSync(join(home, '.gemini', 'antigravity')) || existsSync(join(home, '.gemini', 'config'))) {
        detected.push({
            host: 'antigravity',
            label: 'Antigravity',
            marker: existsSync(join(home, '.gemini', 'antigravity')) ? '~/.gemini/antigravity' : '~/.gemini/config',
            wired: true,
        });
    }
    if (existsSync(join(home, '.zcode'))) {
        detected.push({
            host: 'zcode',
            label: 'ZCode',
            marker: '~/.zcode',
            wired: false,
            reason: 'installs through the ZCode plugin marketplace (zcode plugins marketplace add), not connect',
        });
    }
    return detected;
}
/** Wire every detected host in one idempotent pass (zero-arg `connect`). */
export function connectAllDetected(options) {
    const home = options?.home ?? homedir();
    const detected = detectHosts(home);
    const wired = [];
    for (const candidate of detected) {
        if (!candidate.wired)
            continue;
        wired.push(connectHost(candidate.host, options));
    }
    return { wired, detected };
}
