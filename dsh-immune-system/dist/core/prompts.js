export const DISTILL_PROMPT = `You extract one reusable rule from a coding agent's failed-then-fixed attempt.

You are given a FAILED tool call and a later SUCCESSFUL tool call of the same tool.

Output strictly JSON, no prose, no markdown fence.

Skip the episode when it has no cross-session value. Output {"skip": true} when the
failure was caused only by:
- a transient network blip, timeout, rate limit or 5xx
- a one-off typo in the agent's own command
- a sandbox or permission denial that will recur identically regardless of approach
- a missing binary that the environment provisions elsewhere

Otherwise output exactly:
{"trigger_pattern": "...", "symptom": "...", "prescription": "..."}

Rules:
- trigger_pattern: the concrete things that should make an agent recall this rule.
  Use file names, package names, commands, env vars, API names or error keywords.
  Space separated, at most 8 items, no sentences.
- symptom: one sentence, at most 35 characters, the wrong instinct that caused the failure.
- prescription: one sentence, at most 60 characters, the verified correct move.
- The success trace may end with a "repair actions:" line — those are the edits
  that actually fixed the problem. The prescription should state the FIX (for
  example "edit tsconfig.json before building"), not restate the retried command.
- Error codes (ERR_*, EACCES, HTTP 404) are strong trigger tokens; include the
  code verbatim when it discriminates this failure from others.
- Write the rule so a DIFFERENT model or agent can follow it. Strip
  vendor-specific phrasing — one model's error banner, its internal tool names,
  its own restatement of the problem — and keep the action. If the fix only
  works because of that vendor, say so in the prescription instead of hiding it.
- Write symptom and prescription in the language the agent was working in.
- Be specific. "be careful" is not a prescription.
- Never include secrets, tokens, or hostnames in any field.`;
export const BATCH_DISTILL_PROMPT = `You extract reusable rules from several failed-then-fixed attempts at once.

You are given a JSON array of episodes: [{ id, failedTrace, fixedTrace, humanHint? }].

Output strictly a JSON ARRAY with one object per input id, no prose, no markdown fence:
[{"id": 1, "trigger_pattern": "...", "symptom": "...", "prescription": "..."},
 {"id": 2, "skip": true}]

Skip an episode ({"id": N, "skip": true}) when it has no cross-session value:
transient network blips, timeouts, rate limits, one-off typos in the agent's own
command, sandbox or permission denials that recur identically, or missing binaries
the environment provisions elsewhere.

Field rules are the same as single-episode distillation:
- trigger_pattern: file names, package names, commands, env vars, error keywords;
  space separated, at most 8 items, no sentences.
- symptom: one sentence, at most 35 characters, the wrong instinct.
- prescription: one sentence, at most 60 characters, the verified correct move.
- A fixedTrace may end with a "repair actions:" line — the prescription should
  state the FIX those edits made, not restate the retried command. Error codes
  (ERR_*, EACCES, HTTP 404) are strong trigger tokens; include them verbatim.
- Write the rule so a DIFFERENT model or agent can follow it: keep the action,
  drop vendor-specific banners and internal tool names, and name the vendor
  explicitly when the fix only works for it.
- Write in the language the agent was working in.
- Never include secrets, tokens, or hostnames.

Every input id must appear exactly once in the output.`;
/** Build the batch payload: a JSON array, as the prompt asks for. */
export function buildBatchInput(episodes) {
    return JSON.stringify(episodes.map((episode) => ({
        id: episode.id,
        failedTrace: episode.failedTrace,
        fixedTrace: episode.fixedTrace,
        ...(episode.humanHint ? { humanHint: episode.humanHint } : {}),
        ...(episode.repairs && episode.repairs.length > 0 ? { repairs: episode.repairs } : {}),
    })), null, 1);
}
/**
 * Parse a batch response into per-id results.
 *
 * Anything the model failed to answer for is simply absent from the map, and the
 * caller falls back to the deterministic rule for those items — a partial answer
 * must never cost a queued episode.
 */
export function parseBatchOutput(raw, expectedIds, toolName) {
    const out = new Map();
    let parsed;
    try {
        parsed = JSON.parse(stripFence(raw));
    }
    catch {
        return out;
    }
    if (!Array.isArray(parsed))
        return out;
    const allowed = new Set(expectedIds);
    for (const item of parsed) {
        if (typeof item !== 'object' || item === null)
            continue;
        const obj = item;
        const id = typeof obj.id === 'number' ? obj.id : Number.NaN;
        // Refuse ids the model invented: an echo of a made-up id must not create a
        // rule that no episode produced.
        if (!Number.isInteger(id) || !allowed.has(id))
            continue;
        out.set(id, resultFromObject(obj, toolName));
    }
    return out;
}
/** Shared field extraction for one distilled object. */
function resultFromObject(obj, toolName) {
    if (obj.skip === true)
        return { ok: false, reason: 'skip' };
    const trigger = field(obj.trigger_pattern, 240);
    const prescription = field(obj.prescription, 240);
    if (!trigger || !prescription) {
        return { ok: false, reason: 'invalid', detail: 'missing trigger_pattern or prescription' };
    }
    return {
        ok: true,
        antibody: {
            trigger_pattern: trigger,
            symptom: field(obj.symptom, 240) ?? '(no symptom recorded)',
            prescription,
            tool_name: toolName,
        },
    };
}
/** Build the user-side payload for one failure/success pair. */
export function buildDistillInput(failureTrace, successTrace, humanHint = '') {
    const parts = [
        '<failed_call>',
        failureTrace,
        '</failed_call>',
        '',
        '<successful_call>',
        successTrace,
        '</successful_call>',
    ];
    if (humanHint.trim()) {
        // The human's correction is the highest-signal input available: it states
        // the rule outright instead of leaving the model to infer it from a diff.
        parts.push('', '<human_explanation>', humanHint.trim(), '</human_explanation>', 'The human said this after the failure. If it states the actual rule, the', 'prescription must follow it rather than a guess at what changed.');
    }
    return parts.join('\n');
}
/** Strip a surrounding markdown fence, if the model added one. */
function stripFence(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('```'))
        return trimmed;
    const lines = trimmed.split('\n');
    if (lines.length < 2)
        return trimmed;
    const body = lines.slice(1);
    const last = body[body.length - 1];
    if (last !== undefined && last.trim().startsWith('```'))
        body.pop();
    return body.join('\n').trim();
}
/** Clamp a free-text field and refuse anything empty after trimming. */
function field(value, max) {
    if (typeof value !== 'string')
        return null;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text)
        return null;
    return text.length > max ? text.slice(0, max) : text;
}
/** Parse and validate a distillation response. */
export function parseDistillOutput(raw, toolName) {
    let parsed;
    try {
        parsed = JSON.parse(stripFence(raw));
    }
    catch {
        return { ok: false, reason: 'invalid', detail: 'not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, reason: 'invalid', detail: 'not a JSON object' };
    }
    const obj = parsed;
    if (obj.skip === true)
        return { ok: false, reason: 'skip' };
    const trigger = field(obj.trigger_pattern, 240);
    const prescription = field(obj.prescription, 240);
    if (!trigger || !prescription) {
        return { ok: false, reason: 'invalid', detail: 'missing trigger_pattern or prescription' };
    }
    // Symptom is helpful but not essential; keep the rule when it is absent.
    const symptom = field(obj.symptom, 240) ?? '(no symptom recorded)';
    return {
        ok: true,
        antibody: {
            trigger_pattern: trigger,
            symptom,
            prescription,
            tool_name: toolName ?? null,
        },
    };
}
