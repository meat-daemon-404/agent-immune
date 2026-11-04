/**
 * Deciding whether a failure is plausibly related to an antibody.
 *
 * Without this, every injected antibody is blamed for every later failure in
 * the same turn. A good rule would then be retired because an unrelated command
 * failed, which is worse than not having the rule at all.
 */
import { tokenize } from './store/tokenize.js';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Overlapping 3-character windows, so Chinese phrases can be compared. */
function cjkGrams(token: string, size = 3): string[] {
  const chars = [...token];
  if (chars.length <= size) return [token];
  const out: string[] = [];
  for (let i = 0; i + size <= chars.length; i += 1) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/**
 * Meaningful lowercase tokens of a text.
 *
 * Includes CJK trigrams so "环境变量" can match inside "读不到环境变量".
 */
export function signals(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text, 32)) {
    const lower = token.toLowerCase();
    if (lower.length >= 3) out.add(lower);
    if (CJK.test(token)) for (const gram of cjkGrams(token)) out.add(gram.toLowerCase());
  }
  return out;
}

/**
 * True when the antibody's trigger shares at least one meaningful term with the
 * failure, ignoring the tool name itself.
 *
 * The tool name is excluded on purpose: almost every trigger starts with "Bash"
 * or "Edit", so sharing it would mark everything as related.
 */
export function isRelated(trigger: string, failureText: string, toolName: string): boolean {
  const ignore = toolName.toLowerCase();
  const a = [...signals(trigger)].filter((t) => t !== ignore);
  if (a.length === 0) return false;
  const b = signals(failureText);
  return a.some((token) => b.has(token));
}
