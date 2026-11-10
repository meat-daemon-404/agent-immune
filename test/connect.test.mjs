import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  HOSTS,
  buildEventTable,
  connectHost,
  connectStatus,
  disconnectHost,
  defaultScriptDir,
  ownVersion,
  verifyConnectedPaths,
} from '../dsh-immune-system/dist/core/connect.js';
import { rmSync } from 'node:fs';
import { isSelfEpisode } from '../dsh-immune-system/dist/core/selfnoise.js';
import { normaliseToolName } from '../dsh-immune-system/dist/zcode/src/hook-io.js';
import { targetSignature } from '../dsh-immune-system/dist/core/pairing.js';

function home() {
  return mkdtempSync(join(tmpdir(), 'immune-connect-'));
}

const SCRIPT_DIR = defaultScriptDir();

test('the dist hooks directory has every script the connect table wires', () => {
  for (const host of Object.values(HOSTS)) {
    const table = buildEventTable(host, SCRIPT_DIR);
    for (const [event, groups] of Object.entries(table)) {
      assert.ok(groups.length === 1 && groups[0].hooks.length === 1, `${event}: one group, one handler`);
      const hook = groups[0].hooks[0];
      const script = hook.command.match(/"(.+)"/)?.[1];
      assert.ok(script, `command must carry a quoted script path: ${hook.command}`);
      assert.ok(existsSync(script), `script must exist: ${script}`);
      assert.match(hook.command, /^node "/, 'command runs node with a quoted path');
      assert.ok(Number.isInteger(hook.timeout) && hook.timeout > 0, `${event}: timeout is positive seconds`);
    }
    if (!host.includesFailureHook) {
      assert.equal(table.PostToolUseFailure, undefined, `${host.id}: no failure-only event`);
    }
  }
  assert.equal(buildEventTable(HOSTS['claude-code'], SCRIPT_DIR).PostToolUseFailure !== undefined, true);
});

test('connect claude-code writes settings.json hooks and is idempotent', () => {
  const h = home();
  const first = connectHost('claude-code', { home: h });
  assert.equal(first.added, 6);
  assert.equal(first.alreadyPresent, 0);
  assert.equal(first.backupPath, null, 'nothing to back up on a fresh file');

  const settings = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'));
  assert.equal(typeof settings.hooks.SessionStart[0].hooks[0].command, 'string');
  assert.equal(
    settings.hooks.PreToolUse[0].matcher,
    'Bash|Edit|Write|MultiEdit|Read|Grep|Glob',
    'PreToolUse matcher mirrors the ZCode manifest',
  );

  const before = readFileSync(join(h, '.claude', 'settings.json'), 'utf8');
  const second = connectHost('claude-code', { home: h });
  assert.equal(second.added, 0, 'second connect adds nothing');
  assert.equal(second.alreadyPresent, 6);
  assert.equal(second.backupPath, null, 'no write, no backup');
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), before);
});

test('existing user hooks survive connect and are untouched by remove', () => {
  const h = home();
  const settingsPath = join(h, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        model: 'opus',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-owns-this', timeout: 10 }] },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const report = connectHost('claude-code', { home: h });
  assert.equal(report.added, 6);
  assert.ok(report.backupPath?.endsWith('.bak-immune'), 'first modification keeps a backup');

  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.model, 'opus', 'unrelated keys are preserved');
  const preGroups = settings.hooks.PreToolUse;
  assert.equal(preGroups.length, 2, 'our group is appended after the user group');
  assert.equal(preGroups[0].hooks[0].command, 'echo user-owns-this', 'user group first, untouched');

  const removed = disconnectHost('claude-code', { home: h });
  assert.equal(removed.removed, 6);
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'echo user-owns-this', 'only immune entries go');
});

test('connect codex wires 5 events at the root of hooks.json and needs /hooks trust', () => {
  const h = home();
  const report = connectHost('codex', { home: h });
  assert.equal(report.added, 5, 'codex has no PostToolUseFailure');
  assert.ok(report.notes.some((note) => note.includes('/hooks')), 'codex notes the trust step');

  const table = JSON.parse(readFileSync(join(h, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(table.PostToolUseFailure, undefined);
  // Codex names its tools shell_command / apply_patch — a ZCode-shaped
  // matcher here would never fire, silently killing recall and guards.
  assert.equal(table.PreToolUse[0].matcher, 'shell_command|exec_command|shell|local_shell|apply_patch');
  assert.equal(table.Stop[0].hooks[0].timeout, 30);
});

test('a codex install with the old ZCode-shaped matcher is upgraded in place', () => {
  const h = home();
  const configPath = join(h, '.codex', 'hooks.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const command = 'node "C:/somewhere/.dsh-immune/dist/zcode/src/hooks/pre-tool-use.js"';
  writeFileSync(
    configPath,
    JSON.stringify({
      PreToolUse: [
        {
          matcher: 'Bash|Edit|Write|MultiEdit|Read|Grep|Glob',
          hooks: [{ type: 'command', command, timeout: 4 }],
        },
      ],
    }),
    'utf8',
  );
  const report = connectHost('codex', { home: h, scriptDir: SCRIPT_DIR });
  assert.equal(report.upgraded, 1, 'the wrong matcher counts as stale');
  const table = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(table.PreToolUse.length, 1, 'the stale group is replaced, not duplicated');
  assert.equal(table.PreToolUse[0].matcher, 'shell_command|exec_command|shell|local_shell|apply_patch');
});

test('status reports each host without touching anything', () => {
  const h = home();
  const before = connectStatus({ home: h });
  assert.deepEqual(before.map((row) => row.state), ['no-config', 'no-config']);

  connectHost('claude-code', { home: h });
  const after = connectStatus({ home: h });
  assert.equal(after[0].state, 'connected');
  assert.deepEqual(after[0].events.sort(), [
    'PostToolUse',
    'PostToolUseFailure',
    'PreToolUse',
    'SessionStart',
    'Stop',
    'UserPromptSubmit',
  ]);
  assert.equal(after[1].state, 'no-config');
});

test('a config immune cannot parse is refused, not clobbered', () => {
  const h = home();
  const settingsPath = join(h, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, '{ not json', 'utf8');
  assert.throws(() => connectHost('claude-code', { home: h }), /not valid JSON/);
  assert.equal(readFileSync(settingsPath, 'utf8'), '{ not json', 'file left exactly as found');
});

test('remove on a host with no immune hooks reports zero and writes nothing', () => {
  const h = home();
  const settingsPath = join(h, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }), 'utf8');
  const before = readFileSync(settingsPath, 'utf8');
  const report = disconnectHost('claude-code', { home: h });
  assert.equal(report.removed, 0);
  assert.equal(report.backupPath, null, 'no change, no backup');
  assert.equal(readFileSync(settingsPath, 'utf8'), before);
});

test('connect vendors the dist tree and points hooks at the fixed copy', async () => {
  const h = home();
  const report = connectHost('claude-code', { home: h });
  assert.ok(report.vendorDir?.endsWith('.dsh-immune'), 'vendor root is ~/.dsh-immune');
  assert.equal(report.vendorRefreshed, true, 'first connect copies the dist');

  const marker = JSON.parse(readFileSync(join(h, '.dsh-immune', 'version.json'), 'utf8'));
  assert.equal(marker.version, ownVersion(), 'version marker records the package version');

  const settings = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /\.dsh-immune[\\\/]dist[\\\/]zcode[\\\/]src[\\\/]hooks[\\\/]/, 'commands target the vendored copy');
  assert.ok(existsSync(command.match(/"(.+)"/)?.[1]), 'the vendored script exists');

  // The package fingerprint at the vendor root is what self-noise detection
  // walks up to; without it, vendor-layout self episodes are learnable.
  const pkg = JSON.parse(readFileSync(join(h, '.dsh-immune', 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-immune-system');
  const vendoredFile = join(h, '.dsh-immune', 'dist', 'x.js').replace(/\\/g, '/');
  assert.equal(
    isSelfEpisode(`tool=Edit input={"file_path":"${vendoredFile}","old_string":"a"}`),
    true,
    'a file-tool failure inside the vendor tree is maintenance, not a pitfall',
  );
  // In the real connect'd runtime the module itself runs FROM the vendor copy,
  // so moduleRoot() is the vendor root and catches even command-shaped traces.
  const { pathToFileURL } = await import('node:url');
  const vendorSelfnoise = await import(`${pathToFileURL(join(h, '.dsh-immune', 'dist', 'core', 'selfnoise.js')).href}`);
  assert.equal(
    vendorSelfnoise.isSelfEpisode(`tool=Bash input={"command":"node ${join(h, '.dsh-immune', 'dist', 'zcode', 'src', 'cli.js').replace(/\\/g, '/')} list"}`),
    true,
    'the vendored module recognises its own install from any trace shape',
  );

  // A second connect is cheap: no re-copy, no path churn.
  const again = connectHost('claude-code', { home: h });
  assert.equal(again.vendorRefreshed, false, 'same version is not re-copied');
  assert.equal(again.upgraded, 0);
});

test('a stale connect path is upgraded, not left behind', () => {
  const h = home();
  const settingsPath = join(h, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node "C:/npm/_npx/old/dsh-immune-system/dist/zcode/src/hooks/session-start.js"',
                timeout: 20,
              },
            ],
          },
        ],
      },
    }),
    'utf8',
  );
  const report = connectHost('claude-code', { home: h });
  assert.equal(report.upgraded, 1, 'the npx-cache entry counts as stale and is replaced');
  assert.equal(report.added, 5, 'the other five events are new');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const groups = settings.hooks.SessionStart;
  assert.equal(groups.length, 1, 'the stale group is gone');
  assert.match(groups[0].hooks[0].command, /\.dsh-immune/, 'the new entry targets the vendor root');
});

test('removing the last connected host deletes the vendored install', () => {
  const h = home();
  connectHost('claude-code', { home: h });
  connectHost('codex', { home: h });
  assert.ok(existsSync(join(h, '.dsh-immune', 'version.json')), 'vendor exists while hosts are connected');

  disconnectHost('claude-code', { home: h });
  assert.ok(existsSync(join(h, '.dsh-immune', 'version.json')), 'codex still connected, vendor stays');

  const last = disconnectHost('codex', { home: h });
  assert.ok(last.vendorDir?.endsWith('.dsh-immune'), 'the report names the removed vendor dir');
  assert.equal(existsSync(join(h, '.dsh-immune')), false, 'vendor deleted once no host remains');
});

test('codex tool names are normalised to the pairing vocabulary', async () => {
  assert.equal(normaliseToolName('shell_command'), 'Bash');
  assert.equal(normaliseToolName('exec_command'), 'Bash');
  assert.equal(normaliseToolName('apply_patch'), 'Edit');
  assert.equal(normaliseToolName('Bash'), 'Bash', 'ZCode names pass through');
  assert.equal(normaliseToolName('unknown_tool'), 'unknown_tool');

  // The point: without the alias, a Codex shell failure/success pair lands
  // in targetSignature's unknown-tool branch and program families never
  // match (npm failing, npx succeeding would not pair).
  const failed = targetSignature(normaliseToolName('shell_command'), { command: 'npm install' });
  const fixed = targetSignature(normaliseToolName('shell_command'), { command: 'npx install' });
  assert.equal(failed.signature, 'Bash:npm:install');
  assert.equal(fixed.signature, 'Bash:npx:install');
  const { canCloseEpisode } = await import('../dsh-immune-system/dist/core/pairing.js');
  assert.equal(canCloseEpisode(failed.signature, fixed), true, 'program family pairs across npm/npx');
});

test('verifyConnectedPaths flags a host whose scripts vanished', () => {
  const h = home();
  connectHost('claude-code', { home: h });
  assert.deepEqual(verifyConnectedPaths(h), [], 'a fresh connect has no broken paths');
  rmSync(join(h, '.dsh-immune', 'dist'), { recursive: true, force: true });
  const issues = verifyConnectedPaths(h);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].host, 'claude-code');
  assert.equal(issues[0].broken.length, 6, 'every command is broken once the vendor tree is gone');
});
