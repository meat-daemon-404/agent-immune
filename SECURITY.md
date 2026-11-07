# Security Policy

## Supported versions

Only the latest release line receives security fixes. Given the release
cadence, that is effectively "update to the newest 1.0.x".

## Reporting a vulnerability

Please do NOT open a public issue for a security problem. Use GitHub's
**Private vulnerability reporting** (Security → Report a vulnerability), or
open an issue titled only `[security]` with contact details and no detail if
private reporting is unavailable.

What matters most in this codebase, in priority order:

1. **The injection delimiter** — anything that lets distilled text close or
   forge `<immune_memory>` / `<immune_guard>` blocks (see AGENTS.md #18: the
   renderer owns the delimiter).
2. **The deterministic guard** — patterns are code, `deny` is opt-in; a false
   positive that blocks legitimate work is a bug, and so is a bypass.
3. **Redaction before disk** — credentials reaching the SQLite library or the
   export snapshot (see AGENTS.md #10 and the redaction patterns list).
4. **The local dashboard/route surfaces** — loopback binding, token gating,
   same-origin mutation checks.

## Scope notes

- The database stores redacted traces **by design** — reporting that the DB
  contains redacted placeholders is not a vulnerability.
- The optional LLM distillation trusts its configured endpoint; a malicious
  endpoint is out of scope, but a malicious *tool result* escaping the
  verdict/injection paths is in scope (see AGENTS.md #21).
