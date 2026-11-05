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
async function callRoute(route, { method, url, headers = {}, body }) {
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

  return { status: res.statusCode, body: JSON.parse(res.payload || '{}') };
}

function bootRoute(t) {
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
  registerImmuneUiRoute(ctx, store);
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
