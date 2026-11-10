# Show HN — draft

> 发布前需人工核对：数字以发布当天重跑为准；HN 不接受多账号顶帖，评论区首条补充常见问题。

## Title

```
Show HN: I analyzed 20k tool calls from my own coding agents, then built a zero-dependency immune system for them
```

## Body

For the last ~4 months I let my coding agents (ZCode, a Claude Code fork, and
Codex CLI) work normally, and recorded every tool call. Then I replayed the
history through a simple pairing rule: **a tool call that fails, followed by a
call that succeeds on the same target, is a lesson.**

The numbers from my own machine (120 days, dry-run of `immune audit`):

- 19,971 tool calls scanned · 835 failures · **172 failed-then-fixed episodes**
- The same mistakes kept repeating: 83× "File has not been read yet", 63×
  "File has been modified since read", 101× a family of shell-misuse failures
  (writing source files through the shell, bypassing the editor's safety scan)
- Estimated ~34M tokens burned on episodes that a rule would have prevented
  (median request size × 2 round-trips per episode — the estimate's one stated
  assumption, no invented exchange rate)

So I built **dsh-immune-system**: every failed-then-fixed episode gets distilled
into an "antibody" (trigger → wrong instinct → verified fix), stored in local
SQLite (FTS5 + a CJK bigram fallback, zero external dependencies), and injected
into context **before** the agent repeats the mistake.

What makes it different from a chat-memory tool:

1. **It learns from evidence, not conversation.** A rule only exists because a
   tool call actually failed and a specific action fixed it. The repair actions
   (which files the fix edited) ride along as provenance.
2. **Failure is judged, not trusted.** Replaying 20,100 real host-labeled tool
   calls through the judge: 97.54% agreement with the host's own labels, **0
   false negatives**. The 2.46% false positives are all probe commands where a
   nonzero exit was the intended answer — a class we quantified and accepted
   instead of patching with output heuristics.
3. **One engine, every host.** DSH and ZCode install natively; Claude Code and
   Codex CLI get hooked with `npx dsh-immune-system@latest connect <host>`
   (fixed-path install, survives npx cache sweeps); Cursor/Cline reach the same
   library over MCP; anything else reads the synced AGENTS.md block.
4. **Your library stays yours.** Everything is a local SQLite file; removal is
   conservative (a rule the agent has since used is kept even when you uninstall
   a starter pack); a one-command backup (`immune backup`) snapshots the WAL db
   safely.

Quick tour (30 seconds each, installs nothing):

- `npx dsh-immune-system@latest demo` — distills one real episode in memory
- `npx dsh-immune-system@latest audit --dry-run` — scans YOUR history and shows
  what it would learn (the table above came from this)
- `npx dsh-immune-system@latest seed git-safety` — six hand-authored starter rules

Repo: https://github.com/meat-daemon-404/dsh-plugin-immune

Happy to answer questions about the pairing logic, the FTS5/trigram retrieval
(the 2-char CJK fallback was measured, not guessed), or why the fitness/dormant
lifecycle is deliberately deferred.
