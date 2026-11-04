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
