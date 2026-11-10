/**
 * Environment fingerprint metabolism (ROADMAP 3.1).
 *
 * A project rule records WHICH workspace it was learned in: a content hash of
 * the dependency lockfiles plus the Node major version. When SessionStart
 * sees a different fingerprint, the affected rules enter probation — they keep
 * injecting (the lesson may still hold), but the insert path retires any
 * probation rule whose lesson the NEW environment just re-learned on its own
 * (same lesson key, new rule): that is `superseded_by_env_upgrade`, and it is
 * the ONLY decay. One state (probation), one decay rule, no tunables — the
 * AGENTS.md #19 lesson about a third knob.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The files whose change means "the environment this rule was learned in changed". */
const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'uv.lock',
  'poetry.lock',
  'requirements.txt',
];

export interface WorkspaceFingerprint {
  /** Short hash over lockfile contents + Node major. */
  key: string;
  /** The inputs that produced the hash (for display). */
  parts: string[];
}

/** Pure: hash one workspace's lockfiles + the runtime major. */
export function computeFingerprint(cwd: string, nodeMajor = process.version): WorkspaceFingerprint {
  const parts: string[] = [`node:${nodeMajor.split('.')[0] ?? '?'}`];
  for (const name of LOCKFILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const stat = statSync(path);
      // Bound the read: a lockfile is text but can be megabytes.
      const content = readFileSync(path, 'utf8').slice(0, 512 * 1024);
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
      parts.push(`${name}:${digest}:${stat.size}`);
    } catch {
      // An unreadable lockfile contributes its presence, not its content.
      parts.push(`${name}:unreadable`);
    }
  }
  const key = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  return { key, parts };
}

let cached: { cwd: string; fingerprint: WorkspaceFingerprint } | null = null;

/** The current process's workspace fingerprint (cached per process). */
export function currentFingerprint(cwd = process.cwd()): WorkspaceFingerprint {
  if (cached && cached.cwd === cwd) return cached.fingerprint;
  const fingerprint = computeFingerprint(cwd);
  cached = { cwd, fingerprint };
  return fingerprint;
}

/**
 * SessionStart metabolism: fingerprint-mismatched rules enter probation,
 * matching rules are re-validated (probation cleared). Returns the counts so
 * the caller can log one line.
 */
export function applyEnvMetabolism(
  db: import('node:sqlite').DatabaseSync,
  cwd: string,
): { probation: number; revalidated: number } {
  const current = currentFingerprint(cwd).key;
  const probation = db
    .prepare(
      `UPDATE antibodies SET probation_at = ?, updated_at = ?
        WHERE status = 'active' AND env_fingerprint != '' AND env_fingerprint != ? AND probation_at = 0`,
    )
    .run(Date.now(), Date.now(), current);
  const revalidated = db
    .prepare(
      `UPDATE antibodies SET probation_at = 0, updated_at = ?
        WHERE probation_at > 0 AND (env_fingerprint = ? OR env_fingerprint = '')`,
    )
    .run(Date.now(), current);
  return { probation: Number(probation.changes), revalidated: Number(revalidated.changes) };
}
