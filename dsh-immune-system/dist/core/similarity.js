/**
 * Character 3-gram Jaccard similarity, used to merge near-duplicate rules.
 *
 * Why character n-grams and not word tokens: prescriptions are short, mixed
 * Chinese/English sentences ("用 pnpm 装依赖" vs "用 pnpm 安装依赖"), and word
 * tokenisation of CJK is unreliable without a dictionary. Character trigrams
 * are language-agnostic and cheap.
 */
/** Set of character trigrams; shorter strings fall back to their whole self. */
export function charTrigrams(text) {
    const clean = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const chars = [...clean];
    if (chars.length === 0)
        return new Set();
    if (chars.length < 3)
        return new Set([clean]);
    const out = new Set();
    for (let i = 0; i + 3 <= chars.length; i += 1) {
        out.add(chars.slice(i, i + 3).join(''));
    }
    return out;
}
/** J(A,B) = |A ∩ B| / |A ∪ B|; 0 for two empty sets. */
export function jaccard(a, b) {
    if (a.size === 0 && b.size === 0)
        return 0;
    let intersection = 0;
    for (const gram of a)
        if (b.has(gram))
            intersection += 1;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
/** Set of characters (for the short-text blend). */
export function charSet(text) {
    return new Set([...text.replace(/\s+/g, '').toLowerCase()]);
}
/**
 * Similarity used to decide whether two prescriptions are the same rule.
 *
 * Trigram Jaccard alone is too harsh for short CJK sentences: inserting one
 * character ("装依赖" → "安装依赖") shifts every following trigram, so a rule
 * that means the same thing scores ~0.55. Character-set Jaccard is too loose
 * for long text. The blend takes the MAX of the two, which keeps long, genuinely
 * different prescriptions apart while recognising short rewordings.
 */
export function prescriptionSimilarity(left, right) {
    const trigram = jaccard(charTrigrams(left), charTrigrams(right));
    const chars = jaccard(charSet(left), charSet(right));
    return Math.max(trigram, chars);
}
