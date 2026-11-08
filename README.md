<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo-light.svg" alt="dsh-immune — self-evolving pitfall immunity" width="360">
  </picture>

  <p><b>Your coding agents stop re-debugging what they already fixed.</b></p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-immune-system"><img src="https://img.shields.io/npm/v/dsh-immune-system" alt="npm version"></a>
    <a href="https://github.com/meat-daemon-404/dsh-plugin-immune/actions/workflows/ci.yml"><img src="https://github.com/meat-daemon-404/dsh-plugin-immune/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/coverage-82.6%25-4c9f4c" alt="coverage 82.6%">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
    <img src="https://img.shields.io/badge/node-%E2%89%A522.5-blue" alt="node ≥22.5">
    <a href="https://dsh-plugin.org/plugins/meat-daemon-404/dsh-plugin-immune"><img src="https://dsh-plugin.org/badges/listed.svg" alt="Listed on DSH Plugin Hub"></a>
  </p>

  <p><b>English</b> | <a href="README.zh-CN.md">简体中文</a></p>
</div>

When a tool call fails and the next attempt fixes it, the plugin saves that pair as a rule. Rules that match the current work get injected into context on later runs, before the agent repeats the same mistake.

One `core/` engine, two hosts, one npm package: **DSH** (DeepSeek Harness, checked against the real host contract) and **ZCode** (checked against its hook lifecycle).

<div align="center">
  <img src="docs/hero.svg" alt="immune demo: distill, recall, inject" width="720">
</div>

### Quick demo

Runs the whole pipeline in memory, installs nothing, writes nothing:

```bash
npx dsh-immune-system@latest demo
```

It distills a failure→success episode, recalls it from a paraphrased prompt, and prints the `<immune_memory>` block the hooks inject.

### Install

**DSH** — from npm (prebuilt, no toolchain):

```bash
dsh plugin --profile <profile> add dsh-immune-system
```

Same package from a tarball or from git:

```bash
cd dsh-immune-system && npm pack        # prints the exact dsh-immune-system-<version>.tgz it wrote
dsh plugin --profile <profile> add ./dsh-immune-system-<version>.tgz
dsh plugin --profile <profile> add github:meat-daemon-404/dsh-plugin-immune
```

The `github:` form builds at install time through `prepare`, which pnpm blocks until it is allowlisted (the Chinese README has the exact setting). npm or the tarball sidesteps that.

Restart DSH afterwards; plugin bundles are composed at startup.

**ZCode** — this repository is itself a marketplace source:

```bash
node "<zcode.cjs>" plugins marketplace add meat-daemon-404/dsh-plugin-immune
node "<zcode.cjs>" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

Start a new task afterwards; existing tasks keep the capability catalog they started with.

### After installing: what you should see

Run the self-check first; it is the same command support will ask you for:

```bash
immune doctor
# ZCode, when the slash command is not wired yet:
node "<plugin root>/dist/zcode/src/cli.js" doctor
```

Eight checks: Node ≥ 22.5, an FTS5 trigram probe (plus the two-character-CJK fallback), both databases readable, the marker file, the MCP script, the native-UI contract, and the counters. Non-zero exit means the next session will be missing something.

Then, plainly, what is proven and what is not:

* **Hooks** — verified against the real DSH event bus and the real ZCode hook lifecycle (`scripts/verify-live-host.mjs`, `scripts/verify-client-serve.mjs`).
* **The ZCode settings tab** — mounted and serving `/plugins/<id>/client.js`; it has not been driven end-to-end in a browser here. If it does not appear, the data is still reachable through `immune list` and `immune ui`.
* **External LLM distillation** — works against one real OpenAI-compatible endpoint (SenseNova). Other providers share the code path but are untested. Without `IMMUNE_LLM_BASE_URL` and `IMMUNE_LLM_MODEL` the deterministic rule path runs and the model counters stay at zero. `node scripts/verify-llm.mjs` is the one-command check when you have an endpoint.
* **`IMMUNE_GUARD=warn` is ZCode-only.** On DSH a configured guard still **denies**: the host contract offers allow/deny/ask with no advisory mode. Keep `IMMUNE_GUARD=off` (the default) if you do not want denial.

### Sharing what it learned

```bash
immune export 5                     # SKILL.md, only rules injected at least 5 times
immune export 3 ./docs/pitfalls.md  # choose the path
```

```markdown
---
name: project-pitfalls
description: Pitfalls this project already paid for once … 11 proven rules.
---

| 触发 / Trigger | 错误直觉 / Wrong instinct | 正确做法 / Do this instead | 命中 / Hits |
| --- | --- | --- | --- |
| Edit old_string-not-found 精确匹配 | old_string 与文件实际内容不一致 | Edit: 重新 Read 后精确复制待替换文本 | 234 |
| EPERM mkdir 只读目录 模型测试 | 在只读目录建 .dsh 或文件报 EPERM | 换可写工作目录，或用 IMMUNE_DB_PATH 显式指定库路径 | 37 |
| … | … | … | … |
```

The dashboard's `/api/export?format=json` produces a snapshot that `immune import` reads back, so a team can start from one person's proven rules.

### Syncing into AGENTS.md / CLAUDE.md

Agents that do not run these hooks still read the project docs, so learned rules can be exported into them:

```bash
immune sync-doc                        # AGENTS.md, or CLAUDE.md when that is the convention
immune sync-doc --out CLAUDE.md --min-hits 5
```

Rules land between `<!-- immune:generated -->` markers. Everything outside them is left alone, angle brackets inside rules are stripped, and re-running rewrites the block instead of appending.

To do that automatically after each turn's distillation:

* `IMMUNE_SYNC_DOC=AGENTS.md` (or `1` for the default target)
* `IMMUNE_SYNC_DOC_MIN_HITS=3` (rules below this hit count are not exported)

### Benchmarks and CI

Every push runs the retrieval gate and unit suite on Node 22 and 24:

* **Test suite** — `npm test` runs **138 tests**, 0 failures. `scripts/verify-*.mjs` add 15 + 24 + 20 host-level assertions, and `verify-installed.mjs` adds 22 against your installed profile. Those are the numbers you can reproduce locally.
* **Recall** — fixed zh/en matrix with 8 paraphrased positives and 6 gram-clean negatives. Current: R@1 100%, R@3 100%, FP 0%. CI fails below R@3 7/8 or above FP 1/6.
* **Index and query speed** (`scripts/bench-scale.mjs`) — 300 rules index in 41 ms (0.14 ms/rule); 67 matches run at p50 0.38 ms, p95 0.75 ms.
* **Hook latency** (`scripts/bench-tool-latency.mjs`) — the tool path never calls a model; distillation is paid at the turn boundary.
* **Live LLM check** (`scripts/verify-llm.mjs`) — one command against a configured endpoint, when there is one.

### Comparison

|  | dsh-plugin-immune | [deja-vu](https://github.com/vshulcz/deja-vu) | [mem0](https://github.com/mem0ai/mem0) | [claude-memory-compiler](https://github.com/nicobailon/claude-memory-compiler) |
| --- | --- | --- | --- | --- |
| Keeps | failure→success pairs distilled into rules | full session transcripts | conversation facts | compiled skill files |
| Delivery | injected before the repeat, via hooks | search on demand (MCP/TUI) | SDK-level recall | skill file, read by the model |
| Dependencies | none (`node:sqlite` FTS5) | one Go binary | Python + store | Node |
| Hosts | DSH, ZCode | Claude Code, Codex, Cursor, 36+ | any via SDK | Claude Code |

Different jobs, mostly: deja-vu indexes everything you did and searches it; this keeps the lessons and pushes them in unasked.

### Design notes

**Outcome detection.** A non-zero exit is not an error result on either host: ZCode only fires `PostToolUseFailure` when a handler throws, and DSH reports non-zero exits rather than flagging them. Both adapters therefore classify the result themselves, in this order: structured `value.exitCode`; `isError` or an `error` payload; a trailing `[exit code: N]` / `[killed by signal: X]` / timeout marker; and a narrow marker regex. A structured payload with no exit status counts as success and its text is not scanned, so reading a log that mentions `Error:` stays a success.

**Pairing.** A failure only pairs with a success that is the same kind of work: same file for file tools, same program family for commands (`npm`, `npx`, `pnpm` are one family; `npm …` then `git …` is not). Read-only probes — `ls`, `cat`, `git status`, `git diff`, `which` — never close an episode, because they cannot have fixed anything.

**Merging and decay.** Prescriptions are compared with character-3-gram Jaccard (blended with a character-set score for short CJK sentences, where one inserted character shifts every trigram). At ≥0.70 the rule merges into the existing row, and its trigger tokens are unioned so each rewording widens recall. An injected rule that still fails three times is retired; the penalty is relevance-guarded so a `Bash …` rule is not blamed for an unrelated Bash failure.

**Retrieval.** FTS5 trigram for 3+ characters, plus a bound LIKE pass for two-character Chinese words that trigram cannot index. Candidates are re-ranked with ×1.5 for a path the prompt mentions, ×0.85 for shared-library rules, and a `1 / (1 + 0.02 × days)` decay.

**Injection and cost.** Injected text comes only from distilled fields, brackets stripped so a line cannot close the wrapper tag, capped in length and labelled advisory. The same candidate set is not re-injected within four turns, and skipped turns do not count as hits. Distillation is queued during tool use and drained at turn end under `IMMUNE_DISTILL_BUDGET_MS` (12 s default, batched four episodes per request).

For the full list of decisions and the ones that were tried and reverted, read [AGENTS.md](AGENTS.md).
