function escapeCell(value) {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
/** Build the SKILL.md content for the given antibodies. */
export function renderSkillMarkdown(antibodies, opts = {}) {
    const minHits = opts.minHits ?? 3;
    const title = opts.title ?? 'project-pitfalls';
    const bilingual = opts.bilingual ?? true;
    const intro = bilingual
        ? [
            '本仓库已经踩过并修好的坑。动手前先看这里。',
            'Pitfalls this project already paid for. Check here before repeating a fix.',
            `只导出命中不少于 ${minHits} 次且仍然有效的抗体。`,
            `Only antibodies injected at least ${minHits} times and still healthy are listed.`,
        ]
        : [
            'Pitfalls this project already paid for.',
            `Only antibodies injected at least ${minHits} times and still healthy are listed.`,
        ];
    const header = [
        '---',
        `name: ${title}`,
        `description: ${bilingual ? '本仓库踩过的坑 / ' : ''}Pitfalls this project already paid for once. Consult before repeating a fix; ${antibodies.length} proven rules.`,
        '---',
        '',
        `# ${title}`,
        '',
        ...intro,
        '',
        bilingual
            ? '| 触发 / Trigger | 错误直觉 / Wrong instinct | 正确做法 / Do this instead | 命中 / Hits |'
            : '| Trigger | Wrong instinct | Do this instead | Hits |',
        '| --- | --- | --- | --- |',
    ];
    const rows = antibodies.map((ab) => {
        const trigger = escapeCell(ab.trigger_pattern);
        const symptom = escapeCell(ab.symptom);
        const prescription = escapeCell(ab.prescription);
        return `| ${trigger} | ${symptom} | ${prescription} | ${ab.hit_count} |`;
    });
    return `${[...header, ...rows].join('\n')}\n`;
}
