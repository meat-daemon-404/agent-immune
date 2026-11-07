# dsh-plugin-immune

<p align="center"><b>Your coding agents stop re-debugging what you already fixed.</b></p>

[![npm](https://img.shields.io/npm/v/dsh-immune-system)](https://www.npmjs.com/package/dsh-immune-system)
[![ci](https://github.com/meat-daemon-404/dsh-plugin-immune/actions/workflows/ci.yml/badge.svg)](https://github.com/meat-daemon-404/dsh-plugin-immune/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A522.5-blue)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin%20hub-4f9cf9)](https://dsh-plugin.org/plugins)

**English** | [简体中文](README.zh-CN.md)

Agent steps on a rake, fixes it, and the lesson is captured as an *antibody* —
no docs required. Next session the relevant antibodies are injected before the
mistake can repeat.

Works on two hosts that share one `core/`: **DSH** (DeepSeek Harness, verified
against the real host contract) and **ZCode** (verified against its hooks).
Same npm package, one pitfall paid once, immune everywhere.

![demo](docs/hero.svg)

**Try it in 30 seconds — no install, no host, nothing persisted:**

```bash
npx dsh-immune-system@latest demo
```

The command runs the real pipeline: distils a fresh failure→success episode,
recalls it from a paraphrase prompt, and renders the exact `<immune_memory>`
block the hooks inject. In-memory only.

---

### What it does

Repeating the same mistake is the most expensive pattern an agent has. Static docs
do not fix it — nobody maintains them, and they rot. This plugin turns the failure
scene itself into a rule.

Works on two hosts that share one `core/`: **DSH** (DeepSeek Harness, verified
against the real host contract) and **ZCode** (verified against its hooks).

### How it compares

|  | dsh-plugin-immune | [deja-vu](https://github.com/vshulcz/deja-vu) | [mem0](https://github.com/mem0ai/mem0) | [claude-memory-compiler](https://github.com/nicobailon/claude-memory-compiler) |
| --- | --- | --- | --- | --- |
| What it keeps | failure→success episodes, distilled into actionable rules | full session transcripts, indexed for search | conversation facts | compiled skill files |
| Delivery | **injected before the repeat** via host hooks | on-demand search (MCP/TUI) | SDK/app-level recall | skill file the model must read |
| Dependencies | zero (node:sqlite FTS5) | one Go binary | Python + store | node |
| Hosts | DSH + ZCode hooks (npm install) | Claude Code, Codex, Cursor, 36+ | any via SDK | Claude Code |
| Quality gate | recall + scale benches in CI | published benchmarks | — | — |

Honest positioning: deja-vu indexes *everything you did* and searches it;
this plugin keeps only the lessons and *injects* them. Complementary, not
competing.

### Quality, measured

The retrieval layer is gated, not claimed: a fixed zh/en scenario matrix
(8 paraphrase positives, 6 gram-clean negatives) currently scores
**R@1 100% / R@3 100% / FP 0%**, and the gate (R@3 ≥ 7/8, FP ≤ 1/6) runs in CI
on every push. Measured at scale (`scripts/bench-scale.mjs`): **300 rules
index in 41 ms (0.14 ms/rule), 67 matches at p50 0.37 ms / p95 0.66 ms** —
retrieval stays sub-millisecond with hundreds of rules.
`scripts/bench-tool-latency.mjs` pins the drain cost curve (the
tool path never touches the model), and `scripts/verify-llm.mjs` live-verifies
external distillation in one command when an LLM endpoint is configured.

### Install

**Try it first** — the 30-second quickstart, no install, in-memory only:

```bash
npx dsh-immune-system@latest demo
```

**npm** — published as [`dsh-immune-system`](https://www.npmjs.com/package/dsh-immune-system),
prebuilt, no toolchain needed:

```bash
dsh plugin --profile <profile> add dsh-immune-system
```

**tarball / git** (equivalent, no npm account required):

```bash
cd dsh-immune-system && npm pack
dsh plugin --profile <profile> add ./dsh-immune-system-<version>.tgz
dsh plugin --profile <profile> add github:meat-daemon-404/dsh-plugin-immune
```

`git:` installs build at install time via `prepare`, which pnpm blocks until
allowlisted — see the Chinese section above for the exact fix. Prefer npm or the
tarball.

**Restart DSH** afterwards — bundles are composed at startup.

**ZCode** — this repository *is* a marketplace source:

```bash
node "<zcode.cjs>" plugins marketplace add meat-daemon-404/dsh-plugin-immune
node "<zcode.cjs>" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

Start a **new task** afterwards; old tasks keep their earlier capability catalog.

### Design notes

**Sensing outcomes, not trusting one event.** On both hosts a shell command
exiting non-zero is *not* an error result: ZCode's `PostToolUseFailure` only fires
when a handler throws, and DSH documents that "non-zero exits are reported, not
errored" — `isError` covers infrastructure failures only. Both ports therefore
classify the result themselves (exit code, trailing `[exit code: N]` /
`[killed by signal: X]` / timed-out markers, and a narrow marker regex). A
structured `value` is authoritative: a non-zero exit code is a failure and a
zero one is a success even if the output mentions `Error:`; a payload object with
no exit status is a success and is not text-scanned at all.

**Anti-rot, relevance-guarded.** An injected antibody that still did not prevent
the failure loses credit and is retired after three such episodes. The penalty is
relevance-guarded: the failure must share a meaningful term with the antibody's
trigger, and the tool name is excluded — otherwise every `Bash …` rule would be
blamed for any Bash failure.

**Injection hygiene.** Injected text comes only from our own distilled fields,
never raw tool output; brackets are stripped so a line cannot close its wrapper
tag; length-capped; labelled advisory.

**Distillation cost sits at the turn boundary.** Jobs are queued during tool
use and drained once at turn end under `IMMUNE_DISTILL_BUDGET_MS` (default
12 s). Measured with a slow mock model (`scripts/bench-tool-latency.mjs`):
`tools/post-execute` stays ~1 ms median, while `agent/turn-stopping` pays one
round trip per queued job (~1.5 s each at 1500 ms/call) and defers whatever the
budget cannot fit to the next boundary. With a model configured the drain now
**batches four episodes per request**, so a backlog fits in one budget window
instead of four.

**Failure judgement — four layers.** A tool result is classified in this order,
and the first layer that yields a verdict wins:

| # | Signal | Verdict |
| --- | --- | --- |
| 1 | structured `value.exitCode` | non-zero = failure, zero = success — authoritative, output text is not scanned |
| 2 | `isError` / `error` payload | failure, and its message becomes the symptom |
| 3 | trailing markers (`[exit code: N]`, `[killed by signal: X]`, timed out) | failure when N≠0 |
| 4 | narrow marker regex over the body (`ENOENT`, `npm ERR!`, `Cannot find module`, …) | failure; a healthy log that merely mentions "error" does not match |

**Repeat suppression.** Asking three questions in a row about the same file
would otherwise inject the identical block three times and count three hits.
When the candidate set is unchanged and fewer than four turns have passed, the
injection is skipped and `hit_count` is left alone — that counter drives
promotion and anti-rot, so inflating it would corrupt the library's own
statistics. `resume` / `clear` / `compact` reset the state.

**Target-scoped pairing.** A failure only pairs with a success that is the
*same kind of work*: same file for file tools, same program family for commands
(`npm`/`npx`/`pnpm` are one family — a build failing under `npm` and passing
under `npx` is the same task's fix; `npm …` then `git …` is not). Read-only
probes (`ls`, `pwd`, `cat`, `git status`, `git log`, `git diff`, `which`, …)
never close an episode: they cannot have fixed anything, and they sit between
an error and its real fix constantly.

**Jaccard near-duplicate merge.** Before inserting, prescriptions within the
same trigger are compared with character-3-gram Jaccard (blended with a
character-set Jaccard for short CJK sentences, where inserting one character
shifts every trigram). At ≥0.70 the rule merges into the existing row and its
hit count increments; a human correction or a model rewrite then overwrites the
stored wording, because it outranks whatever was there.

**Path-affinity rerank.** Retrieval fetches twice the requested limit, then
re-ranks in memory: ×1.5 when the trigger names a file or directory the prompt
mentions, ×0.85 for shared-library rules (project rules always win ties), and a
time decay of `1 / (1 + 0.02 × days)` so a rule nobody has needed for a year
does not outrank a fresh one.

### Dashboard

`cli.js ui` serves a local page at `http://127.0.0.1:7788/`: search, retire /
restore / delete, project and shared tabs, live counts. Browsing is a
read-only path — it never counts as an injection.

Boundaries are deliberately narrow: binds `127.0.0.1` only, a random per-run
token is required on every `/api` call (a cross-origin simple POST needs no
preflight, so Origin checking alone would not do), strict CSP, and the page
loads nothing external.

### Native UI (dsh.client)

The DSH web app gets a real settings tab instead of a separate page. The client
is `dsh-immune-system/client/client.js`, hand-written against the module-loader
contract (`window.__ModuleLoader__.load({ id, factory })`) — no bundler, no JSX,
no new dependency. Data comes from a host route registered as an *optional*
`webServer` dependency, so CLI and desktop profiles still work without it.
Mutations require same-origin JSON, which forces a CORS preflight.

### Sync & Doctor

Library snapshots are plain tagged JSON, and merging is conservative:
prescription is the identity, tallies take the MAX (two machines count
independently and must not multiply), status is active when either side says
so, and malformed rows are counted invalid rather than aborting the import.

```bash
node "<plugin>/dist/zcode/src/cli.js" export-json library.json
node "<plugin>/dist/zcode/src/cli.js" import-json library.json
node "<plugin>/dist/zcode/src/cli.js" doctor
```

`doctor` reports node version, an FTS5 trigram probe, database and shared-library
readability, the plugin marker, the MCP script, the native-UI contract
(`dsh.client` + `exports["./client"]` + a loader-registered bundle) and counts.
Any failure exits non-zero, so it can gate a script.

### Guard (IMMUNE_GUARD)

Advisory text can be dropped by a model in a long turn, so a short curated list
of calls that are wrong in essentially every environment also gets a
deterministic pre-execution check: force-push to main, `rm -rf /`,
`git reset --hard`.

```bash
IMMUNE_GUARD=off   # default: no check
IMMUNE_GUARD=warn  # louder advisory (ZCode only)
IMMUNE_GUARD=deny  # refuse the call (both hosts)
```

Patterns live in code, never in the database: a distilled rule is model output,
and compiling it into a regex that can block tool calls would hand an
unreviewed string the power to stop work, plus ReDoS risk. `deny` is never the
default. `warn` is ZCode-only because DSH's `PreToolDecision` carries no
context channel.

### Storage & retention

The library is a single SQLite file (FTS5 trigram index; Chinese matches via
3-character windows).

- `IMMUNE_DB_PATH` wins when set; pointing both editions at the same file
  shares the library.
- DSH default: `<DSH_HOME>/storages/dsh-immune-system/<sha1(cwd)[0..16]>.sqlite`
  — per-project isolation, nothing written into the project itself.
- ZCode default: the plugin data dir (`ZCODE_PLUGIN_DATA`), else
  `<project>/.dsh/immune.sqlite`.

**It cannot grow without bound**: on every episode pairing, `pruneStale`
reclaims pending state after 30 minutes, terminal distill jobs
(done/failed/skipped) and dead session rows after a 7-day window
(pending/running work untouched). `immune doctor`'s storage row shows the row
counts and the file size. Everything is redacted before it reaches disk:
Authorization/Bearer headers, `KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=` assignments,
`sk-`, `ghp_`, `AKIA`, npm granular tokens, GitHub fine-grained PATs, GitLab
PATs, Google `AIza` keys, Slack tokens, Stripe live keys, inline URL
credentials and JWTs — placeholders in, database out.

### Layout

```
core/                  shared, host-agnostic, zero runtime deps
  ├── store/           SQLite + FTS5 trigram: antibodies, episodes, job queue
  ├── distiller.ts     episode -> antibody (LLM, rule-based fallback)
  ├── i18n.ts          zh/en strings
  ├── redact.ts        credential scrubbing before disk
  └── export.ts        render SKILL.md
dsh/                   DSH adapter — verified against the real host contract
dsh-immune-system/     installable bundle (manifest, patch, commands, dist)
zcode/                 ZCode adapter (hooks, CLI)
docs/                  dsh-host-contract.md — every contract claim with file:line
scripts/               the five verification & benchmark scripts above
test/                  node:test
```

Point both hosts at the same `IMMUNE_DB_PATH` and they share one antibody store.

### The first sketch vs. what the host actually does

The original design guessed a Cordis-style API. Reading the DSH source disproved
every one of those guesses:

| First sketch | What DSH actually has |
| --- | --- |
| `dsh/before-llm-request` event | no such event; recall rides `agent/pre-step` (waterfall) and `agent.inject()` |
| `dsh/after-tool-call` event | no such event; results arrive on `tools/post-execute` (waterfall) |
| success / failure as two events | one event plus `isError`, and `isError` is infrastructure-only |
| `session.appendSystemReminder()` | does not exist; use `agent.inject(createUserMessage(...))` |
| `ctx.command(name, desc, handler)` | `ctx.commands.register({ name, description, handler })`, needs `inject=['commands']`, returns a `CommandResult` |
| `agent/request` to add context | explicitly forbidden — "this waterfall cannot mutate messages" |

Every row above is sourced to a file and line in
[docs/dsh-host-contract.md](docs/dsh-host-contract.md).

See also [dsh/README.md](dsh/README.md) for the DSH-side operational details.
