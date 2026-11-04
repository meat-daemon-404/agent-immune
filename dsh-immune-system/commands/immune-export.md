---
description: Export proven antibodies as a shareable project-pitfalls skill
---

Export the antibodies that have proven themselves, so the rest of the team inherits them.

1. Resolve the plugin root from the first line of `.dsh/immune-root.txt`. If it is
   missing, say the plugin has not run here yet and stop.
2. Run:

   `node "<plugin-root>/dist/zcode/src/cli.js" export [minHits] [outPath]`

   `minHits` defaults to 3. With no `outPath` the skill is written to
   `.dsh/skills/project-pitfalls/SKILL.md`.
3. Report the absolute output path and how many antibodies were written.
4. If the CLI reports that nothing reached the threshold, do not lower the bar on your
   own. Explain that antibodies need repeated use first, and offer to run `/dsh-immune-system:immune`
   so the user can see current hit counts.

Do not hand-write the skill file; only the CLI produces it, so the export format stays
consistent.

Optional arguments: $ARGUMENTS
