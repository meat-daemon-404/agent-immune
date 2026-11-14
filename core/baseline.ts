import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type BaselineLevel = 'widely' | 'newly';

export interface BaselineDetection {
  level: BaselineLevel;
  source: string | null;
  reason: string;
}

const LEGACY_TS_TARGETS = new Set([
  'es3',
  'es5',
  'es6',
  'es2015',
  'es2016',
  'es2017',
  'es2018',
  'es2019',
]);

/** Browser major floors roughly aligned with Baseline 2024–2025 Newly Available features. */
const NEWLY_BROWSER_FLOORS: Record<string, number> = {
  chrome: 125,
  and_chr: 125,
  edge: 125,
  opera: 111,
  firefox: 128,
  and_ff: 128,
  safari: 18,
  ios_saf: 18,
  ios: 18,
};

function readTextSafe(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Strip JSONC comments outside string literals before JSON.parse. */
function parseJsonc(raw: string): Record<string, unknown> | null {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  const normalized = out.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function splitBrowserslistQueries(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .flatMap((line) => line.split(',').map((part) => part.trim()).filter(Boolean));
}

function normalizeBrowserslistField(value: unknown): string[] {
  if (typeof value === 'string') return splitBrowserslistQueries(value);
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .flatMap((item) => splitBrowserslistQueries(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('production' in record) return normalizeBrowserslistField(record.production);
    return Object.values(record).flatMap((entry) => normalizeBrowserslistField(entry));
  }
  return [];
}

function isConservativeQuery(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || q.startsWith('not ')) return false;
  if (/\bbaseline\s+widely\s+available\b/.test(q) || q === 'widely available') return true;
  if (q === 'defaults' || /\besr\b/.test(q) || /\bie(?:_mob)?\b/.test(q)) return true;

  const lastMatch = /\blast\s+(\d+)\s+/.exec(q);
  if (lastMatch && Number(lastMatch[1]) >= 3) return true;

  const coverMatch = /^>=?\s*([0-9]+(?:\.[0-9]+)?)\s*%$/.exec(q);
  if (coverMatch && Number(coverMatch[1]) >= 0.5) return true;

  const sinceMatch = /\bsince\s+(\d{4})\b/.exec(q);
  if (sinceMatch && Number(sinceMatch[1]) < 2024) return true;

  const browserMatch =
    /^(chrome|and_chr|edge|opera|firefox|and_ff|safari|ios_saf|ios)\s*(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)?)/.exec(
      q,
    );
  if (browserMatch) {
    const floor = browserMatch[1] ? NEWLY_BROWSER_FLOORS[browserMatch[1]] : undefined;
    const op = browserMatch[2] ?? '';
    const ver = Number(browserMatch[3]);
    if (floor && (op === '<' || op === '<=' || ver < floor)) return true;
  }

  return false;
}

function readPackageJsonQueries(cwd: string): {
  queries: string[];
  nodeEngine: string | null;
} {
  const raw = readTextSafe(join(cwd, 'package.json'));
  if (!raw) return { queries: [], nodeEngine: null };
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const queries = 'browserslist' in pkg ? normalizeBrowserslistField(pkg.browserslist) : [];
    const engines =
      pkg.engines && typeof pkg.engines === 'object'
        ? (pkg.engines as Record<string, unknown>)
        : null;
    const nodeEngine = typeof engines?.node === 'string' ? engines.node : null;
    return { queries, nodeEngine };
  } catch {
    return { queries: [], nodeEngine: null };
  }
}

/**
 * Inspect workspace browser/runtime constraints (.browserslistrc, package.json, tsconfig.json).
 * Returns 'widely' when legacy or broad compatibility targets are configured, otherwise 'newly'.
 */
export function detectProjectBaselineDetail(cwd: string): BaselineDetection {
  const rcRaw = readTextSafe(join(cwd, '.browserslistrc'));
  if (rcRaw) {
    const queries = splitBrowserslistQueries(rcRaw);
    const conservative = queries.find(isConservativeQuery);
    if (conservative) {
      return { level: 'widely', source: '.browserslistrc', reason: conservative };
    }
    const firstQuery = queries[0];
    if (firstQuery) {
      return { level: 'newly', source: '.browserslistrc', reason: firstQuery };
    }
  }

  const { queries, nodeEngine } = readPackageJsonQueries(cwd);
  if (queries.length > 0) {
    const conservative = queries.find(isConservativeQuery);
    if (conservative) {
      return { level: 'widely', source: 'package.json#browserslist', reason: conservative };
    }
    return { level: 'newly', source: 'package.json#browserslist', reason: queries[0] ?? 'browserslist' };
  }

  const tsRaw = readTextSafe(join(cwd, 'tsconfig.json'));
  if (tsRaw) {
    const ts = parseJsonc(tsRaw);
    const opts =
      ts?.compilerOptions && typeof ts.compilerOptions === 'object'
        ? (ts.compilerOptions as Record<string, unknown>)
        : null;
    const target = typeof opts?.target === 'string' ? opts.target.toLowerCase() : '';
    if (LEGACY_TS_TARGETS.has(target)) {
      return { level: 'widely', source: 'tsconfig.json', reason: `target:${target}` };
    }
  }

  if (nodeEngine) {
    const major = /\b(\d{1,2})(?:\.\d+)?\b/.exec(nodeEngine);
    if (major && Number(major[1]) < 18) {
      return { level: 'widely', source: 'package.json#engines.node', reason: nodeEngine };
    }
  }

  return { level: 'newly', source: null, reason: 'default-modern' };
}

export function detectProjectBaseline(cwd: string): BaselineLevel {
  return detectProjectBaselineDetail(cwd).level;
}

/** Keep only rules compatible with the active project baseline target. */
export function filterRulesByBaseline<T extends { baseline?: BaselineLevel }>(
  rules: readonly T[],
  baseline: BaselineLevel,
): T[] {
  if (baseline === 'newly') return [...rules];
  return rules.filter((rule) => rule.baseline !== 'newly');
}

/** Infer whether external guidance text explicitly requires Baseline Newly Available APIs. */
export function inferRuleBaseline(text: string): BaselineLevel {
  const lower = text.toLowerCase();
  if (/\bbaseline\s*:?\s*newly\s+available\b|\bnewly\s+available\b/.test(lower)) {
    return 'newly';
  }
  if (
    /\banchor-name\b|\bposition-anchor\b|\banchor\s+positioning\b|\bstartviewtransition\b|\bview-transition-name\b/.test(
      lower,
    )
  ) {
    return 'newly';
  }
  return 'widely';
}

export function parseBaselineFlag(value: string | undefined): BaselineLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'widely' || normalized === 'widely-available') return 'widely';
  if (normalized === 'newly' || normalized === 'newly-available' || normalized === 'modern') {
    return 'newly';
  }
  return undefined;
}
