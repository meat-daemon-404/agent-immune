# dsh-plugin-immune

Self-evolving **pitfall immunity** for coding agents.

The agent steps on a rake, fixes it, and — without anyone writing docs — the
lesson is captured as an *antibody*. Next session, before the agent can make the
same mistake, the relevant antibodies are injected into its context.

```
 tool fails ─┐
             ├─► pair ─► distil ─► antibody (SQLite + FTS5)
 tool works ─┘                            │
                                          ▼
     next tool call ─► PreToolUse warning (just in time)
     next prompt    ─► <immune_memory> block
```

## Repository layout

```
dsh-plugin-immune/
├── core/                  shared, host-agnostic, zero runtime dependencies
│   ├── store/             SQLite + FTS5: antibodies, episodes, job queue
│   ├── distiller.ts       episode → antibody (model + deterministic fallback)
│   ├── prompts.ts         distillation prompt and strict output parser
│   ├── llm.ts             OpenAI-compatible client with endpoint validation
│   ├── redact.ts          credential scrubbing before anything hits disk
│   └── export.ts          proven antibodies → SKILL.md
├── zcode/                 ZCode adapter source (hooks, CLI)
├── dsh/                   DSH adapter — SKELETON, contract unverified
├── dsh-immune-system/     installable plugin (manifest, hooks.json, commands, dist)
├── test/                  node:test suites
└── marketplace.json       local dev marketplace catalog
```

Both adapters call the same `core/`. Point them at the same database and they
share one antibody library.

## Why this does not look like the original sketch

The initial design assumed a Cordis-style API (`ctx.on('dsh/before-llm-request')`,
`ctx.llm.complete`, `ctx.command`, `async: true` background distillation). None
of that matches the ZCode runtime that actually exists on this machine, so the
ZCode adapter is built against the real contract:

| Sketch | Reality (verified locally) |
| --- | --- |
| `dsh/before-llm-request` | No such event. Context is injected from `UserPromptSubmit` / `SessionStart` via `hookSpecificOutput.additionalContext`. |
| `after-tool-call` + `is_error` | Success and failure are **separate events**: `PostToolUse` and `PostToolUseFailure`. There is no `is_error` field. |
| `ctx.llm.complete()` | Hooks are standalone processes with no host LLM handle. Uses an HTTP client configured by env vars instead. |
| `ctx.command('immune')` | Commands are Markdown prompts. They call a small CLI. || `async: true` runs in background | The hooks guide is explicit: `async` has **no runtime effect**. Work is queued and drained at `Stop`, which is both correct and cheaper than daemonising. |
| in-memory `Map` for recent failures | Each hook is its own process. All cross-event state is persisted in SQLite. |
| (not in the sketch) | `PreToolUse` exists and is the best injection point: it sees the exact tool arguments before the call runs. |

Only seven hook events exist: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`.

## Install

Installed on this machine from the local dev marketplace:

```
marketplace : dev-dsh-plugin-immune
plugin      : dsh-immune-system@dev-dsh-plugin-immune  (0.1.2)
installed   : C:\Users\33352\.zcode\cli\plugins\cache\dev-dsh-plugin-immune\dsh-immune-system\0.1.2
database    : C:\Users\33352\.zcode\cli\plugins\data\dsh-immune-system@dev-dsh-plugin-immune\immune.sqlite
```

CLI equivalent (no UI needed):

```bash
node "D:\zcode\resources\glm\zcode.cjs" plugins marketplace add "D:\Project\dsh-plugin-immune"
node "D:\zcode\resources\glm\zcode.cjs" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

To iterate: bump the version in **both** `.zcode-plugin/plugin.json` and
`marketplace.json`, rebuild, then `plugins marketplace update` followed by
`plugins update dsh-immune-system@dev-dsh-plugin-immune`. The CLI reports
"already up to date" if the version did not change, so the bump is required.

Restart ZCode (or start a new task) after an update — source edits are not hot
reload.

### Try it

Ask the agent something that fails first and then works — for example a command
with a wrong flag, then the corrected one. Then in a **new** task ask something
containing the same file or command name. Expected: an `<immune_memory>` block
with the distilled rule, and no repeat of the mistake.

Run `/dsh-immune-system:immune` to list what has been learned.

## Configuration

All optional. With none set, the deterministic rule-based distiller is used and
everything works offline.

| Variable | Purpose |
| --- | --- |
| `IMMUNE_DB_PATH` | Database file. Defaults to the plugin data dir, else `<project>/.dsh/immune.sqlite`. |
| `IMMUNE_LLM_BASE_URL` | OpenAI-compatible base URL, e.g. `https://api.example.com/v1`. |
| `IMMUNE_LLM_MODEL` | Model name. Required together with the base URL. |
| `IMMUNE_LLM_API_KEY` | Bearer token. |
| `IMMUNE_LLM_TIMEOUT_MS` | Per-call timeout (default 20000). |
| `IMMUNE_DISTILL_BUDGET_MS` | Wall-clock budget for one drain (default 12000). |
| `IMMUNE_ALLOW_PRIVATE_ENDPOINT` | Set to `1` to permit a loopback/private model endpoint. **Off by default**: the endpoint validator refuses loopback, private, link-local, CGNAT and reserved addresses to block SSRF-style config poisoning. Local inference servers need this flag. |

## Commands

| Command | Does |
| --- | --- |
| `/dsh-immune-system:immune` | List antibodies with hit/fail counts. `--all` includes retired ones. |
| `/dsh-immune-system:immune-export` | Write proven antibodies (`hits >= 3`) to `.dsh/skills/project-pitfalls/SKILL.md`. |

## Design notes

**Sensing outcomes, not trusting one event.** `PostToolUseFailure` is dispatched
only when a tool *handler throws*. A shell command exiting non-zero usually
returns normally, so that event alone misses exactly the failures this plugin
exists to learn from. `PostToolUse` therefore classifies its own result
(`exitCode`, `is_error`, or narrow output markers) and both paths converge on the
same episode recorder. The marker list is deliberately narrow — a healthy build
log can contain the word "error", and a false positive would record a good call
as a pitfall.

**Anti-rot, relevance-guarded.** An antibody that was injected and still did not
prevent the failure loses credit, and at three such episodes it is retired and
re-distilled with the new evidence. Crucially, the penalty only applies when the
failure actually shares a meaningful term with the antibody's trigger: the tool
name is excluded, because every trigger starts with "Bash" or "Edit" and would
otherwise mark everything as related. Without that guard an unrelated failing
command would retire a good rule.

**Just-in-time warning.** Prompt-time matching is a guess about intent.
`PreToolUse` is knowledge: it sees the exact command or file about to be touched.
That hook searches on the arguments only — including the tool name would make
every `Bash …` antibody match every Bash call — and injects at most two rules
right before the call runs.

**Redaction.** Traces are scrubbed for bearer tokens, key/value secrets,
provider-shaped keys, credentials in URLs and JWTs before they are stored —
these records can later be exported into a shared skill, so leaking there would
be worse than leaking in a log.

**Prompt-injection hygiene.** Injected text is our own distilled fields only,
never raw tool output; angle brackets are stripped so antibody text cannot close
the wrapper tag; the block is capped, and it is labelled advisory so the model
does not treat it as an instruction from the user.

**Failure is never fatal.** Hooks always exit 0, malformed stdin is ignored, a
bad FTS expression returns no matches, and an unreachable model falls back to
the deterministic distiller. A broken plugin must not break a session.

## Verification status

Run `npm test` (16 tests).

Live verification inside the real runtime:

- the plugin is installed and the runtime dispatches **all five** hooks —
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` —
  confirmed with `IMMUNE_DEBUG_LOG`; `${ZCODE_PLUGIN_ROOT}` expands to the install
  cache path, and the database lands in the plugin data directory;
- `PreToolUse` is visible in the runtime log as
  `plugin.dsh-immune-system@dev-dsh-plugin-immune.PreToolUse.4.0`;
- the full loop was replayed against the **installed** copy and a new session
  received the `<immune_memory>` block.

Covered by tests:
- Chinese and English retrieval through FTS5 `trigram` (long CJK phrases are
  expanded into overlapping trigrams, otherwise they would never match);
- failure/success pairing, including that one failure pairs exactly once;
- injection bookkeeping and three-strike retirement;
- **relevance-guarded penalties**: a related failure costs credit, an unrelated
  one does not;
- **just-in-time `PreToolUse` warning**, and that a bare `ls` does not trip every
  `Bash` antibody;
- **outcome classification**: a non-zero exit code counts as failure, and a
  healthy log containing the word "error" does not;
- `SKILL.md` export gating;
- credential redaction;
- SQL injection resistance (bound parameters only);
- **the full loop across real, separate hook processes**, ending with a
  different session receiving the antibody;
- strict stdout shape (no extra keys) and clean exit on malformed stdin.

Not covered — pending:
- an agent-driven end-to-end run (the model quota returned **402** during
  verification, so a live turn could not reach the tool stage; the same loop was
  replayed by feeding the installed hooks their real event payloads instead);
- model-backed distillation (needs `IMMUNE_LLM_*` configured);
- the DSH adapter (see `dsh/README.md`).

The manifest passes the bundled validator (`zcode plugins validate`).
