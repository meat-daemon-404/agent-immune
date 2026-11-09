import { chat } from './llm.js';
export const REWRITE_PROMPT = `You rewrite ONE stored pitfall rule so its prescription reads as an action, not a command dump.

Input JSON: { "tool", "trigger", "symptom", "currentPrescription" }

currentPrescription is a raw command or tool trace captured when the failure was fixed. Treat it as evidence of what worked, not as the answer.

"symptom" was written by an earlier pass and may be stale or wrong — several production rules carry the same generic symptom because an early lesson matched them all. Trust the command in currentPrescription over the symptom.

Output strictly JSON, no prose, no fence: {"prescription": "..."}

Rules:
- One imperative sentence, at most 60 characters, in the language of the symptom.
- State what the command ACCOMPLISHES, not the command itself ("point the build at the local binary, then rebuild").
- Use only facts present in the input. Never invent paths, flags, tool names or APIs.
- Strip vendor-specific banners and internal tool names.
- Never include secrets, tokens, hostnames or absolute user paths.
- If the command's purpose cannot be told from the input, output {"skip": true} instead of guessing.`;
/** Prescriptions that only echo the trace cannot teach anything. */
export function looksEchoPrescription(prescription) {
    const p = prescription.trim();
    if (p.length === 0)
        return true;
    if (p.startsWith('tool='))
        return true;
    // A leading "Bash:" with a real command after it is a dump. "Edit: re-read
    // the file" is advice and stays, which is why the length guard is here.
    if (/^Bash:\s/.test(p) && p.length > 30)
        return true;
    return p.length > 160;
}
/** Active rules whose prescription is a command dump, worst offenders first. */
export function echoCandidates(store) {
    return store
        .listAll(false)
        .filter((a) => a.status === 'active' && looksEchoPrescription(a.prescription))
        .sort((a, b) => b.hit_count - a.hit_count);
}
/** Parse the model's answer; null means "no usable prescription". */
export function parseRewrite(raw) {
    const cleaned = raw
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    }
    catch {
        return { ok: false, reason: 'not JSON' };
    }
    if (!parsed || typeof parsed !== 'object')
        return { ok: false, reason: 'not an object' };
    const obj = parsed;
    if (obj.skip === true)
        return { ok: false, reason: 'skip' };
    const text = typeof obj.prescription === 'string' ? obj.prescription.trim() : '';
    if (text.length < 4)
        return { ok: false, reason: 'empty' };
    if (text.length > 120)
        return { ok: false, reason: 'too long' };
    // A model that hands back another command dump has not done the job.
    if (text.startsWith('tool=') || /^Bash:\s/.test(text))
        return { ok: false, reason: 'still a command' };
    return { ok: true, prescription: text };
}
export async function rewriteEchoes(store, opts, deps = {}) {
    const call = deps.chat ?? chat;
    const active = store.listAll(false).filter((a) => a.status === 'active');
    // --id reaches a rule that is no longer echo-shaped (a bad rewrite needs a
    // second pass); otherwise only command dumps are candidates.
    const picked = opts.ids && opts.ids.length > 0
        ? active.filter((a) => opts.ids.includes(a.id))
        : active.filter((a) => looksEchoPrescription(a.prescription));
    const candidates = picked.sort((a, b) => b.hit_count - a.hit_count);
    const take = opts.max && opts.max > 0 ? candidates.slice(0, opts.max) : candidates;
    const report = {
        candidates: candidates.length,
        rewritten: 0,
        skipped: 0,
        failed: 0,
        dryRun: opts.dryRun === true,
        items: [],
    };
    for (const rule of take) {
        if (report.dryRun) {
            report.items.push({ id: rule.id, from: rule.prescription, status: 'skipped', detail: 'dry run' });
            continue;
        }
        const input = JSON.stringify({
            tool: rule.tool_name ?? '',
            trigger: rule.trigger_pattern,
            symptom: rule.symptom,
            currentPrescription: rule.prescription,
        });
        try {
            const answer = await call(opts.llm, REWRITE_PROMPT, input);
            const parsed = parseRewrite(answer);
            if (!parsed.ok) {
                report.skipped += 1;
                report.items.push({
                    id: rule.id,
                    from: rule.prescription,
                    status: 'skipped',
                    detail: parsed.reason,
                });
                continue;
            }
            if (parsed.prescription === rule.prescription.trim()) {
                report.skipped += 1;
                report.items.push({ id: rule.id, from: rule.prescription, status: 'skipped', detail: 'unchanged' });
                continue;
            }
            store.setPrescription(rule.id, parsed.prescription, 'llm');
            report.rewritten += 1;
            report.items.push({
                id: rule.id,
                from: rule.prescription,
                to: parsed.prescription,
                status: 'rewritten',
            });
        }
        catch (error) {
            report.failed += 1;
            report.items.push({
                id: rule.id,
                from: rule.prescription,
                status: 'failed',
                detail: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
            });
        }
    }
    return report;
}
