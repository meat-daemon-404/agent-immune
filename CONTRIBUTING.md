# Contributing

Thanks for considering a contribution. This project is maintained with an
unusual discipline (it documents its own invariants in
[AGENTS.md](AGENTS.md) — every one of the 24 entries is backed by a real
incident), and the gates below are what keep it honest.

## Setup

```bash
npm install
npm run build
npm test
```

Node 22.19+ or 24+ (the plugin runs on `node:sqlite`; no native deps).

## The gates

A change is done when ALL of these pass:

1. `npm test` — unit tests (node:test)
2. `node scripts/verify-step1.mjs` — outcome classification contract
3. `node scripts/verify-steps23.mjs` — the full loop on a fake Cordis host
4. `node scripts/verify-live-host.mjs` — real Cordis event bus (needs the
   local DSH checkout; machine-only)
5. `node scripts/bench-tool-latency.mjs` — the drain cost curve (~40 s)
6. `node scripts/bench-recall.mjs` — the retrieval gate (R@3, FP rate)
7. `node scripts/bench-scale.mjs` — index/match latency at 300 rules

CI runs 1, 2, 3, 6 on Linux (node 22 + 24) for every push; the rest are
machine-only. If an acceptance script fails after your change, treat it as
your regression until proven otherwise.

## House rules (the short list)

- **Read [AGENTS.md](AGENTS.md) before proposing a "simplification".** Several
  obvious-looking improvements have been tried and reverted; the file records
  why.
- **All cross-event state lives in SQLite** — hooks are separate processes.
- **The npm layout has a doubled `dsh-immune-system/` prefix, on purpose.**
  Probe the prefixed paths when verifying an install.
- **Bump all four manifests together** (`scripts/check-versions.mjs` gates it).
- Guard patterns live in code, never in the database, and every pattern ships
  with its false-positive matrix — including the command its own advice
  recommends.

## Reporting a bug

Run `immune doctor` (or `npx dsh-immune-system doctor`) and paste the output
into the issue template — it answers most of the questions in advance.
