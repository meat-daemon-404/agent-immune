import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { startUiServer } from '../dsh-immune-system/dist/core/ui/server.js';
import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';

/** Seed a database and start the dashboard on an OS-assigned port. */
async function boot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'immune-ui-'));
  const dbPath = join(dir, 'immune.sqlite');
  const seed = new ImmuneStore({ dbPath });
  seed.insert({ trigger_pattern: 'vite.config.ts loadEnv', symptom: '读不到变量', prescription: '用 loadEnv' });
  seed.insert({ trigger_pattern: 'npm run build', symptom: 'missing script', prescription: '用 pnpm build' });
  seed.close();

  const handle = await startUiServer({ dbPath, port: 0 });
  const html = await (await fetch(handle.url)).text();
  const token = /var TOKEN = "([a-f0-9]+)"/.exec(html)?.[1];

  t.after(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return { handle, html, token };
}

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the dashboard serves a self-contained page on loopback', async (t) => {
  const { handle, html } = await boot(t);

  assert.ok(handle.url.startsWith('http://127.0.0.1:'), 'must never bind a public interface');
  assert.match(html, /免疫系统|Immune System/);
  // Nothing external: an offline machine and a hostile CDN both stay irrelevant.
  assert.doesNotMatch(html.replace(/127\.0\.0\.1/g, ''), /https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test('the API refuses requests without the per-run token', async (t) => {
  const { handle, token } = await boot(t);

  assert.equal((await fetch(`${handle.url}api/list`)).status, 403);
  assert.equal((await fetch(`${handle.url}api/list?t=${'0'.repeat(token.length)}`)).status, 403);
  assert.equal((await fetch(`${handle.url}api/list?t=${token}`)).status, 200);
});

test('listing and search read without inflating hit counts', async (t) => {
  const { handle, token } = await boot(t);

  const list = await (await fetch(`${handle.url}api/list?t=${token}`)).json();
  assert.equal(list.antibodies.length, 2);
  assert.equal(list.stats.active, 2);

  const found = await (
    await fetch(`${handle.url}api/list?t=${token}&q=${encodeURIComponent('vite')}`)
  ).json();
  assert.equal(found.antibodies.length, 1);
  assert.equal(
    found.antibodies[0].hit_count,
    0,
    'browsing is not injection: counts must stay untouched',
  );
});

test('mutations validate input and stay within three operations', async (t) => {
  const { handle, token } = await boot(t);
  const list = await (await fetch(`${handle.url}api/list?t=${token}`)).json();
  const id = list.antibodies[0].id;

  assert.equal((await post(`${handle.url}api/action?t=${token}`, { op: 'explode', id })).status, 400);
  assert.equal((await post(`${handle.url}api/action?t=${token}`, { op: 'delete', id: -1 })).status, 400);
  assert.equal((await post(`${handle.url}api/action?t=${token}`, { op: 'delete' })).status, 400);

  const retired = await (await post(`${handle.url}api/action?t=${token}`, { op: 'retire', id })).json();
  assert.equal(retired.ok, true);
  const afterRetire = await (await fetch(`${handle.url}api/list?t=${token}`)).json();
  assert.equal(afterRetire.stats.retired, 1);

  const restored = await (await post(`${handle.url}api/action?t=${token}`, { op: 'restore', id })).json();
  assert.equal(restored.ok, true);

  const deleted = await (await post(`${handle.url}api/action?t=${token}`, { op: 'delete', id })).json();
  assert.equal(deleted.ok, true);
  const afterDelete = await (await fetch(`${handle.url}api/list?t=${token}`)).json();
  assert.equal(afterDelete.antibodies.length, 1);
});
