---
description: 手动教一条避坑规则（不必等踩坑）
---

Teach the immune system a rule directly — for conventions the agent keeps
getting wrong, without waiting for a failure to prove them.
（手动教一条规则，用于那些反复出错的约定，不必等失败来证明。）

1. Resolve the plugin root from the first line of `.dsh/immune-root.txt`. If it
   is missing, say the plugin has not run here yet and stop.
2. Run:

   `node "<plugin-root>/dist/zcode/src/cli.js" learn "<trigger>" ["<symptom>"] "<prescription>"`

   - `<trigger>`: when the rule applies — file names, commands, error keywords
   - `[<symptom>]`: the wrong instinct (optional)
   - `<prescription>`: the verified correct move

   Quotes matter: the whole prescription is one argument.
   （引号很重要：处方整体是一个参数。）

3. Confirm what was learned by running the `list` command once.
4. Good candidates are *durable* rules (toolchain choices, project quirks).
   One-off typos are not — the immune system already filters those at
   distillation time; do not lower the bar here.
   （适合的规则是持久性的：工具链选择、项目怪癖。一次性的手误不适合。）

Optional arguments: $ARGUMENTS
