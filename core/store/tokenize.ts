/**
 * Search-token helpers.
 *
 * The FTS5 index uses the `trigram` tokenizer, which indexes every 3-character
 * sequence of the stored text. That gives correct CJK substring matching, but
 * only if the QUERY is also expressed as trigrams: a long Chinese phrase is not
 * itself a substring of a shorter stored field. So CJK tokens are expanded into
 * overlapping 3-character windows before the MATCH expression is built.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Split text into candidate tokens, keeping paths and CJK runs intact. */
export function tokenize(text: string, max = 12): string[] {
  const cleaned = text.replace(/[^\p{L}\p{N}_.\-/@]+/gu, ' ').trim();
  if (!cleaned) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    const token = raw.replace(/^[.\-/@]+|[.\-/@]+$/g, '');
    if (token.length < 2) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

/** Overlapping 3-character windows of a CJK token. */
function cjkGrams(token: string, size = 3, max = 8): string[] {
  const chars = [...token];
  if (chars.length <= size) return [token];
  const grams: string[] = [];
  for (let i = 0; i + size <= chars.length && grams.length < max; i += 1) {
    grams.push(chars.slice(i, i + size).join(''));
  }
  return grams;
}

/**
 * Two-character CJK windows from free text, for the LIKE fallback.
 *
 * The trigram tokenizer cannot index a 2-character term at all, so `MATCH`
 * silently returns nothing for it — yet many technical concepts in Chinese are
 * exactly two characters (跨域, 端口, 权限, 死锁, 超时, 缓存…).
 *
 * Windows are taken INSIDE every CJK run, not just from runs that happen to be
 * exactly two characters: in a natural sentence the word sits inside a longer
 * run ("怎么解决跨域" is one token), so a whole-token filter would miss it.
 * Only pure CJK is collected, which is why a LIKE wildcard can never sneak in.
 */
export function cjkBigrams(text: string, max = 6): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    const chars = [...token];
    if (chars.length < 2) continue;
    for (let i = 0; i + 1 < chars.length && out.length < max; i += 1) {
      const window = `${chars[i]}${chars[i + 1]}`;
      if (!/^[\u4e00-\u9fff]{2}$/u.test(window)) continue;
      if (!out.includes(window)) out.push(window);
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Build an FTS5 MATCH expression from free text.
 *
 * Terms shorter than the trigram window are dropped (they could never match),
 * and each term is quoted with embedded quotes doubled, so user text can never
 * inject FTS5 syntax.
 */
export function buildFtsQuery(text: string, maxTerms = 24): string | null {
  const terms: string[] = [];
  const push = (value: string) => {
    if ([...value].length < 3) return;
    if (terms.some((t) => t.toLowerCase() === value.toLowerCase())) return;
    terms.push(value);
  };

  for (const token of tokenize(text)) {
    if (CJK.test(token)) {
      for (const gram of cjkGrams(token)) push(gram);
    } else {
      push(token);
    }
    if (terms.length >= maxTerms) break;
  }

  if (terms.length === 0) return null;
  return terms
    .slice(0, maxTerms)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}
