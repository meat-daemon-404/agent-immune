export const DISTILL_PROMPT = `You extract one reusable rule from a coding agent's failed-then-fixed attempt.

You are given a FAILED tool call and a later SUCCESSFUL tool call of the same tool.

Output strictly JSON, no prose, no markdown fence.

If the failure was a transient accident with no reuse value (network blip, one-off typo,
rate limit), output: {"skip": true}

Otherwise output exactly:
{"trigger_pattern": "...", "symptom": "...", "prescription": "..."}

Rules:
- trigger_pattern: the concrete things that should make an agent recall this rule.
  Use file names, package names, commands, env vars, API names or error keywords.
  Space separated, at most 8 items, no sentences.
- symptom: one sentence, at most 35 characters, the wrong instinct that caused the failure.
- prescription: one sentence, at most 60 characters, the verified correct move.
- Write symptom and prescription in the language the agent was working in.
- Be specific. "be careful" is not a prescription.
- Never include secrets, tokens, or hostnames in any field.`;
/** Build the user-side payload for one failure/success pair. */
export function buildDistillInput(failureTrace, successTrace) {
    return [
        '<failed_call>',
        failureTrace,
        '</failed_call>',
        '',
        '<successful_call>',
        successTrace,
        '</successful_call>',
    ].join('\n');
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
