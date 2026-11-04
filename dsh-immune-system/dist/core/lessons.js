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
        match: /string to replace not found/i,
        trigger: 'Edit old_string-not-found 精确匹配 exact-match',
        symptom: 'old_string 与文件实际内容不一致 / old_string did not match the file',
        prescription: 'Edit: 重新 Read 后精确复制待替换文本 / re-read and copy the exact text',
    },
];
/** The first generic lesson matching `symptomText`, or null. */
export function matchGenericLesson(symptomText) {
    return GENERIC_LESSONS.find((lesson) => lesson.match.test(symptomText)) ?? null;
}
