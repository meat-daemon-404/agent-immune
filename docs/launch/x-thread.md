# X (Twitter) — thread draft

> 数字已于 2026-11-10 重跑核对（120 天窗口）；发布当天仍建议再跑一次。
> X 规则：每条 ≤280 字符（链接计 23）；首条必须独立成立；thread 每条结尾给钩子。

## Thread (5 posts)

**1/5**
I replayed 120 days of my own coding agents' tool calls — 19,958 of them.

835+ failed. 173 times the agent fixed a failure... and then hit the SAME failure again later, because nothing remembered the lesson.

So I built the missing immune system. 🧵

**2/5**
It watches every tool call. When a call fails and a later one succeeds on the same target, that pair becomes a rule (trigger → wrong instinct → verified fix), stored in local SQLite + FTS5. Zero runtime dependencies. Node's built-in sqlite only.

**3/5**
The judge was measured, not guessed: replaying 20,100 real host-labeled tool calls — 97.54% agreement, ZERO false negatives. The 2.46% false positives are probe commands where a nonzero exit IS the answer; quantified and accepted.

**4/5**
Works with Claude Code, Codex CLI (one command each), Cursor/Cline over MCP, DSH + ZCode natively. Cold start in 10s: it mines YOUR session history for lessons (`audit --dry-run`), plus hand-authored starter packs (git/node/python/docker).

**5/5**
~33M tokens burned on preventable repeats in my 120-day window. Your mileage will vary, but the audit command will tell you exactly.

Repo (MIT, zero deps): https://github.com/meat-daemon-404/agent-immune

npm: npx dsh-immune-system@latest demo

## Notes

- 附图建议：首条带 dashboard 截图（docs/dashboard.png）；第 3 条带 eval-judge 输出行。
- 数字来源：`immune audit --dry-run --days 120` 与 `scripts/eval-judge.mjs`，发布前重跑。
- 835+ 的写法：v1 渠道 842 是当次快照，thread 用 835+ 留余量；或直接用 842。
