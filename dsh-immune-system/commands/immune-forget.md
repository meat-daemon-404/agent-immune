---
description: 删除学错的抗体（按 ID / 撤销上一条 / 清理僵尸抗体）
---

Remove antibodies the immune system learned wrongly.
（删除误学到的抗体。）

Resolve the plugin root from the first line of `.dsh/immune-root.txt`. If it is
missing, say the plugin has not run here yet and stop.

Then run exactly one of these, depending on the user's intent:

| Intent | Command |
| --- | --- |
| Delete a specific antibody | `node "<plugin-root>/dist/zcode/src/cli.js" forget <id>` |
| Undo the one the last turn learned | `node "<plugin-root>/dist/zcode/src/cli.js" forget --last` |
| Drop never-injected antibodies older than 14 days | `node "<plugin-root>/dist/zcode/src/cli.js" forget --prune` |

（按 ID 删除 / 撤销上一回合刚学的 / 清理从未命中且超过 14 天的僵尸抗体。）

Rules:
- If the user did not say which one, run `/dsh-immune-system:immune` first and ask
  which id to remove. Never guess an id.
- `--prune` and `--last` are destructive but reversible only by re-learning;
  confirm with the user before running either when the intent is ambiguous.
- Report exactly what was removed (the CLI prints the ids). Do not claim removal
  if the CLI reported nothing found.
- （不要猜 id；`--prune` / `--last` 无法撤销，意图不明确时先确认；只报告 CLI 实际输出。）

Optional arguments: $ARGUMENTS
