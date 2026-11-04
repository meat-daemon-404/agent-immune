/**
 * Text shown to the user and to the model — bilingual by default.
 *
 * The injected block appears on every matching turn, so its wording matters
 * more than anything else here: an English-only preamble in a Chinese session
 * reads as noise, and a Chinese-only one does the same for an English session.
 *
 * Both languages are emitted together, kept to one short line each so the extra
 * tokens stay cheap. `IMMUNE_LOCALE=zh-CN` or `=en` forces a single language for
 * anyone who wants to trim context cost.
 */
const PROMPT_ZH = '本项目已踩过的坑，仅供参考，采纳前请核实。';
const PROMPT_EN = 'Pitfalls this project already paid for. Advisory only: verify before relying on it.';
const TOOL_ZH = '本项目之前有非常相似的调用失败过，先看一眼：';
const TOOL_EN = 'A very similar call failed before in this project. Check this first:';
const BOTH = {
    promptPreamble: `${PROMPT_ZH}\n${PROMPT_EN}`,
    toolPreamble: `${TOOL_ZH} ${TOOL_EN}`,
    trigger: '触发/trigger',
    avoid: '忌/avoid',
    do: '宜/do',
    noAntibodies: '还没有抗体。工具先失败、随后成功之后才会产生。\nNo antibodies yet; they appear after a tool fails and then succeeds.',
    noExport: '没有抗体达到导出阈值，暂时不值得分享。\nNo antibody reached the export threshold; nothing worth sharing yet.',
    exported: '已导出 / Exported',
    forgot: '已删除抗体 / Forgot antibody',
    notFound: '没有找到抗体 / No antibody found',
};
const ZH = {
    promptPreamble: PROMPT_ZH,
    toolPreamble: TOOL_ZH,
    trigger: '触发',
    avoid: '忌',
    do: '宜',
    noAntibodies: '还没有抗体。工具先失败、随后成功之后才会产生。',
    noExport: '没有抗体达到导出阈值，暂时不值得分享。',
    exported: '已导出',
    forgot: '已删除抗体',
    notFound: '没有找到抗体',
};
const EN = {
    promptPreamble: PROMPT_EN,
    toolPreamble: TOOL_EN,
    trigger: 'trigger',
    avoid: 'avoid',
    do: 'do',
    noAntibodies: 'No antibodies yet. They appear after a tool fails and then succeeds.',
    noExport: 'No antibody reached the export threshold; nothing worth sharing yet.',
    exported: 'Exported',
    forgot: 'Forgot antibody',
    notFound: 'No antibody found',
};
/**
 * Resolve the active locale.
 *
 * Default is bilingual. An explicit `IMMUNE_LOCALE` opts into a single language.
 */
export function resolveLocale(env = process.env) {
    const explicit = env.IMMUNE_LOCALE?.trim().toLowerCase();
    if (!explicit)
        return 'both';
    if (explicit.startsWith('zh'))
        return 'zh-CN';
    if (explicit.startsWith('en'))
        return 'en';
    return 'both';
}
export function strings(locale = resolveLocale()) {
    if (locale === 'zh-CN')
        return ZH;
    if (locale === 'en')
        return EN;
    return BOTH;
}
