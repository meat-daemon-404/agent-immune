---
description: 把经过验证的抗体导出为可共享的 project-pitfalls 技能
---

Export the antibodies that have proven themselves, so the rest of the team
inherits them.（把验证过的抗体导出，让团队继承。）

1. Resolve the plugin root from the first line of `.dsh/immune-root.txt`. If it is
   missing, say the plugin has not run here yet and stop.
   （若缺失，说明插件尚未在本项目运行过，停止。）

2. Run:

   `node "<plugin-root>/dist/zcode/src/cli.js" export [minHits] [outPath]`

   `minHits` defaults to 3. With no `outPath` the skill is written to
   `.dsh/skills/project-pitfalls/SKILL.md`.
   （`minHits` 默认 3；不给 `outPath` 时写到 `.dsh/skills/project-pitfalls/SKILL.md`。）

3. Report the absolute output path and how many antibodies were written.
   （报告输出的绝对路径和写入条数。）

4. If the CLI reports that nothing reached the threshold, do not lower the bar on
   your own. Explain that antibodies need repeated use first, and offer to run
   `/dsh-immune-system:immune` so the user can see current hit counts.
   （若未达阈值，不要自行降低门槛；解释抗体需要反复命中，并建议先运行
   `/dsh-immune-system:immune` 查看当前命中数。）

Do not hand-write the skill file; only the CLI produces it, so the export format
stays consistent.（不要手写技能文件，只由 CLI 生成，以保证格式一致。）

Optional arguments: $ARGUMENTS
