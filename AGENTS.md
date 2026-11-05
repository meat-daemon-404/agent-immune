# AGENTS.md — for AI agents maintaining this repository

This project is maintained primarily by coding agents. This file is the
load-bearing summary: what the system is, which decisions are load-bearing, and
which "obvious improvements" have already been tried and failed. Read it before
changing anything in `core/`.

Human-oriented docs live in [README.md](README.md) (usage) and
[HANDOFF-DSH.md](HANDOFF-DSH.md) (host contract record).

## What this is

A hook-based plugin that turns every *failed-then-fixed* tool call into an
"antibody" (trigger → avoid → prescription), stores it in SQLite+FTS5, and
injects the relevant ones before the agent repeats the mistake. Two hosts share
one core:

```
core/   host-agnostic: store (SQLite+FTS5), distiller, lessons, guards,
        self-noise gate, i18n, sync, UI query layer
zcode/  ZCode adapter: hook scripts, CLI (cli.js), doctor
dsh/    DeepSeek Harness adapter: Cordis-style apply(ctx) + ui-route
dsh-immune-system/  the installable package (manifest, hooks.json, commands,
                    .mcp.json, client/client.js, dist/)
```

Build: `npm run build` (tsc, emits into `dsh-immune-system/dist/`). Zero runtime
dependencies — `node:sqlite` only. `dist/` and `client/client.js` are committed
so installs need no toolchain; bump versions in **four** manifests
(`package.json` ×2 fields, `dsh-immune-system/package.json` ×2,
`dsh-immune-system/.zcode-plugin/plugin.json`, `marketplace.json`).

## Load-bearing decisions (do not "simplify" these away)

Each of these was settled by evidence — measurement, source reading, or a failed
attempt that is recorded in a comment. Re-litigating one without new evidence
cost the project a regression before (see `core/distiller.ts`, the
identical-retry note).

1. **Failure is judged, not trusted.** `PostToolUseFailure` only fires when a
   tool *handler throws*; a bash command exiting non-zero returns normally with
   `isError:false` (DSH: `packages/shell/tool-bash/src/render.ts:17-21`).
   ZCode classifies in `zcode/src/outcome.ts`; DSH reads structured exitCode →
   isError → rendered trailing marker in `judgeOutcome`.

2. **Hook stdout is a strict schema.** An unknown key makes the whole hook fail
   and its output is discarded. Emit only
   `hookSpecificOutput.{hookEventName, additionalContext}` (+ `permissionDecision{,Reason}`
   for PreToolUse deny), or nothing at all.

3. **Background does not exist for hooks.** ZCode's `async` flag has no runtime
   effect and DSH waterfall listeners are awaited inline. Expensive work is
   queued in SQLite (`distill_jobs`) and drained at turn end (`Stop` /
   `agent/turn-stopping`) under a time budget.

4. **All cross-event state lives in SQLite.** Every hook is its own process; a
   module-level `Map` survives nothing. (`pending_failures`,
   `session_injections`, `distill_jobs`.)

5. **FTS5 `trigram` cannot index 2-character terms.** Measured: `跨域` → 0 rows.
   The LIKE fallback (`cjkBigrams`, windows taken inside CJK runs) is the fix. A
   "minimum 2 matched windows" relevance gate was tried and REVERTED — it cannot
   separate `怎么解决跨域` (real) from `改一下这个文件` (noise); the trade-off
   note lives in `core/store/antibodies.ts`.

6. **Self-noise gate is physical, not configured.** It resolves the module's own
   real path (junction/symlink aware) and fingerprints any path in the trace up
   to its `package.json`. Path-prefix checks against cwd miss dev checkouts that
   live elsewhere — this shipped as a documented blind spot once; do not
   reintroduce it.

7. **Shared library = two connections, never `ATTACH`.** WAL does not make
   cross-database transactions atomic, and hooks run as concurrent short-lived
   processes. Also: project rows and shared rows are never matched by id —
   the two databases have independent AUTOINCREMENT sequences that collide.
   Deduplicate shared rules by **prescription text**.

8. **Guard patterns live in code, never in the database.** Distilled rules are
   model output; compiling one into a regex that can block tool calls hands an
   unreviewed string the power to stop work, plus ReDoS risk. `deny` is never
   the default (`IMMUNE_GUARD=off|warn|deny`).

9. **Browsing is not injection.** The dashboard and MCP `immune_list` use
   read-only paths (`peek`, plain queries) that never bump `hit_count` — those
   counters drive promotion (≥5) and anti-rot retirement (3 fails).

10. **Credentials are redacted before disk.** Traces may contain secrets from
    failed commands and can be exported into a shared SKILL.md.

11. **The npm layout has a doubled `dsh-immune-system/` prefix — and that is
    correct.** The package root is the repo root, and every shipped file lives
    under the repo's `dsh-immune-system/` subdirectory, so inside
    `node_modules/dsh-immune-system/` the paths are
    `dsh-immune-system/dist/…`, `dsh-immune-system/client/client.js`, etc.
    Every reference (`main`, `exports`, `dsh.bundle.patch`, `dsh.client`) uses
    the same prefix, so the package is self-consistent. When verifying an npm
    install, probe the PREFIXED paths — a probe on
    `node_modules/dsh-immune-system/client/client.js` will report false and lie
    to you (this has cost three verification rounds already). The npm package
    intentionally ships no `hooks/` — that is ZCode-specific and reaches ZCode
    through the marketplace source directory, not the registry.

## Verification

```bash
npm test          # node:test; counts grow as coverage does — green is the bar
node scripts/verify-step1.mjs     # 15  — outcome classification
node scripts/verify-steps23.mjs   # 22  — loop end-to-end (fake Cordis host)
node scripts/verify-live-host.mjs # 20  — real Cordis event bus + SQLite
node "D:/zcode/resources/glm/zcode.cjs" plugins validate dsh-immune-system
```

The acceptance scripts encode the product's intended behaviour. When one fails
after your change, treat it as **your regression until proven otherwise** — this
has already caught one "obvious improvement" (an identical-retry gate) that
silently broke the canonical episode shape.

## Where things live (change map)

| To change… | Edit | Pinned by |
| --- | --- | --- |
| Antibody storage / retrieval | `core/store/antibodies.ts`, `tokenize.ts` | `test/core.test.mjs` |
| Distillation prompt / parser | `core/prompts.ts` | parser tests |
| Generic-pitfall table | `core/lessons.ts` | merge-once test |
| Guard rules | `core/guards.ts` | fuzz + hook tests |
| ZCode hook behaviour | `zcode/src/hooks/*.ts` | `test/hooks.test.mjs` |
| CLI surface | `zcode/src/cli.ts` | smoke + `test/core.test.mjs` |
| DSH host contract | `dsh/src/dsh-adapter.ts` (ONLY file) | `test/dsh.test.mjs` pins event names to source lines |
| Native web tab | `dsh-immune-system/client/client.js` (hand-written, no bundler) | `test/dsh-ui.test.mjs` |
| Dashboard page | `core/ui/page.ts` | `test/ui.test.mjs` |
| MCP tools | `zcode/src/mcp-server.ts` | `test/mcp.test.mjs` (real stdio spawn) |

## Known limits (do not file these as bugs)

- ZCode's `SessionEnd`, `PreCompact`, `Notification`, `SubagentStop` do not
  exist — only seven events, see README.
- `UserPromptSubmit`/`Stop` matchers are inert in the current ZCode build (no
  match value is passed); never rely on one.
- SessionStart sources `clear`/`compact` are documented but not dispatched.
- External-LLM distillation is mock-tested only; no live endpoint call has been
  made (quota 402 during development).
- `IMMUNE_GUARD=warn` is ZCode-only: DSH's `PreToolDecision` has no context
  channel.

## When you finish a change

1. `npm run build && npm test`
2. All three acceptance scripts green
3. Bump the four manifests (same version everywhere)
4. Commit (message file + `git commit -F`), push
5. For a release: tag `v<version>`, `npm pack`, attach the tarball to a GitHub
   Release, update the installed copy:
   `node "D:/zcode/resources/glm/zcode.cjs" plugins marketplace update dev-dsh-plugin-immune && … plugins update dsh-immune-system@dev-dsh-plugin-immune`
