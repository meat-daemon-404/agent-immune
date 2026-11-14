/**
 * ROADMAP 2.6 — the host-delegated rewrite loop.
 *
 * The PRODUCTION problem (measured 2026-11-11): 47% of the active library is
 * echo-grade, and `immune rewrite` needs IMMUNE_LLM_* — a channel the
 * maintainer has not configured. The host agent running this plugin IS a top
 * model, so the rewrite can be delegated to it: this module exposes the
 * candidate list and a validated apply path, and the MCP tools hand both to
 * the host. Decision #28 is unchanged — a model writes the advice; what
 * changes is WHICH model, and the provenance says so ('host_llm').
 *
 * The batch cap and cooldown are guards, not tunables: at most 3 rules per
 * pass, at most one pass per 12h — the same shape sleep-consolidation uses.
 */
import { looksEchoPrescription } from './rewrite.js';
/** At most this many echo rules per delegated pass. */
export const HOST_REWRITE_BATCH = 3;
/** Minimum time between delegated passes. */
export const HOST_REWRITE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const KEY_LAST_RUN = 'host_rewrite_last_run';
/**
 * Read-only: the next echo-grade rules worth rewriting, most-delivered first.
 * No cooldown here — a preview must always be available; the cooldown gates
 * the WRITE pass (applyHostRewrites).
 */
export function hostRewriteCandidates(store, limit = HOST_REWRITE_BATCH) {
    return store
        .listAll(false)
        .filter((rule) => rule.status === 'active' && looksEchoPrescription(rule.prescription))
        .sort((a, b) => b.hit_count - a.hit_count)
        .slice(0, limit)
        .map((rule) => ({
        id: rule.id,
        tool_name: rule.tool_name,
        trigger_pattern: rule.trigger_pattern,
        symptom: rule.symptom,
        prescription: rule.prescription,
        hit_count: rule.hit_count,
    }));
}
/**
 * Apply one delegated pass. Guards, in order: cooldown (one pass per 12h),
 * rule exists and is still active, rule is STILL echo-grade (a candidate
 * already rewritten must not be clobbered), the new wording is not itself an
 * echo, and the id was not applied twice in this batch. Provenance records
 * 'host_llm' so captured evidence, endpoint-LLM wording and host-LLM wording
 * stay distinguishable (Decision #28).
 */
export function applyHostRewrites(store, rewrites, now = Date.now()) {
    const results = [];
    const last = store.metaValue(KEY_LAST_RUN);
    if (last > 0 && now - last < HOST_REWRITE_COOLDOWN_MS) {
        const dueAt = last + HOST_REWRITE_COOLDOWN_MS;
        return {
            results: rewrites.map((item) => ({
                id: item.id,
                status: 'skipped',
                detail: `cooldown: next delegated pass after ${new Date(dueAt).toISOString()}`,
            })),
            appliedCount: 0,
            cooldownUntil: dueAt,
        };
    }
    const seen = new Set();
    let applied = 0;
    for (const item of rewrites) {
        if (!Number.isInteger(item.id) || item.id <= 0) {
            results.push({ id: item.id, status: 'failed', detail: 'id must be a positive integer' });
            continue;
        }
        if (seen.has(item.id)) {
            results.push({ id: item.id, status: 'failed', detail: 'duplicate id in one batch' });
            continue;
        }
        if (seen.size >= HOST_REWRITE_BATCH) {
            results.push({
                id: item.id,
                status: 'skipped',
                detail: `batch cap: at most ${HOST_REWRITE_BATCH} rules per delegated pass`,
            });
            continue;
        }
        seen.add(item.id);
        const rule = store.byId(item.id);
        if (!rule || rule.status !== 'active') {
            results.push({ id: item.id, status: 'failed', detail: 'no active rule with this id' });
            continue;
        }
        if (!looksEchoPrescription(rule.prescription)) {
            results.push({
                id: item.id,
                status: 'skipped',
                detail: 'rule is no longer echo-grade — refusing to clobber existing advice',
            });
            continue;
        }
        const wording = String(item.prescription ?? '').trim();
        if (wording.length < 4) {
            results.push({ id: item.id, status: 'failed', detail: 'replacement wording is too short (< 4 chars)' });
            continue;
        }
        if (wording.length > 120) {
            results.push({ id: item.id, status: 'failed', detail: 'replacement wording is too long (> 120 chars)' });
            continue;
        }
        if (looksEchoPrescription(wording)) {
            results.push({
                id: item.id,
                status: 'failed',
                detail: 'the replacement wording is itself a command dump — write advice instead',
            });
            continue;
        }
        if (store.setPrescription(item.id, wording, 'host_llm')) {
            applied += 1;
            results.push({ id: item.id, status: 'rewritten', from: rule.prescription, to: wording });
        }
        else {
            results.push({ id: item.id, status: 'failed', detail: 'update did not land' });
        }
    }
    if (applied > 0)
        store.setMetaValue(KEY_LAST_RUN, now);
    return { results, appliedCount: applied, cooldownUntil: applied > 0 ? now + HOST_REWRITE_COOLDOWN_MS : null };
}
