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

  return { handle, html, token, dbPath };
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

test('the dashboard shows the effective distill budget and the API reports it', async (t) => {
  const previous = process.env.IMMUNE_DISTILL_BUDGET_MS;
  process.env.IMMUNE_DISTILL_BUDGET_MS = '12000';
  try {
    const { handle, html, token } = await boot(t);
    // Rendered as a KPI on the page (12 s, not 12000 ms).
    assert.match(html, /蒸馏预算|Distill budget/i);
    assert.match(html, /12 s/);
    // And exposed to the client so a session override is visible.
    const list = await (await fetch(`${handle.url}api/list?t=${token}`)).json();
    assert.equal(list.budgetMs, 12000);
  } finally {
    if (previous === undefined) delete process.env.IMMUNE_DISTILL_BUDGET_MS;
    else process.env.IMMUNE_DISTILL_BUDGET_MS = previous;
  }
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

test('the dashboard exports and imports library snapshots behind the token', async (t) => {
  const { handle, token, dbPath } = await boot(t);
  // The markdown export lists proven rules only; prove one through the DB.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE antibodies SET hit_count = 5 WHERE trigger_pattern = ?').run(
    'vite.config.ts loadEnv',
  );
  db.close();

  const noToken = await fetch(`${handle.url}api/export`);
  assert.equal(noToken.status, 403, 'export is token-gated like every /api path');

  const md = await fetch(`${handle.url}api/export?format=md&t=${token}`);
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-disposition') ?? '', /immune-library\.md/);
  const mdBody = await md.text();
  assert.match(mdBody, /loadEnv/, 'proven rules appear in the markdown export');

  const json = await fetch(`${handle.url}api/export?format=json&t=${token}`);
  const snapshot = await json.json();
  assert.equal(snapshot.format, 'dsh-immune-library');
  assert.equal(snapshot.count, 2);

  // Round-trip: importing your own snapshot merges without duplicates.
  const again = await (
    await fetch(`${handle.url}api/import?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    })
  ).json();
  assert.equal(again.ok, true);
  assert.equal(again.added, 0, 'self-import merges');
  const list = await (await fetch(`${handle.url}api/list?t=${token}`)).json();
  assert.equal(list.antibodies.length, 2, 'no duplicates after the round-trip');
});

test('the API exposes the value and model counters for the KPI row', async (t) => {
  const { handle, token, html, dbPath } = await boot(t);
  assert.match(html, /注入后未失败/, 'the held-up card ships with the page');

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE antibodies SET hit_count = 5, fail_count = 2').run();
  raw.close();

  const state = await (await fetch(`${handle.url}api/list?t=${token}`)).json();
  for (const key of ['suppressedRepeats', 'fails', 'llmDistilled', 'llmFallbacks', 'dbBytes']) {
    assert.equal(typeof state.stats[key], 'number', `${key} must be a number in the payload`);
  }
  assert.equal(state.stats.hits, 10, 'two rules delivered five times each');
  assert.equal(state.stats.fails, 4, 'two rules penalised twice each');
  assert.equal(state.stats.llmDistilled, 0, 'no model ran in a fresh library');
  assert.equal(state.stats.llmFallbacks, 0);
  assert.ok(Array.isArray(state.stats.byModel), 'the per-model strip has data to render');
  assert.equal(typeof state.stats.crossModelRules, 'number');
});
