---
description: List the pitfall antibodies this project has learned
---

Show the antibodies the immune system has distilled for this project.

1. Resolve the plugin root: read the first line of `.dsh/immune-root.txt` in the current
   working directory. If the file does not exist, the plugin has not run in this project
   yet — say so plainly and stop; do not guess a path.
2. Run the CLI with that root:

   `node "<plugin-root>/dist/zcode/src/cli.js" list`

   Add `--all` when the user asked to include retired antibodies.
3. Present the result as a compact table. Translate only the headers and your own
   commentary into the user's language; keep trigger, symptom and prescription text
   verbatim.
4. Do not invent antibodies and do not edit the database. This command is read-only.

Optional arguments: $ARGUMENTS
