# agent-immune Long-Term Roadmap (v1.1 → v3.0)

> Single source of truth for feature evolution in `meat-daemon-404/agent-immune`
> (npm: `dsh-immune-system`). Every milestone must satisfy all invariants in
> `AGENTS.md` (zero runtime dependencies, Node >=22.19 `node:sqlite`, Decision
> #34 clean-export integrity, Decision #37 single npm name `dsh-immune-system`,
> and the `bench-recall.mjs` gate: **R@3 >= threshold** over the fixed zh/en
> matrix — R@1 is reported, not gated).
>
> Tests are **node:test** (`npm test`). Distillation is deterministic-first;
> anything that writes advice text needs model evidence (Decision #28) or
> repair evidence (Decision #24).

## Phase 1: v1.1 — Causal Repair Chains, Self-Healing & Full Host Parity

- [x] **1.4a Cross-Session Pairing** — shipped in 1.0.57 (AGENTS.md #38):
      `claimFailure` closes the newest same-tool pending failure of any other
      session in the same project database, bounded by `PENDING_TTL_MS`.
- [x] **1.1 Real Claude Code JSONL Audit Parity (`core/audit.ts`)**
  - **Target**: Parse real `~/.claude/projects/**/*.jsonl` transcripts
    (including nested `subagents/` directories, `tool_use` + `tool_result`
    with `is_error: true`, and multi-turn exit codes) with the same fidelity
    as ZCode and Codex logs.
  - **Acceptance**: Unit + fixture tests covering real Claude Code JSONL
    schemas; `audit --dry-run` succeeds cleanly on real `~/.claude/projects/`
    logs without throwing or returning false zeros.
- [x] **1.2 Zero-Arg Auto-Detect `connect` & Native `.claude-plugin/` Manifest**
  - **Target**: `npx dsh-immune-system connect` with no host argument detects
    installed `~/.claude`, `~/.codex`, ZCode, and DSH environments and wires
    all detected hosts idempotently; `.claude-plugin/plugin.json` and
    `marketplace.json` at repo root for native Claude Code plugin installs.
  - **Acceptance**: Temp-HOME integration tests verifying multi-host
    auto-detection, idempotent re-runs, `--remove` cleanup.
- [x] **1.3 Multi-Step Causal Repair Chain (`core/pairing.ts`,
      `core/store/turn-state.ts`, `core/lessons.ts`)**
  - **Target**: Track up to 3 intermediate non-probe file edits
    (`Edit`/`Write` paths + concise summary) between a failed command and a
    subsequent successful retry of the same program family; pass
    `{ failedCall, repairChain, fixedCall }` into `lessons.ts` so distilled
    prescriptions include the prerequisite file/config fix.
  - **Acceptance**: Tests proving `pytest` fail -> `Edit` config -> `pytest`
    pass produces a prescription referencing the edited file rather than only
    repeating `pytest`.
- [x] **1.4b User-Correction Pairing (`core/pairing.ts`)** — the cross-session
      half of 1.4 shipped in 1.0.57; this is the remaining half.
  - **Target**: Close open failure episodes when the user corrects the agent
    in `UserPromptSubmit` and a subsequent same-family tool call succeeds
    (`origin: 'user_correction'`).
  - **Acceptance**: Simulated multi-turn transcript tests closing single-step
    failures that previously surfaced as coverage blindspots.
- [x] **1.5 Active Stuck-Detection & Diagnostic Hypothesis
      (`core/store/turn-state.ts`, `zcode/src/format.ts`)**
  - **Target**: When the same command family or target file fails >= 2
    consecutive times with no matching antibody, inject a concise structured
    diagnostic prompt before the 3rd attempt (guiding `--help`, lockfile, or
    env inspection); mark any resulting fix
    `origin: 'self_healing_experiment'`.
  - **Constraints (from AGENTS.md)**: probe-class failures (Decision #25 —
    nonzero exit as the intended answer) never count toward stuck state;
    hook stdout stays within the strict schema (Decision #2); state lives in
    SQLite, never module memory (Decision #4); a probe never closes an
    episode (Decision #38).
  - **Acceptance**: State-machine tests verifying hypothesis injection on the
    2nd failure, suppression once resolved, and antibody crystallization on
    success.

### Known delivery gap (tracked, not hidden)

- [x] **1.5-DSH**: the stuck hypothesis now ALSO delivers on DSH — turn-start
  (`preStep`) rides the same channel the probe-thrash advisory already uses.
  `stuckHypothesisText` lives in core, so both hosts read one string; the row
  only exists when the failure path found no covering rule, and
  `markHypothesized` keeps delivery once-per-streak across both surfaces
  (`test/dsh.test.mjs`, "1.5-DSH").

## Phase 2: v1.5 — Rule Evolution, Sleep Consolidation & Efficiency

- [x] **2.4a Managed `AGENTS.md` sync (`core/sync-doc.ts`)** — already
      shipped: deterministic, idempotent `<!-- immune:generated -->` block
      (see the tail of this repo's own AGENTS.md).
- [x] **2.2 Post-Injection Rule Mutation (`core/lessons.ts`,
      `core/store/antibodies.ts`)**
  - **Target**: When an injected antibody still suffers a failure
    (`post_injection_failure`) and the agent subsequently finds a working
    fix, refine the rule (`v1 -> v2`, narrowing false triggers or appending
    the missing condition) while recording `parent_id` lineage.
  - **Constraints**: only episodes WITH repair evidence may mutate — a
    failure-only episode cannot be distilled (Decision #24); the deterministic
    path may only narrow triggers/merge conditions from observed evidence,
    never invent advice (Decision #28).
  - **Acceptance**: Tests verifying lineage creation, improved specificity on
    the refined trigger, and refusal of the failure-only shape.
- [x] **2.3b Detour-to-Shortcut Telemetry (`core/trace.ts`)**
  - **Target**: Detect convergent detours — >= 4 consecutive read-only probes
    on the same target followed by the successful command — and surface them
    as review candidates via CLI/telemetry. Shortcut advice is minted only
    through the LLM rewrite path (`immune rewrite`), never deterministically
    (Decision #28: the deterministic path's advice IS the echoed command).
  - **Locked (Decision #19)**: the Edit-before-Read anti-pattern detector
    stays deferred — the host enforces Read-before-Edit deterministically,
    and Write-overwrite would need a per-session read set for one narrow case.
  - **Acceptance**: Trace replay tests catching probe thrashing as a
    telemetry row without distilling an echo-grade rule.
- [x] **2.4b Turn-End Sleep Consolidation (`core/consolidate.ts`,
      `core/sync-doc.ts`)**
  - **Target**: Bounded consolidation riding the EXISTING turn-end drain
    (`Stop` / `agent/turn-stopping`) with a 12h cooldown — ZCode has no
    `SessionEnd` (known limits). Cluster >= 5 related rules in the same tool
    family into a review queue (merges stay explicit per Decision #29), and
    refresh the managed `AGENTS.md` section with rules that crossed the
    proven threshold (hit_count >= 5, fail rate < 10%).
  - **Acceptance**: Drain tests verifying cooldown enforcement, clustering,
    and zero contradiction with human-written sections.
- [x] **2.5a Structural Error-Code Slots (`core/store/tokenize.ts`)**
  - **Target**: Extract exact error codes (`ECONNREFUSED`, `TS\d+`,
    `ERR_[A-Z_]+`, HTTP 4xx/5xx) as high-weight lexical anchors in FTS5.
  - **Locked (Decision #19)**: `IMMUNE_EMBEDDING=local` vector rerank stays
    out — it breaks the zero-dependency contract for a measured-small recall
    gap. Revisit only when the #19 re-entry condition (value counter showing
    suppression outliving rule quality) is met by data.

### Locked by AGENTS.md Decision #19 (do not re-propose without new evidence)

- **2.1 EMA Fitness & dormant state**: prototyped on paper, deferred — it
  duplicates anti-rot's job with a third tunable whose failure mode (silently
  parking a good rule) is worse than an occasional weak injection. Current
  retirement is ALREADY a rate gate, not a flat 3-strike (Decision #36:
  `fails >= 3 && fails >= 25% of deliveries`).
- **Re-entry condition, measured 2026-11-11**: the condition is "suppression
  outliving rule quality". On every library reachable from this checkout
  (project db, its shared library, `~/.dsh-immune`): `suppressedRepeats = 0`
  and total deliveries = 0 — there is no suppression growth at all, so the
  condition is NOT met; the production library that drove the original
  decision lives outside this checkout. Measured again if that library is
  ever placed where the checkout can read it; until then both items stay
  locked, now by data rather than by silence.

## Phase 3: v2.0 — Team Immunity, CI Gate & Evolution Telemetry

- [x] **3.1 Environment Fingerprint Metabolism (`core/store/antibodies.ts`,
      SessionStart)**
  - **Target**: Record workspace environment fingerprints
    (`package-lock.json` / `Cargo.lock` / `pyproject.toml` hash + runtime
    major version) on project rules; mark affected rules `probation` when
    dependencies upgrade and auto-retire as `superseded_by_env_upgrade` if
    the agent succeeds without them. One lifecycle state and one decay rule
    — do not grow a tunable zoo (the #19 lesson).
  - **Acceptance**: Simulated lockfile/Node upgrade tests demonstrating rule
    probation and clean retirement.
- [x] **3.2 Sanitized Federated `packs` & PR `ci-check` (`core/export.ts`,
      `zcode/src/cli.ts`)**
  - **Target**: Automated path/secret/repo-name sanitization checks in
    `packs-create` / `packs-publish`; stateless `immune ci-check` scanning PR
    diffs against known repository pitfalls in GitHub Actions.
  - **Acceptance**: Sanitization tests rejecting leaked local paths/tokens
    and `ci-check` exit-code/JSON report tests.
- [x] **3.3 Agent Evolution Telemetry (`core/ui/page.ts`, `core/ui/query.ts`)**
  - **Target**: Evolution panel in the local Web UI: weekly First-Try Tool
    Success Rate, Mean Retries per Failure, rule lineage counts, cumulative
    deliveries. Zero external CDN assets (Decision #14: the page stays
    offline).
  - **Acceptance**: UI query unit tests and rendered HTML verification.

## Phase 4: v3.0 — Swarm Immunity & Proactive Pre-Warming

- [x] **4.1 Fresh-Antibody Visibility for Parallel Subagents
      (`core/store/`)**
  - **Resolution**: NO watermark was needed — and adding one would have been
    solving a non-problem. Every hook is its own process (Decision #4), so
    every `PreToolUse` opens the store and SELECTs fresh; there is no
    per-process result cache to invalidate. The deliverable is the PROOF: a
    multi-process acceptance test where process A crystallizes a rule and
    process B's real PreToolUse hook recalls it on its first call
    (`test/hooks.test.mjs`, "4.1 swarm freshness"). Two connections, never
    `ATTACH` (Decision #7) — unchanged.
  - **Acceptance**: the swarm-freshness test above, green.
- [x] **4.2 Proactive Stack Fingerprinting on `SessionStart`
      (`core/store/seeds.ts`)**
  - **Target**: Detect repository stack fingerprints (`node-ts`, `python-uv`,
    `rust-cargo`, `docker`, `git`) on `SessionStart` and pre-warm matching
    built-in seed antibodies before the first tool error.
  - **Acceptance**: Cold-start test proving proactive prevention on the first
    tool call.
