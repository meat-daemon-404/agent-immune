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
} from '../dsh-immune-system/dist/core/connect.js';

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
  assert.equal(table.PreToolUse[0].matcher, 'Bash|Edit|Write|MultiEdit|Read|Grep|Glob');
  assert.equal(table.Stop[0].hooks[0].timeout, 30);
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
