/**
 * Curated generic lessons.
 *
 * Live evidence: the SAME pitfall was learned once per file — "file modified
 * since read" produced a separate antibody for HANDOFF-DSH.md, format.ts and
 * core.test.mjs, each occupying an injection slot for the same lesson.
 *
 * A generic pitfall deserves a generic trigger: when a distilled symptom
 * matches one of these patterns, the per-file keywords are dropped and the
 * generic rule is stored instead. The store's prescription-level dedupe then
 * merges every later instance into that one row, so the lesson accumulates
 * hits instead of multiplying.
 */
export const GENERIC_LESSONS = [
    {
        match: /file (?:has been|was) modified since read/i,
        trigger: 'Edit file-modified-since-read 重读 re-read',
        symptom: '文件自上次读取后被外部修改 / file changed since it was read',
        prescription: 'Edit: 先重新 Read 拿到当前内容再提交修改 / re-read, then edit with fresh content',
    },
    {
        match: /(?:string to replace|target content) not found/i,
        trigger: 'Edit old_string-not-found 精确匹配 exact-match',
        symptom: 'old_string 与文件实际内容不一致 / old_string did not match the file',
        prescription: 'Edit: 重新 Read 后精确复制待替换文本 / re-read and copy the exact text',
    },
    {
        match: /file has not been read yet/i,
        trigger: 'Write Edit file-not-read-yet 先读后写 read-first',
        symptom: '写入或编辑前未读取目标文件 / file has not been read yet in this session',
        prescription: 'Write/Edit: 修改已有文件前先调用 Read 读取最新内容 / Read the file first before writing or editing it',
    },
    {
        match: /found \d+ matches of the string to replace, but replace_all is false/i,
        trigger: 'Edit multiple-matches matches replace_all 多处匹配 unique-context',
        symptom: 'old_string 在文件中匹配多处且未开启 replace_all / multiple matches found with replace_all=false',
        prescription: 'Edit: 扩大 old_string 上下文使其唯一，或显式设置 replace_all: true / include more surrounding lines or set replace_all: true',
    },
    {
        match: /no changes to make:\s*old_string and new_string are (?:exactly )?the same|old_string and new_string (?:must be different|are identical)/i,
        trigger: 'Edit identical-strings no-changes old_string new_string 相同无变化',
        symptom: 'old_string 与 new_string 完全相同导致无改动 / old_string and new_string are identical (no-op edit)',
        prescription: 'Edit: 先 Read 确认文件当前状态，仅提交有实际差异的 new_string / verify current file content and only pass a changed new_string',
    },
];
/** The first generic lesson matching `symptomText`, or null. */
export function matchGenericLesson(symptomText) {
    return GENERIC_LESSONS.find((lesson) => lesson.match.test(symptomText)) ?? null;
}
