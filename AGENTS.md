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
   ZCode classifies in `zcode/src/outcome.ts`; DSH's `judgeOutcome` walks
   `isError` → sandbox denial → kill/timeout → structured `value.exitCode` →
   `[exit code: N]` trailer → `FAILURE_MARKERS`. The structured exit code is
   **authoritative** for shell tools: a passing command may print `Error:` /
   `command not found` in its own output (grep, test runners), so the text
   heuristics only apply to results that carry no structured status.

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

12. **A sandbox denial is reported, never learned.** When the failure is a
    file-access policy denial (`[sandbox: file access denied under … mode]`),
    `judgeOutcome` sets `sandboxDenied` and the adapter returns before
    `recordFailure`/`penalize`. It is a permission negotiation the host already
    explains with an escalation hint — distilling it can only restate the same
    command, and it must not penalise antibodies that were not what got refused.

13. **A structured payload is a verdict; text is only a fallback.** After the
    exit-status checks, a result that carries a non-empty `value` object but no
    exit status is treated as a success and its text is *not* scanned. Only
    tools that returned nothing structured are judged by `[exit code: N]` /
    `FAILURE_MARKERS`. Otherwise reading a log (or this repo's own docs) that
    contains `Error:` would be recorded as a failure and distilled into a bogus
    antibody.

14. **Both UIs are one design, and the budget is read through a getter.** The
    standalone dashboard (`core/ui/page.ts`) and the native web tab
    (`dsh-immune-system/client/client.js`) share the same KPI row (including the
    effective distill budget), tabs with counts, sort, status pills, skeleton and
    empty states. The tab injects ONE static `<style>` scoped under `.imm`
    (so hover/media-query/`--dsh-*` theme tokens work — do not regress to inline
    style objects), and the budget comes from a `getBudgetMs` getter passed into
    `registerImmuneUiRoute`, not from the env default, so a `/immune --budget`
    override is visible in the UI. The dashboard page must stay offline: no
    `http(s)://` anywhere (that is why the brand glyph and empty-state art are
    pure CSS, not inline SVG with `xmlns`). The tab renders **inside a shadow
    root** (`attachShadow({mode:'open'})` + `ReactDOM.createPortal`): the
    settings modal is an unknown host and its global stylesheet reshaped bare
    `table`/`td`/`div` in the live tab, collapsing every row and hiding the sort
    control (0.9.12). Shadow DOM seals both directions; only inherited
    properties cross, so `.imm` pins `line-height`, `font-family` and explicit
    `display` for table parts as a belt-and-braces fallback.

15. **The settings tab ships only if `client-modules` can discover it.** The web
    half is NOT a patch row. At activation `ClientModuleRegistry`
    (`packages/client/modules/src/index.ts`) scans the loaded Loader entries,
    resolves each entry name's `package.json`, and composes a bundle row only
    when the manifest sets `dsh.client.platform === "web"` AND
    `exports["./client"]` is a string. It then serves that file verbatim at
    `/plugins/<id>/client.js?rev=<hash>` and adds the row to
    `window.__DSH_BOOT__`. Without the declaration the file exists but 404s and
    the tab never renders — and the negative verdict is cached for the process,
    so only a restart shows the fix. `dsh.client.inject` lists module-graph
    edges, not services: `["@deepseek-ai/dsh-client-ui-settings"]` because that
    package owns the `settings.plugins.tab` slot. `test/manifests.test.mjs` and
    `scripts/verify-installed.mjs` pin the declaration, the export target, and
    the bundle's own registration face; `scripts/verify-client-serve.mjs`
    mounts the real `ClientModuleRegistry` and invokes its real route handler
    (10 assertions: row composed, url shaped, 200 + `text/javascript` + byte-
    identical body), so the check fails for exactly the reasons a host would.
    Because the negative verdict is cached for the process, `/immune` prints a
    `web tab registered | not registered | not loaded` field in its footer (read
    via `ctx.get('clientModules').clientPath(...)`) so the live answer is one
    command away, and the first module-graph flush logs `[immune] web tab:
    <state>` once at startup. Do not "verify" the tab with `curl
    /plugins/<id>/client.js`:
    the desktop port is an auth-gated gateway that 404s *every* plugin's bundle.

16. **A predicate must receive the value whose contract it encodes.** Match-time
    promotion fed `isPromotable` the PRE-bump hit count (4) while the predicate
    requires POST-bump (≥ 5): four is never five, so the feature never fired
    once in its life — and no test noticed because no test exercised it. When a
    feature is reachable only through a crossing (`=== 4`) plus a threshold
    (`>= 5`), the two must be derived from one constant, or a regression test
    must watch the feature's OUTPUT (a shared-library row), not its internals.

17. **A guard regex is tested against its own advice.** The force-push pattern
    denied `--force-with-lease` — the alternative its `instead` text recommends
    — because `\b` after `--force` matches inside the longer flag. Every guard
    pattern's false-positive matrix now includes exactly the commands its own
    `instead` line suggests (`--force(?!-)` is the fix shape).

18. **The injection delimiter is renderer-guaranteed on BOTH adapters.** Fields
    distilled from raw error traces may contain `</immune_memory>` or
    prompt-injection markup. The DSH side stripped `<>` from the start; the
    ZCode side did not until the framing-isolation audit caught it. Any new
    injection surface (a third adapter, a new block) must sanitize at render
    time — the database deliberately keeps the faithful text.

19. **Embeddings stay out; the fitness/dormant lifecycle stays deferred.** A
    local ONNX embedding reranker breaks the zero-dependency contract for a
    retrieval layer whose measured gap is small (recall bench at R@3 100%).
    An EMA-fitness + dormant state was prototyped on paper against the
    existing controls (relevance-base rerank, anti-rot retire at 3 fails,
    zombie aging) and deferred: it duplicates anti-rot's job with a third
    tunable whose failure mode — silently parking a good rule — is worse than
    an occasional weak injection. Revisit only if the value counter shows
    suppression outliving rule quality. Edit-before-read detection is
    deferred too: the host enforces Read-before-Edit deterministically
    (distilled as a normal episode), and Write-overwrite would need a
    per-session read set for one narrow case.

20. **Host tool-name casing is not a contract.** The DSH harness emits
    `bash`; ZCode emits `Bash`. `targetSignature` compared with `=== 'Bash'`,
    so on lowercase hosts every Bash call silently fell to the unknown-tool
    branch — probe detection never fired and pairing only worked by the
    accident of two consistent wrong signatures. Branch checks are
    case-insensitive now; the SIGNATURE casing stays verbatim so stored
    signatures keep matching their producers. The acceptance pin caught this
    on its first run — which is what the pins are for.

21. **Fabricated tool output is an adversarial class, and the shape of the
    deterministic path is the defense.** Tools like trustmebro demonstrate
    confusing agents with shimmed/fabricated results. The immune system's
    exposure is bounded three ways: a structured exit code outranks any body
    text (#13), the renderer owns the injection delimiter (#18), and the
    deterministic distiller can only produce echo-grade prescriptions from
    what actually ran — a poisoned result cannot author an arbitrary lesson
    (the promotion guards keep such rules local; the LLM path trusts its
    configured endpoint). Do not add a text-only state transition.

22. **Every guard pattern ships with its false-positive matrix.** `git clean`
    taught it twice in one week: the first regex missed `-fd` because it
    required the flag to END in f, and the real risk is deleting files the
    user forgot were untracked. Patterns are tested against flag permutations
    (`-fd`, `-xdf`, `--force`), the advice's own suggested commands, and the
    nearest legitimate lookalikes.

## Verification

```bash
npm test          # node:test; counts grow as coverage does — green is the bar
node scripts/verify-step1.mjs     # 15  — outcome classification
node scripts/verify-steps23.mjs   # 24  — loop end-to-end (fake Cordis host)
node scripts/verify-live-host.mjs # 20  — real Cordis event bus + SQLite
node scripts/bench-tool-latency.mjs  # cost lands at the turn boundary; also pins the drain curve and IMMUNE_DISTILL_BUDGET_MS
node scripts/bench-scale.mjs         # 300-rule library: index cost and match p50/p95; gates a pathological slowdown
node scripts/verify-client-serve.mjs # 10  — mounts the real ClientModuleRegistry and serves /plugins/<id>/client.js
node scripts/verify-llm.mjs          # env-gated, SKIPs without LLM env; one command to live-verify external distillation
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
- External-LLM distillation: the parsing/fallback logic is mock-tested, and the
  live legs verified in isolation (URL validation accepts public endpoints,
  `chat()` surfaces upstream errors cleanly, `distillEpisode` degrades to the
  rule path in ~1 s when the endpoint is down). Only the "real model returns
  good JSON and we parse it" leg is still unverified live — every free channel
  was down when tried; `node scripts/verify-llm.mjs` with LLM env vars closes
  it in one command when a channel is available.
- `IMMUNE_GUARD=warn` is ZCode-only: DSH's `PreToolDecision` has no context
  channel.
- GitHub push protection scans test fixtures too: a redaction-fixture token
  shaped like the real thing (Slack's digit-group `xoxp-…`) is blocked from
  being pushed. Write fixtures with letter-only groups; our own regexes accept
  them and the scanner does not.

## When you finish a change

1. `npm run build && npm test`
2. All three acceptance scripts green
3. `node scripts/bench-tool-latency.mjs` PASS (adds ~40 s; proves the drain
   budget curve and that the tool path stays free of the model)
4. `node scripts/bench-recall.mjs` PASS (fast; the retrieval gate — R@3 and
   the false-positive rate over a fixed zh/en scenario matrix, borrowed from
   deja-vu's habit of publishing recall numbers)
5. Bump the four manifests (same version everywhere)
6. Commit (message file + `git commit -F`), push
7. For a release: tag `v<version>`, `npm pack`, attach the tarball to a GitHub
   Release, update the installed copy:
   `node "D:/zcode/resources/glm/zcode.cjs" plugins marketplace update dev-dsh-plugin-immune && … plugins update dsh-immune-system@dev-dsh-plugin-immune`
