import { DISTILL_PROMPT, buildDistillInput, parseDistillOutput } from './prompts.js';
import { chat, readLlmConfig } from './llm.js';
import { extractError, extractInvocation } from './trace.js';
import { normalizeKeyword, meaningfulTokens } from './keywords.js';
/** Failures with no reuse value: the retry usually just works. */
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|rate.?limit|\b429\b|\b503\b|temporarily unavailable|network error|timed out|超时|网络|限流|请稍后/i;
const FILE_RE = /[\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|yml|yaml|toml|css|scss|html|vue|svelte)\b/g;
const ENV_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g;
const ARG_RE = /"(?:command|file_path|path|pattern|query|url|script)"\s*:\s*"((?:[^"\\]|\\.){2,200})"/g;
/** Pull up to `max` distinct, useful trigger keywords out of the two traces. */
export function extractKeywords(text, max = 8) {
    const found = [];
    const push = (raw) => {
        const token = normalizeKeyword(raw);
        if (!token)
            return;
        if (found.some((f) => f.toLowerCase() === token.toLowerCase()))
            return;
        found.push(token);
    };
    // Commands contribute their meaningful words, not their first word (`cd`,
    // `sudo`), and not their flags.
    for (const m of text.matchAll(ARG_RE)) {
        if (!m[1])
            continue;
        for (const token of meaningfulTokens(m[1], 2))
            push(token);
    }
    for (const m of text.matchAll(FILE_RE))
        if (m[0])
            push(m[0]);
    for (const m of text.matchAll(ENV_RE))
        if (m[0])
            push(m[0]);
    return found.slice(0, max);
}
/** First meaningful line of a trace, cleaned for use as a symptom. */
function firstLine(trace, max = 80) {
    const cleaned = trace
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
/**
 * Deterministic fallback: build a rule straight from the failed and successful
 * invocations without calling a model.
 */
export function ruleDistill(toolName, failureTrace, successTrace) {
    if (TRANSIENT.test(failureTrace)) {
        return { ok: false, reason: 'skip', detail: 'transient failure' };
    }
    const keywords = extractKeywords(`${failureTrace} ${successTrace}`);
    if (keywords.length === 0) {
        return { ok: false, reason: 'skip', detail: 'no reusable trigger found' };
    }
    // A trigger is a recall key, not a document: hard-cap it so one episode with
    // long absolute paths cannot dominate the injected block.
    const trigger = `${toolName} ${keywords.join(' ')}`.trim().slice(0, 160);
    // Symptom is the error itself; prescription is the invocation that worked.
    // Keeping these two clean is what makes the injected block readable.
    const error = extractError(failureTrace);
    const symptom = error || firstLine(failureTrace, 80) || 'the first attempt failed';
    const invocation = extractInvocation(successTrace);
    const prescription = invocation
        ? `${toolName}: ${invocation}`
        : firstLine(successTrace, 120) || 'use the retried invocation that succeeded';
    return {
        ok: true,
        antibody: { trigger_pattern: trigger, symptom, prescription, tool_name: toolName },
    };
}
/**
 * Distil one episode into an antibody.
 *
 * Uses the configured model when available and silently degrades to the
 * deterministic rule when the model is missing, slow, or returns junk.
 */
export async function distillEpisode(toolName, failureTrace, successTrace, opts = {}) {
    const llm = opts.llm === undefined ? readLlmConfig() : opts.llm;
    if (!llm)
        return ruleDistill(toolName, failureTrace, successTrace);
    try {
        const raw = await chat(llm, DISTILL_PROMPT, buildDistillInput(failureTrace, successTrace), opts.signal);
        const parsed = parseDistillOutput(raw, toolName);
        return parsed.ok ? parsed : ruleDistill(toolName, failureTrace, successTrace);
    }
    catch {
        // Model unreachable or misconfigured: the rule-based path keeps the loop alive.
        return ruleDistill(toolName, failureTrace, successTrace);
    }
}
