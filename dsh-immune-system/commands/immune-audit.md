---
description: 扫描本机已有会话历史，生成踩坑体检报告并蒸馏首批抗体
---

Audit the session history already on this machine — the ZCode session db, Codex
rollouts, and Claude Code transcripts — and turn the failed-then-fixed episodes
inside it into the user's first antibodies.
（扫描本机已有的会话历史——ZCode 会话库、Codex rollout、Claude Code 转录——把其中的失败→修复轨迹变成用户最早的一批抗体。）

1. Resolve the plugin root from the first line of `.dsh/immune-root.txt`. If it is
   missing, say the plugin has not run in this project yet and stop.
   （若缺失，说明插件尚未在本项目运行过，停止。）

2. Run the report-only pass first — it stores nothing:

   `node "<plugin-root>/dist/zcode/src/cli.js" audit --dry-run --no-llm`
   （先跑只看版：不写库、不调模型。）

3. Present the report to the user as-is, in a fenced block — it is written to be
   shared: scanned calls, failures, per-tool counts, repeat offenders, and the
   avoidable token estimate when the source records usage. Name the sources that
   were absent on this machine, and keep the fixture-tested note about the Claude
   Code parser if it appears.
   （把报告原样放进代码块展示——它本来就是可截图分享的格式；缺席的源要如实点名，
   Claude Code 解析器的 fixture-tested 注记要保留。）

4. Offer to apply it. With the user's confirmation, run:

   `node "<plugin-root>/dist/zcode/src/cli.js" audit`

   which enqueues the episodes and distils them (the model path runs when the LLM
   env is configured, the deterministic path otherwise). Report how many rules were
   learned and how many episodes remain queued.
   （经用户确认后再执行不带 `--dry-run` 的版本：入队并蒸馏——配置了 LLM 环境变量走模型，
   否则走确定性路径。报告学到几条规则、还剩几个排队任务。）

Do not run the applying pass on your own initiative: seeding someone's library
without asking is their call, not yours.
（不要擅自执行写入版：往别人的库里写规则必须先问过用户。）

Optional arguments: $ARGUMENTS
