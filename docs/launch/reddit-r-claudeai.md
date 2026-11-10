# Reddit r/ClaudeAI — draft

> 数字已于 2026-11-10 重跑核对（120 天窗口）；发布当天仍建议再跑一次；先看版规（self-promotion 频率限制），正文把数字换成当天的重跑结果。

## Title

```
My agents kept re-debugging problems they had already fixed — so I built them an immune system (zero deps, local SQLite, works with Claude Code / Codex / Cursor)
```

## Body

Two weeks into letting Claude-style agents run my projects, I noticed the same
wall: the agent hits an error, figures it out, fixes it — and then hits the
**same error again next week** because nothing remembered the lesson.

I measured it. ~4 months of real sessions on my machine, replayed through a
failed-then-fixed pairing rule: **19,958 tool calls → 842 failures → 173
episodes where a fix succeeded but nothing remembered it.** Top offenders were
not exotic: "File has not been read yet" 78 times, "File has been modified
since read" 60 times, a shell-misuse family 107 times. ~32.8M tokens of
preventable round-trips (estimate, assumption stated — median request × 2).

So I built an immune system for coding agents:

- **learns from evidence**: a rule exists only because a call failed and a
  specific repair fixed it (the repaired files are recorded as provenance)
- **injects BEFORE the repeat**: matched rules enter context before the agent
  re-attempts the same kind of call — not a search box you have to remember
  to use
- **zero dependencies**: Node's built-in `node:sqlite` only; FTS5 trigram index
  with a measured CJK bigram fallback (Chinese triggers work)
- **host coverage**: Claude Code & Codex CLI via
  `npx dsh-immune-system@latest connect claude-code` (fixed-path install in
  `~/.dsh-immune/`, survives npx cache sweeps, `--remove` is clean);
  Cursor/Cline over MCP (`immune_audit` preview, `immune_seed_packs`);
  DSH/ZCode install natively
- **cold start in 10 seconds**: `audit --dry-run` turns your own session
  history into a shareable pitfall report + first rules;
  `seed git-safety` installs six hand-authored starter rules (removal keeps
  any rule your agent has since used — it carries your evidence now)
- **removal/backup story**: `connect <host> --remove` deletes the vendored
  install when no host remains; `immune backup` snapshots the WAL database
  safely (a plain copy of a WAL db can come back empty — measured)

Everything is local SQLite. No telemetry. The dashboard (`immune ui`) shows
injections, per-model attribution and a cross-model proof chip.

Verified numbers: replaying 20,100 real host-labeled tool calls through the
failure judge — 97.54% agreement, **0 false negatives** (the 2.46% false
positives are probe commands where a nonzero exit was the intended answer;
quantified and accepted, in AGENTS.md decision #25).

Repo + README with screenshots: https://github.com/meat-daemon-404/agent-immune

Happy to answer anything about the pairing logic or the retrieval layer.
