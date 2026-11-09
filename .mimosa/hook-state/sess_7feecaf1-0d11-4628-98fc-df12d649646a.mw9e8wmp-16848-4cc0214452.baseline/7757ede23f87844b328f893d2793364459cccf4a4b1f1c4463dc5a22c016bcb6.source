/**
 * Trigger-keyword normalisation.
 *
 * Production evidence: the first real antibodies stored absolute Windows paths
 * verbatim, so one file appeared five times in five spellings and a single
 * antibody carried 700+ characters of trigger. Rules need stable, short,
 * comparable tokens — a basename identifies the file just as well and matches
 * across machines.
 */

/** Generic tokens that carry no discriminating power. */
const STOP = new Set([
  'PID', 'UAC', 'TMP', 'TEMP', 'TRUE', 'FALSE', 'NULL', 'NONE',
  'STDOUT', 'STDERR', 'STDIN', 'JSON', 'HTTP', 'HTTPS', 'UTF',
  'ERROR', 'FAILED', 'EXIT', 'ECHO', 'APPDATA', 'LOCALAPPDATA',
  'USERPROFILE', 'HOMEPATH', 'COMSPEC', 'PATH', 'HOME', 'USERS',
  'WINDOWS', 'SYSTEM32', 'EXE', 'DLL', 'LOG', 'LOGS', 'OUT', 'BIN',
  'NODE_MODULES',
]);

/** Short flag-shaped tokens (`-i`, `//F`, `--f`) are not keywords. */
const FLAG = /^[-/][A-Za-z]{1,3}$/;

/**
 * Normalise one raw candidate.
 *
 * Paths collapse to their basename; quotes are stripped; over-long or generic
 * tokens are rejected. Returns null when the token is not worth keeping.
 */
export function normalizeKeyword(raw: string): string | null {
  let token = raw.trim().replace(/^["']|["']$/g, '');
  if (!token) return null;

  if (/[\\/]/.test(token)) {
    const parts = token.split(/[\\/]+/).filter(Boolean);
    const base = parts[parts.length - 1];
    if (!base) return null;
    token = base;
  }

  if (token.length < 3 || token.length > 60) return null;
  if (FLAG.test(token)) return null;
  if (STOP.has(token.toUpperCase())) return null;
  return token;
}

/** Up to `max` meaningful words from a command string, in order. */
export function meaningfulTokens(command: string, max = 2): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s;&|]+/)) {
    if (FLAG.test(raw)) continue;
    const token = normalizeKeyword(raw);
    if (token) out.push(token);
    if (out.length >= max) break;
  }
  return out;
}
