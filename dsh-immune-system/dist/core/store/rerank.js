/** Path-ish tokens in the query: names with an extension, or dotted dirs. */
function queryPathTokens(query) {
    const tokens = new Set();
    for (const match of query.matchAll(/[\w@./\\-]+\.[A-Za-z0-9]{1,8}\b/g)) {
        const value = match[0].replace(/\\/g, '/').toLowerCase();
        if (value.length >= 3)
            tokens.add(value);
    }
    for (const match of query.matchAll(/(?:^|[\s"'(])((?:[\w-]+\/)+[\w-]+)/g)) {
        const value = match[1]?.replace(/\\/g, '/').toLowerCase();
        if (value && value.length >= 3)
            tokens.add(value);
    }
    return [...tokens].slice(0, 12);
}
/** True when the antibody's trigger names the same file or directory. */
function hasPathAffinity(trigger, tokens) {
    if (tokens.length === 0)
        return false;
    const haystack = trigger.replace(/\\/g, '/').toLowerCase();
    return tokens.some((token) => {
        if (haystack.includes(token))
            return true;
        // A bare basename still counts: "vite.config.ts" inside a long path.
        const base = token.split('/').pop();
        return Boolean(base && base.length >= 5 && haystack.includes(base));
    });
}
/** Exponential-free decay: halves in usefulness only after ~25 days. */
export function timeDecay(ageMs) {
    const days = Math.max(0, ageMs) / (24 * 60 * 60 * 1000);
    return 1 / (1 + 0.02 * days);
}
/**
 * Re-rank candidates in memory.
 *
 * Base score is log-scaled hit count (so a proven rule beats an unused one of
 * equal relevance without letting a single popular rule dominate), multiplied
 * by path affinity, shared-library discount, and time decay.
 */
export function rerank(candidates, opts) {
    const tokens = queryPathTokens(opts.query);
    const now = opts.now ?? Date.now();
    const sharedIds = opts.sharedIds;
    const scored = candidates.map((antibody) => {
        const relevance = opts.relevanceByRule?.get(antibody) ?? opts.relevance?.get(antibody.id);
        let score = relevance !== undefined
            ? relevance * (1 + Math.log1p(Math.max(0, antibody.hit_count)))
            : 1 + Math.log1p(Math.max(0, antibody.hit_count));
        if (hasPathAffinity(antibody.trigger_pattern, tokens))
            score *= 1.5;
        const isShared = opts.sharedSet ? opts.sharedSet.has(antibody) : Boolean(sharedIds?.has(antibody.id));
        if (isShared)
            score *= 0.85;
        const stamp = antibody.updated_at || antibody.created_at || now;
        score *= timeDecay(now - stamp);
        return { antibody, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.antibody);
}
