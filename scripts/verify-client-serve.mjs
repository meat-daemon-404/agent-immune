/**
 * Prove the browser half is actually servable — using the HOST'S OWN code.
 *
 * The settings tab is discovered by `ClientModuleRegistry`
 * (`@deepseek-ai/dsh-client-modules`, the `client-modules` service). A package
 * only becomes a bundle row when its manifest declares
 * `dsh.client.platform === "web"` and a string `exports["./client"]`; the row is
 * then served at `/plugins/<id>/client.js?rev=<hash>`. This script mounts the
 * real registry against the real resolved package and invokes its real route
 * handler, so it fails for exactly the reasons the host would fail.
 *
 * It does NOT need a running app (and therefore works before a restart): the
 * composition is a pure function of the manifest + the file on disk.
 *
 * Run:  node scripts/verify-client-serve.mjs [profileName]
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = 'dsh-immune-system';
const profile = process.argv[2] || 'desktop';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(DSH_HOME, 'profiles', profile);
const profileAnchor = join(profileDir, 'cordis.yml');

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
  }
};

console.log(`[profile] ${profileDir}`);
if (!existsSync(profileAnchor)) {
  console.log(`  FAIL profile anchor missing: ${profileAnchor}`);
  process.exit(1);
}

// Resolve the host packages from the profile's dependency tree, not ours.
const req = createRequire(profileAnchor);
const load = async (spec) => import(pathToFileURL(req.resolve(spec)).href);
const { Context, Service } = await load('@deepseek-ai/cordis');
const { ClientModuleRegistry } = await load('@deepseek-ai/dsh-client-modules');

// Minimal stand-ins for the two services the registry injects. `entries()` must
// return the fiber shape the registry filters on (`fiber !== undefined`,
// `!disabled`), otherwise the row is silently dropped.
class FakeLoader extends Service {
  constructor(ctx) {
    super(ctx, 'loader');
  }
  entries() {
    const row = { options: { name: PKG }, fiber: {}, disabled: false };
    return [row];
  }
}
let routeHandler;
class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer');
  }
  register(route) {
    routeHandler = route.handler;
    return () => {};
  }
  whileServed(_ids, cb) {
    return cb === undefined ? undefined : cb();
  }
}

const ctx = new Context();
const baseUrl = pathToFileURL(profileAnchor).href;
try {
  ctx.baseUrl = baseUrl;
} catch {
  Object.defineProperty(ctx, 'baseUrl', { value: baseUrl, configurable: true });
}
await ctx.plugin(FakeLoader);
await ctx.plugin(FakeWebServer);

let composeError;
try {
  await ctx.plugin(ClientModuleRegistry);
} catch (error) {
  composeError = error;
}
check('registry composes without error', composeError === undefined, composeError && composeError.message);

const graph = ctx.clientModules.graph();
const row = graph.entries.find((entry) => entry.id === PKG);
check(`${PKG} appears in the boot graph`, row !== undefined, graph.entries.map((e) => e.id));
check('row url is /plugins/<id>/client.js?rev=...', Boolean(row) && /^\/plugins\/dsh-immune-system\/client\.js\?rev=[0-9a-f]{12}$/u.test(row.url), row && row.url);
check('row carries the settings-slot module edge', Boolean(row) && (row.inject ?? []).includes('@deepseek-ai/dsh-client-ui-settings'), row && row.inject);

const clientPath = ctx.clientModules.clientPath(PKG);
check('registry resolves a client path inside the package', typeof clientPath === 'string' && existsSync(clientPath), clientPath);

// Invoke the real route handler with a synthetic GET.
const response = {
  status: 0,
  headers: undefined,
  body: undefined,
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  },
  end(body) {
    this.body = body;
  },
};
if (typeof routeHandler === 'function') {
  await routeHandler({ method: 'GET', url: `/plugins/${PKG}/client.js` }, response);
}
check('GET /plugins/<id>/client.js answers 200', response.status === 200, response.status);
check('content-type is text/javascript', Boolean(response.headers) && String(response.headers['content-type']).startsWith('text/javascript'), response.headers && response.headers['content-type']);
const expected = typeof clientPath === 'string' && existsSync(clientPath) ? readFileSync(clientPath) : Buffer.alloc(0);
check('served bytes equal the file on disk', Buffer.isBuffer(response.body) && expected.length > 0 && Buffer.compare(response.body, expected) === 0, { served: response.body && response.body.length, file: expected.length });
const text = expected.toString('utf8');
check('bundle registers through window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\(\{/u.test(text));
check('bundle exports the Cordis plugin face', /exports\.apply\s*=/u.test(text) && /exports\.name\s*=/u.test(text));

console.log(`\n=== client serve check (profile=${profile}): ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
