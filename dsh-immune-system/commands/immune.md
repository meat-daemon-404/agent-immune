---
description: 列出本项目已学到的避坑抗体（也可用英文提问）
---

Show the antibodies the immune system has distilled for this project.
（列出本项目已积累的避坑抗体。）

1. Resolve the plugin root: read the first line of `.dsh/immune-root.txt` in the
   current working directory. If it does not exist, the plugin has not run in
   this project yet — say so plainly and stop; do not guess a path.
   （若该文件不存在，说明插件尚未在本项目运行过，如实说明并停止，不要猜路径。）

2. Run the CLI with that root:

   `node "<plugin-root>/dist/zcode/src/cli.js" list`

   Add `--all` when the user asked to include retired antibodies.
   （加 `--all` 可包含已退役的抗体。）

3. Present the result as a compact table. Translate only the headers and your own
   commentary into the user's language; keep trigger, symptom and prescription
   text verbatim.
   （只翻译表头和你自己的说明，抗体正文原样保留。）

4. Do not invent antibodies and do not edit the database. This command is read-only.
   （不要编造抗体，不要修改数据库。本命令只读。）

Optional arguments: $ARGUMENTS
