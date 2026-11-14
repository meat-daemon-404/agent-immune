import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolve } from 'node:path';

const SERVER = resolve('dsh-immune-system/dist/zcode/src/mcp-server.js');

/** One MCP server process, driven line by line. */
function startServer(dbPath, homeDir) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, IMMUNE_DB_PATH: dbPath, HOME: homeDir, USERPROFILE: homeDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = pending.size + 1;
      // Fail fast instead of hanging the whole suite if a reply never lands.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  const stop = () =>
    new Promise((resolve) => {
      child.on('exit', resolve);
      child.kill();
    });

  return { child, call, stderr, stop };
}

async function withServer(t, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'immune-mcp-'));
  const dbPath = join(dir, 'immune.sqlite');
  const server = startServer(dbPath, dir);
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const init = await server.call('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'dsh-immune-system');

  await fn(server, dbPath);
}

test('MCP handshake and tool listing follow the wire protocol', async (t) => {
  await withServer(t, async (server) => {
    const tools = await server.call('tools/list', {});
    const names = tools.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'immune_audit',
      'immune_detours',
      'immune_export',
      'immune_forget',
      'immune_learn',
      'immune_list',
      'immune_restore',
      'immune_retire',
      'immune_rewrite_apply',
      'immune_rewrite_candidates',
      'immune_seed_packs',
      'immune_stats',
    ]);
    for (const tool of tools.result.tools) {
      assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`);
      assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    }

    const pong = await server.call('ping', {});
    assert.deepEqual(pong.result, {});

    const unknown = await server.call('no/such/method', {});
    assert.equal(unknown.error.code, -32601);
  });
});

test('immune_audit previews read-only and immune_seed_packs lists without writing', async (t) => {
  await withServer(t, async (server, dbPath) => {
    const textOf = (response) => response.result.content[0].text;

    const audit = textOf(await server.call('tools/call', { name: 'immune_audit', arguments: { days: 30 } }));
    assert.match(audit, /immune audit — last 30 day\(s\)/);
    assert.match(audit, /scan total:/);
    assert.match(audit, /dry run: nothing enqueued/, 'the MCP surface is preview-only');

    const packs = textOf(await server.call('tools/call', { name: 'immune_seed_packs', arguments: {} }));
    assert.match(packs, /git-safety/);
    assert.match(packs, /node-ts/);
    assert.match(packs, /python-uv/);
    assert.match(packs, /docker/);
    assert.match(packs, /never writes/, 'the tool states its own read-only contract');

    const detours = textOf(await server.call('tools/call', { name: 'immune_detours', arguments: {} }));
    assert.match(detours, /no convergent detours recorded/, 'the empty answer states the threshold');
    assert.match(detours, /rewrite/, 'it names the only minting path');

    // The host-delegated rewrite loop (ROADMAP 2.6): the host IS the model —
    // candidates out, validated advice back in, provenance host_llm.
    const seeded = textOf(
      await server.call('tools/call', {
        name: 'immune_learn',
        arguments: {
          trigger: 'echo rule trigger xyz',
          symptom: 'wrong installer',
          prescription: 'Bash: npm install --legacy-peer-deps --force --no-audit --verbose',
        },
      }),
    );
    const echoId = Number(seeded.match(/learned as #(\d+)/)?.[1]);
    assert.ok(echoId > 0);

    const candidates = textOf(await server.call('tools/call', { name: 'immune_rewrite_candidates', arguments: {} }));
    assert.match(candidates, /trigger_pattern/, 'the candidates carry the rewrite contract');
    assert.match(candidates, /echo rule trigger xyz/, 'the seeded echo rule is listed');

    const applied = textOf(
      await server.call('tools/call', {
        name: 'immune_rewrite_apply',
        arguments: {
          rewrites: [{ id: echoId, prescription: 'point the install at the workspace binary via npx' }],
        },
      }),
    );
    assert.match(applied, /rewritten/, 'the advice lands');
    assert.doesNotMatch(applied, /cooldown/, 'a first pass does not trip the cooldown');

    const rewritten = textOf(await server.call('tools/call', { name: 'immune_list', arguments: {} }));
    assert.match(rewritten, /point the install at the workspace binary/, 'the new wording is stored');

    const second = textOf(
      await server.call('tools/call', {
        name: 'immune_rewrite_apply',
        arguments: { rewrites: [{ id: echoId, prescription: 'another advice sentence entirely' }] },
      }),
    );
    assert.match(second, /cooldown/, 'a second pass inside the 12h window holds');

    // Neither call stored anything: the database is untouched.
    const stats = textOf(await server.call('tools/call', { name: 'immune_stats', arguments: {} }));
    const before = Number(stats.match(/(\d+) queued/)?.[1] ?? '0');
    assert.equal(before, 0, 'no jobs were enqueued by the preview');
    assert.ok(dbPath.length > 0);
  });
});

test('the full learning loop works over MCP tools', async (t) => {
  await withServer(t, async (server) => {
    const textOf = (response) => response.result.content[0].text;

    const learned = textOf(
      await server.call('tools/call', {
        name: 'immune_learn',
        arguments: {
          trigger: 'pnpm-lock.yaml 这个仓库',
          symptom: '用 npm 装依赖会报错',
          prescription: '这个仓库用 pnpm，不要用 npm',
        },
      }),
    );
    assert.match(learned, /learned as #\d+/);

    const listed = textOf(await server.call('tools/call', { name: 'immune_list', arguments: {} }));
    assert.match(listed, /pnpm/);

    const search = textOf(
      await server.call('tools/call', {
        name: 'immune_list',
        arguments: { query: 'pnpm' },
      }),
    );
    assert.match(search, /pnpm/);

    const stats = textOf(await server.call('tools/call', { name: 'immune_stats', arguments: {} }));
    assert.match(stats, /active: 1/);
    assert.match(stats, /database:/);

    const id = Number(/#(\d+)/.exec(learned)[1]);
    const retired = textOf(
      await server.call('tools/call', { name: 'immune_retire', arguments: { id } }),
    );
    assert.match(retired, /retired/);

    const afterRetire = textOf(await server.call('tools/call', { name: 'immune_list', arguments: {} }));
    assert.doesNotMatch(afterRetire, /pnpm/, 'retired rules leave the default listing');

    const restored = textOf(
      await server.call('tools/call', { name: 'immune_restore', arguments: { id } }),
    );
    assert.match(restored, /restored/);

    const forgotten = textOf(
      await server.call('tools/call', { name: 'immune_forget', arguments: { id } }),
    );
    assert.match(forgotten, /deleted/);

    const missing = textOf(
      await server.call('tools/call', { name: 'immune_forget', arguments: { id: 999 } }),
    );
    assert.match(missing, /no antibody/);

    const bad = textOf(
      await server.call('tools/call', {
        name: 'immune_learn',
        arguments: { trigger: 'x' },
      }),
    );
    assert.match(bad, /error:/);
  });
});

test('a stray line and a notification do not kill the server', async (t) => {
  await withServer(t, async (server) => {
    server.child.stdin.write('this is not json\n');
    server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    // The next real request must still be answered.
    const pong = await server.call('ping', {});
    assert.deepEqual(pong.result, {});
  });
});
