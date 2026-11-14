import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';
import { registerImmuneUiRoute } from '../dsh-immune-system/dist/dsh/src/ui-route.js';

const CLIENT = new URL('../dsh-immune-system/client/client.js', import.meta.url);

/**
 * Load the browser bundle the way the host does.
 *
 * `window.__ModuleLoader__.load({ id, factory })` is the contract the web app
 * implements (verified against a built bundle in the DSH checkout); `require` is
 * injected into the factory, so React is a stub here — this test asserts the
 * registration, not the rendering.
 */
async function loadClient(reactStub) {
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } };
  try {
    await import(`${CLIENT.href}?t=${Date.now()}`);
  } finally {
    delete globalThis.window;
  }
  assert.ok(captured, 'the bundle must register itself with __ModuleLoader__');
  const factory = captured.factory;
  const exports = factory((name) => {
    if (name === 'react') return reactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  return { id: captured.id, exports };
}

function fakeReact(registrations) {
  return {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    // Not used, but present so a future render path does not surprise us.
    Fragment: 'fragment',
    __registrations: registrations,
  };
}

test('the client bundle registers a settings tab through ctx.slots', async (t) => {
  const calls = [];
  const ctx = {
    slots: {
      inject(name, thunk) {
        calls.push(['inject', name]);
        thunk();
      },
      register(options, component) {
        calls.push(['register', options, component]);
        return () => {};
      },
    },
  };

  const { id, exports } = await loadClient(fakeReact());
  assert.equal(id, 'dsh-immune-system', 'loader id must be the package name');
  assert.equal(exports.name, 'dsh-immune-system');
  assert.deepEqual(exports.inject, ['slots'], 'a client module declares its services');

  exports.apply(ctx);

  const injectCall = calls.find((c) => c[0] === 'inject');
  assert.equal(injectCall[1], 'settings.plugins.tab', 'must claim a real slot');

  const registerCall = calls.find((c) => c[0] === 'register');
  assert.ok(registerCall, 'a registration must happen');
  const [options, component] = registerCall.slice(1);
  assert.equal(options.name, 'settings.plugins.tab');
  assert.equal(options.id, 'immune');
  assert.equal(typeof options.label, 'function');
  assert.equal(typeof component, 'function', 'the slot content is a React component');
});

/** Minimal request/response pair for the host route. */
async function callRoute(route, { method, url, headers = {}, body }, raw = false) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;

  const res = {
    statusCode: 0,
    headers: {},
    payload: '',
    writeHead(code, hdrs) {
      this.statusCode = code;
      this.headers = hdrs ?? {};
    },
    end(chunk) {
      this.payload = chunk ?? '';
      this.settled?.();
    },
  };
  const finished = new Promise((resolve) => (res.settled = resolve));

  const handled = route.handler(req, res);
  if (body !== undefined) req.emit('data', Buffer.from(body));
  req.emit('end');
  await Promise.all([handled, finished]);

  return {
    status: res.statusCode,
    headers: res.headers,
    body: raw ? res.payload : JSON.parse(res.payload || '{}'),
  };
}

function bootRoute(t, getBudgetMs) {
  const dir = mkdtempSync(join(tmpdir(), 'immune-route-'));
  const store = new ImmuneStore({ dbPath: join(dir, 'immune.sqlite') });
  store.insert({ trigger_pattern: 'vite.config.ts loadEnv', symptom: '读不到变量', prescription: '用 loadEnv' });

  let route = null;
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'], 'the web server is an optional dependency');
      callback({ webServer: { register: (r) => ((route = r), () => {}) } });
    },
  };
  registerImmuneUiRoute(ctx, store, getBudgetMs);
  assert.ok(route, 'a route must be registered when webServer exists');

  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { route, store };
}

test('the host route serves JSON and refuses cross-origin mutations', async (t) => {
  const { route } = bootRoute(t);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/plugins/dsh-immune-system/api');

  const list = await callRoute(route, {
    method: 'GET',
    url: '/plugins/dsh-immune-system/api?view=project',
    headers: { host: '127.0.0.1:7788' },
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.antibodies.length, 1);
  assert.equal(list.body.stats.active, 1);

  const id = list.body.antibodies[0].id;

  const crossOrigin = await callRoute(route, {
    method: 'POST',
    url: '/plugins/dsh-immune-system/api',
    headers: {
      host: '127.0.0.1:7788',
      origin: 'https://evil.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ op: 'delete', id }),
  });
  assert.equal(crossOrigin.status, 403, 'a foreign origin must not mutate the library');

  const wrongType = await callRoute(route, {
    method: 'POST',
    url: '/plugins/dsh-immune-system/api',
    headers: { host: '127.0.0.1:7788', 'content-type': 'text/plain' },
    body: JSON.stringify({ op: 'delete', id }),
  });
  assert.equal(wrongType.status, 415, 'JSON is required, which also forces a preflight');

  const ok = await callRoute(route, {
    method: 'POST',
    url: '/plugins/dsh-immune-system/api',
    headers: {
      host: '127.0.0.1:7788',
      origin: 'http://127.0.0.1:7788',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ op: 'retire', id }),
  });
  assert.equal(ok.status, 200);

  const after = await callRoute(route, {
    method: 'GET',
    url: '/plugins/dsh-immune-system/api',
    headers: { host: '127.0.0.1:7788' },
  });
  assert.equal(after.body.stats.retired, 1);
});

test('the route is simply not registered when the profile has no web server', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'immune-route2-'));
  const store = new ImmuneStore({ dbPath: join(dir, 'immune.sqlite') });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let called = false;
  const ctx = {
    inject(deps, callback) {
      called = true;
      callback({}); // no webServer
    },
  };
  assert.doesNotThrow(() => registerImmuneUiRoute(ctx, store));
  assert.equal(called, true);
});

test('the route reports the session budget when a getter is supplied', async (t) => {
  const { route } = bootRoute(t, () => 5000);
  const list = await callRoute(route, {
    method: 'GET',
    url: '/plugins/dsh-immune-system/api?view=project',
    headers: { host: '127.0.0.1:7788' },
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.budgetMs, 5000, 'the tab must show the session override, not the env default');
});

test('the host route exports and imports library snapshots', async (t) => {
  const { route, store } = bootRoute(t);
  const api = '/plugins/dsh-immune-system/api';
  // The markdown export only lists proven rules (hits >= 3); prove the seed.
  const seededId = store.listAll()[0].id;
  store['db'].prepare('UPDATE antibodies SET hit_count = 5 WHERE id = ?').run(seededId);

  const md = await callRoute(route, {
    method: 'GET',
    url: `${api}/export`,
    headers: { host: '127.0.0.1:7788' },
  }, true);
  assert.equal(md.status, 200);
  assert.match(String(md.headers['content-disposition']), /immune-library\.md/);
  assert.match(md.body, /loadEnv/, 'the markdown export names the seeded rule');

  const json = await callRoute(route, {
    method: 'GET',
    url: `${api}/export?format=json`,
    headers: { host: '127.0.0.1:7788' },
  }, true);
  assert.equal(json.status, 200);
  const snapshot = JSON.parse(json.body);
  assert.equal(snapshot.format, 'dsh-immune-library');
  assert.equal(snapshot.count, 1);

  const crossOrigin = await callRoute(route, {
    method: 'POST',
    url: `${api}/import`,
    headers: {
      host: '127.0.0.1:7788',
      origin: 'https://evil.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  });
  assert.equal(crossOrigin.status, 403, 'a foreign origin must not import');

  const again = await callRoute(route, {
    method: 'POST',
    url: `${api}/import`,
    headers: {
      host: '127.0.0.1:7788',
      origin: 'http://127.0.0.1:7788',
      'content-type': 'application/json',
    },
    body: json.body,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.ok, true);
  assert.equal(again.body.added, 0, 're-importing your own snapshot merges');
  assert.equal(store.listAll().length, 1, 'no duplicate rows after a round-trip');

  const bad = await callRoute(route, {
    method: 'POST',
    url: `${api}/import`,
    headers: { host: '127.0.0.1:7788', 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'nope', antibodies: [] }),
  });
  assert.equal(bad.status, 200, 'unknown format reports through the merge report, not a crash');
});

test('the host route returns evolution stats and the client preserves them in state', async (t) => {
  const { route } = bootRoute(t);
  const list = await callRoute(route, {
    method: 'GET',
    url: '/plugins/dsh-immune-system/api?view=project',
    headers: { host: '127.0.0.1:7788' },
  });
  assert.equal(list.status, 200);
  assert.ok(list.body.evolution && Array.isArray(list.body.evolution.newRules), 'route returns evolution payload');

  // Mount ImmuneTab -> ImmunePanel with a stateful hook harness to prove the
  // client stores `body.evolution` rather than dropping it in `setData`.
  const states = new Map();
  let renderSeq = 0;
  let capturedPanelFn = null;
  const fakeSlotNode = {
    shadowRoot: null,
    attachShadow() {
      const children = [];
      this.shadowRoot = {
        querySelector: () => null,
        appendChild: (el) => children.push(el),
      };
      return this.shadowRoot;
    },
  };
  const reactHarness = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') capturedPanelFn = capturedPanelFn || (type.name === 'ImmunePanel' ? type : null);
      return { type, props, children };
    },
    useRef: () => ({ current: fakeSlotNode }),
    useCallback: (fn) => fn,
    useState(initial) {
      const idx = renderSeq++;
      if (!states.has(idx)) states.set(idx, initial);
      return [
        states.get(idx),
        (next) => {
          const val = typeof next === 'function' ? next(states.get(idx)) : next;
          states.set(idx, val);
        },
      ];
    },
    useEffect(fn) {
      fn();
    },
  };
  globalThis.document = { createElement: () => ({ setAttribute: () => {} }) };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => list.body,
  });
  try {
    let loaded = null;
    globalThis.window = { __ModuleLoader__: { load: (entry) => (loaded = entry) } };
    await import(`${CLIENT.href}?evol=${Date.now()}`);
    const exports = loaded.factory((name) => {
      if (name === 'react') return reactHarness;
      if (name === 'react-dom') return { createPortal: (node) => node };
      throw new Error(`unexpected require: ${name}`);
    });
    let TabComponent = null;
    exports.apply({
      slots: {
        inject: (_n, fn) => fn(),
        register: (_opts, comp) => (TabComponent = comp),
      },
    });
    renderSeq = 0;
    TabComponent();
    renderSeq = 0;
    const portal = TabComponent();
    assert.ok(portal && portal.children.some((c) => c?.type?.name === 'ImmunePanel'), 'portal renders ImmunePanel');
    renderSeq = 100;
    const panelComp = portal.children.find((c) => c?.type?.name === 'ImmunePanel').type;
    panelComp();
    await new Promise((r) => setTimeout(r, 10));
    renderSeq = 100;
    const tree = panelComp();
    const hasEvoClass = JSON.stringify(tree).includes('"className":"evo"');
    assert.equal(hasEvoClass, true, 'ImmunePanel must render .evo when body.evolution is returned');
  } finally {
    globalThis.fetch = prevFetch;
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('the host export route blocks rules caught by the share gate with 422', async (t) => {
  const { route, store } = bootRoute(t);
  const api = '/plugins/dsh-immune-system/api';
  const id = store.insert({
    trigger_pattern: 'mail dev@company.example',
    symptom: 'broken env',
    prescription: 'read C:\\Users\\alice\\env before running',
  });
  store['db'].prepare('UPDATE antibodies SET hit_count = 5 WHERE id = ?').run(id);

  const md = await callRoute(route, {
    method: 'GET',
    url: `${api}/export`,
    headers: { host: '127.0.0.1:7788' },
  });
  assert.equal(md.status, 422);
  assert.ok(Array.isArray(md.body.violations) && md.body.violations.length >= 1);

  const json = await callRoute(route, {
    method: 'GET',
    url: `${api}/export?format=json`,
    headers: { host: '127.0.0.1:7788' },
  });
  assert.equal(json.status, 422);
});
