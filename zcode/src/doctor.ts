/**
 * `immune doctor` — installation health checks.
 *
 * Borrowed from pro-workflow's /doctor: "confirms SQLite store, hooks, skills
 * load". Support begins with the machine answering its own questions, so each
 * check names the concrete fix instead of just failing.
 *
 * Every check returns a row; the CLI prints them and exits non-zero when any
 * check failed, so it can gate a script.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImmuneStore } from '../../core/store/index.js';
import { GlobalStore, globalDbPathFor } from '../../core/store/global.js';
import { resolveDbPath } from '../../core/store/path.js';
import { findConsolidationCandidates, findLessonGroups } from '../../core/consolidate.js';
import { vendorInfoOf, verifyConnectedPaths } from '../../core/connect.js';
import { dshDirOf, ROOT_MARKER } from './root-marker.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorOptions {
  /** Overrides for probe contexts (tests). */
  pluginRoot?: string;
}

/** The package's engines bar, as a pure predicate so tests can pin it. */
export function nodeVersionSatisfied(version: string): boolean {
  const [majorRaw = '0', minorRaw = '0'] = version.split('.');
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  // engines: `^22.19.0 || >=24.0.0` — node:sqlite's DatabaseSync.backup()
  // needs 22.19+. A bare `major >= 22` would call 22.0 healthy even though
  // npm refuses to install the package there.
  return (major === 22 && minor >= 19) || major >= 24;
}

function nodeVersionOk(): CheckResult {
  const ok = nodeVersionSatisfied(process.versions.node);
  return {
    name: 'node ^22.19 || >=24 (node:sqlite)',
    ok,
    detail: `running ${process.versions.node} · engines: ^22.19.0 || >=24.0.0`,
  };
}

function ftsProbe(): CheckResult {
  try {
    const store = new ImmuneStore({ dbPath: ':memory:' });
    const id = store.insert({
      trigger_pattern: '跨域 CORS probe',
      symptom: 'probe 跨域',
      prescription: 'probe fix',
    });
    const found = id !== null && store.match('跨域').length > 0;
    store.close();
    return found
      ? { name: 'FTS5 trigram + CJK fallback', ok: true, detail: 'probe matched' }
      : { name: 'FTS5 trigram + CJK fallback', ok: false, detail: 'inserted rule was not recalled' };
  } catch (error) {
    return {
      name: 'FTS5 trigram + CJK fallback',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function databaseChecks(store: ImmuneStore): CheckResult[] {
  const results: CheckResult[] = [];
  results.push({ name: 'database opens', ok: true, detail: store.dbPath });

  try {
    const shared = new GlobalStore(globalDbPathFor(store.dbPath));
    shared.listAll(true);
    shared.close();
    results.push({ name: 'shared library readable', ok: true, detail: globalDbPathFor(store.dbPath) });
  } catch (error) {
    results.push({
      name: 'shared library readable',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return results;
}

function markerChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const marker = join(dshDirOf(), ROOT_MARKER);
  if (!existsSync(marker)) {
    results.push({
      name: 'plugin marker (.dsh/immune-root.txt)',
      ok: false,
      detail: 'missing — the plugin has not run in this project yet; run any command once',
    });
    return results;
  }
  const lines = readFileSync(marker, 'utf8').split('\n');
  const root = lines[0]?.trim() ?? '';
  const db = lines[1]?.trim() ?? '';
  results.push({
    name: 'plugin marker (.dsh/immune-root.txt)',
    ok: root.length > 0 && existsSync(root),
    detail: root || '(empty)',
  });
  results.push({
    name: 'database path from marker',
    ok: db.length > 0 && existsSync(db),
    detail: db || '(missing)',
  });
  return results;
}

function mcpCheck(): CheckResult {
  // doctor.js and mcp-server.js compile into the same directory, so the check
  // is a sibling lookup. The earlier three-levels-up walk produced
  // dist/dsh-immune-system/dist/... — a path that can never exist.
  const here = fileURLToPath(import.meta.url);
  const server = join(here, '..', 'mcp-server.js');
  const ok = existsSync(server);
  return {
    name: 'MCP server script',
    ok,
    detail: ok ? server : `missing: ${server}`,
  };
}

/** Check the native web-UI wiring declared by the plugin manifests. */
function nativeUiCheck(): CheckResult {
  const name = 'Native UI contract';
  try {
    const here = fileURLToPath(import.meta.url);
    // Compiles to <plugin>/dist/zcode/src/doctor.js, so the package root is
    // FOUR levels up: src -> zcode -> dist -> <plugin>.
    const pluginRoot = join(here, '..', '..', '..', '..');
    const manifests = [
      join(pluginRoot, 'package.json'),
      // When run from the repo instead of an installed copy, the manifest that
      // actually declares the client lives one level down.
      join(pluginRoot, 'dsh-immune-system', 'package.json'),
    ];

    for (const manifestPath of manifests) {
      if (!existsSync(manifestPath)) continue;
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

      const dsh = (raw.dsh ?? {}) as Record<string, unknown>;
      const client = (dsh.client ?? null) as Record<string, unknown> | null;
      const exportsField = (raw.exports ?? {}) as Record<string, unknown>;
      const clientExport = exportsField['./client'];

      if (!client) return { name, ok: false, detail: `${manifestPath}: dsh.client missing` };
      if (typeof clientExport !== 'string') {
        return { name, ok: false, detail: `${manifestPath}: exports["./client"] missing` };
      }

      // Resolve the declared bundle and prove it is a loader-registered module.
      const bundlePath = join(dirname(manifestPath), clientExport.replace(/^\.\//, ''));
      if (!existsSync(bundlePath)) {
        return { name, ok: false, detail: `client bundle not found: ${bundlePath}` };
      }
      const source = readFileSync(bundlePath, 'utf8');
      if (!source.includes('__ModuleLoader__')) {
        return { name, ok: false, detail: `client bundle lacks __ModuleLoader__: ${bundlePath}` };
      }

      return {
        name,
        ok: true,
        detail: `dsh.client + exports["./client"] -> ${clientExport} (loader-registered)`,
      };
    }
    return { name, ok: false, detail: 'no plugin manifest found next to the build' };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** One row of storage-footprint telemetry: file size plus live row counts. */
function storageRow(store: ImmuneStore): CheckResult {
  const s = store.stats();
  const kb = s.dbBytes === null ? 'n/a' : `${Math.max(1, Math.round(s.dbBytes / 1024))} KiB`;
  return {
    name: 'storage',
    ok: true,
    detail: `${kb} db · ${s.pendingFailures} pending · ${s.sessions} sessions · ${s.jobsTotal} jobs (${s.jobsPending} queued)`,
  };
}

/**
 * Library hygiene, reported where an operator already looks.
 *
 * Two rules with one symptom and different prescriptions are usually a stale
 * generic symptom, not a merge candidate: on this machine #47 and #48 share a
 * sentence and score 44%. Silence about that is worse than a line saying
 * "look at it", but it must not turn doctor red — the library still works.
 */
function ruleHygieneRow(store: ImmuneStore): CheckResult {
  const mergeable = findConsolidationCandidates(store).length;
  const groups = findLessonGroups(store).filter((group) => group.maxSimilarity < 0.7);
  if (mergeable === 0 && groups.length === 0) {
    return { name: 'rule hygiene', ok: true, detail: 'no duplicate or same-symptom groups' };
  }
  const parts: string[] = [];
  if (mergeable > 0) parts.push(`${mergeable} mergeable duplicate pair(s)`);
  if (groups.length > 0) parts.push(`${groups.length} same-symptom group(s) below the merge bar`);
  return {
    name: 'rule hygiene',
    ok: true,
    detail: `${parts.join(' · ')} - review with \`immune consolidate --dry-run\``,
  };
}

/**
 * A reasoning-model channel can take 30-120 s per call, but the turn-end drain
 * aborts at the budget. Without a warning the LLM path silently falls back to
 * the rule distiller on every turn and the operator never learns why.
 */
function llmBudgetRow(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const configured = Boolean(env.IMMUNE_LLM_BASE_URL?.trim() && env.IMMUNE_LLM_MODEL?.trim());
  const budget = Number(env.IMMUNE_DISTILL_BUDGET_MS ?? '12000');
  const timeout = Number(env.IMMUNE_LLM_TIMEOUT_MS ?? '20000');
  if (!configured) {
    return { name: 'LLM budget', ok: true, detail: 'no LLM configured - deterministic rule path' };
  }
  const tight = Number.isFinite(budget) && Number.isFinite(timeout) && budget < timeout;
  return {
    name: 'LLM budget',
    ok: !tight,
    detail: tight
      ? `budget ${budget} ms < LLM timeout ${timeout} ms - turn-end distillation uses the rule path; run \`immune backfill\` for model-quality rules or raise IMMUNE_DISTILL_BUDGET_MS`
      : `budget ${budget} ms covers the ${timeout} ms LLM timeout`,
  };
}

/**
 * `immune connect` writes fixed paths into the host configs; an npx cache
 * sweep or an uninstall can leave them pointing at files that no longer
 * exist, the host then runs hooks that fail silently. This check names the
 * concrete fix instead of letting the breakage fester.
 */
function connectPathsCheck(): CheckResult {
  const issues = verifyConnectedPaths();
  if (issues.length === 0) {
    return { name: 'connect hooks', ok: true, detail: 'no broken hook paths' };
  }
  const parts = issues.map(
    (issue) => `${issue.host}: ${issue.broken.length} hook command(s) point at missing files`,
  );
  return {
    name: 'connect hooks',
    ok: false,
    detail: `${parts.join(' · ')} — re-run: npx dsh-immune-system@latest connect <host>`,
  };
}

export function runDoctor(store: ImmuneStore, options: DoctorOptions = {}): CheckResult[] {
  const results: CheckResult[] = [nodeVersionOk(), ftsProbe()];
  results.push(...databaseChecks(store));
  if (!options.pluginRoot) results.push(...markerChecks());
  results.push(mcpCheck(), nativeUiCheck());
  results.push(connectPathsCheck());
  results.push({
    name: 'counts',
    ok: true,
    detail: `${store.listAll(false).length} active / ${store.listAll(true).length - store.listAll(false).length} retired / ${store.pendingJobCount()} queued jobs / ${store.stats().suppressedRepeats} repeats suppressed`,
  });
  results.push(storageRow(store));
  results.push(ruleHygieneRow(store));
  results.push(llmBudgetRow());
  const s = store.stats();
  if (s.llmDistilled > 0 || s.llmFallbacks > 0) {
    // Advisory, not a health gate. The counters are cumulative: one degraded
    // backfill months ago would keep `immune doctor` red forever, which trains
    // people to ignore the exit code. The note still names the reason.
    results.push({
      name: 'LLM runtime',
      ok: true,
      detail:
        `${s.llmDistilled} rule(s) from the model · ${s.llmFallbacks} degraded to the rule path` +
        (s.llmFallbacks > 0 ? ' (historical; distill_jobs.note says why)' : ''),
    });
  }
  return results;
}

/** Resolve the database the same way hooks do, for doctor's own store. */
export function doctorDbPath(): string {
  return resolveDbPath();
}
