/**
 * Pre-execution guards.
 *
 * Advisory text can be skipped by a model in a long turn, so a small set of
 * DETERMINISTIC mistakes also gets an explicit pre-execution check.
 *
 * Deliberately conservative in three ways:
 *
 *  1. Patterns live here, in code — never in the database. A distilled rule is
 *     model output; compiling it into a regex that can block tool calls would
 *     hand an unreviewed string the power to stop work (and invites ReDoS).
 *  2. Off unless `IMMUNE_GUARD` asks for it.
 *  3. Three modes: off (default), `warn` (louder advisory), `deny` (block).
 *     Denying is the highest-risk behaviour, so it is never the default.
 *
 * The value checked is the tool's own input text, redacted and length-capped by
 * the caller.
 */
/**
 * Rules that are wrong in essentially every environment.
 *
 * Kept short on purpose: each entry is a claim that fires without human review.
 */
export const GUARD_RULES = [
    {
        id: 'force-push-main',
        what: 'force-push 到 main/master 会覆盖他人提交',
        pattern: /\bgit\s+push\b[^\n]*\s(?:--force|-f)\b[^\n]*\b(?:main|master)\b/i,
        instead: '改用特性分支，或先 git fetch 后 rebase；确需强推用 --force-with-lease',
    },
    {
        id: 'rm-rf-root',
        what: '递归删除根目录或家目录不可逆',
        pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$HOME)\s*(?:$|[;&|])/i,
        instead: '把目标收窄到具体子目录，并先 ls 确认',
    },
    {
        id: 'git-reset-hard',
        what: 'git reset --hard 会丢弃未提交改动',
        pattern: /\bgit\s+reset\s+--hard\b/i,
        instead: '先用 git stash 或先建分支备份，再决定是否丢弃',
    },
];
export function guardMode(env = process.env) {
    const raw = env.IMMUNE_GUARD?.trim().toLowerCase();
    if (raw === 'deny')
        return 'deny';
    if (raw === 'warn' || raw === '1' || raw === 'true')
        return 'warn';
    return 'off';
}
/**
 * First rule matching `text`, or null.
 *
 * Every pattern is anchored by construction (bounded alternation, no nested
 * quantifiers), and the input is already clamped by the caller, so a match
 * cannot run away on a pathological string.
 */
export function findGuardHit(text) {
    if (!text)
        return null;
    for (const rule of GUARD_RULES) {
        if (rule.pattern.test(text))
            return { rule };
    }
    return null;
}
