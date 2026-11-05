---
description: 打开本地免疫仪表盘（只绑 127.0.0.1）
---

Start the local immunity dashboard and give the user its URL.
（启动本地仪表盘并把地址告诉他们。）

1. Resolve the plugin root from the first line of `.dsh/immune-root.txt`. If it is
   missing, say the plugin has not run here yet and stop.

2. Start it as a **background** process, because it serves until stopped:

   ```bash
   node "<plugin-root>/dist/zcode/src/cli.js" ui > /tmp/immune-ui.log 2>&1 &
   ```

   On Windows without a POSIX shell, use `start /b node "<plugin-root>/dist/.../cli.js" ui`.
   If the port is busy the server walks forward, so read the URL from the output:
   `http://127.0.0.1:7788/`.

3. Report the URL as a clickable link. Explain in one sentence that it is
   **local only** — bound to `127.0.0.1`, and the page calls the API with a
   per-run token, so other pages in the same browser cannot read or change the
   library.

4. Do not open the browser yourself and do not keep the tool call blocked.
   （不要自己打开浏览器，也不要让这次工具调用一直挂着。）

Notes for you: the dashboard can retire, restore and delete rules, and its
search is read-only — browsing never counts as an injection, so hit counts and
promotion stay honest.

Optional arguments: $ARGUMENTS
