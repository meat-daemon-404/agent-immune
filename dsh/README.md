# DSH adapter — status: unverified

This directory is a **skeleton awaiting contract alignment**. It compiles and
shares the same `core/` as the ZCode plugin, but it has **not** been run against
a real DSH host: no DSH runtime existed on the machine where this was built.

Everything host-specific is confined to `dsh/src/dsh-adapter.ts`. When the real
contract is known, that is the only file that should need to change.

## What was assumed

| Concern | Assumed (from the original sketch) | Confidence |
| --- | --- | --- |
| Plugin shape | `export const name`, `export function apply(ctx)` (Cordis/Koishi) | high — this is real Cordis style |
| Session start | `'dsh/session-start'` | **low** — name invented |
| Pre-request | `'dsh/before-llm-request'` | **low** — name invented |
| Tool outcome | `'dsh/after-tool-call'` + `isError` flag | **low** — ZCode splits this into two events |
| Context injection | `session.appendSystemReminder(text)` | **low** |
| Model access | `ctx.llm.complete(...)` | **low** — adapter avoids it entirely |
| Commands | `ctx.command(name, desc).action(fn)` | medium — Cordis shape |
| Storage | `node:sqlite` + FTS5 | high — verified on Node 24 locally |

## Verification checklist

Work through these in order; each one unblocks the next.

1. **Event names.** Read the DSH runtime's event registry. Replace
   `DSH_EVENTS` in `dsh-adapter.ts`.
2. **Failure signalling.** Decide whether a failed tool call arrives as a
   separate event or as a flag. If separate, the adapter must expose both and
   `apply()` must subscribe to both. ZCode does this as
   `PostToolUse` / `PostToolUseFailure`.
3. **Tool payload field names.** Fill in `normaliseToolEvent` and then *delete
   the speculative fallbacks* — they exist only to survive an unknown contract.
4. **Injection method.** Confirm how text reaches the model and whether it is
   synchronous. If background work is discarded (as in ZCode), injection must
   stay on the request path.
5. **Model access.** Either map `ctx.llm` into `LlmConfig`-shaped settings, or
   set `IMMUNE_LLM_BASE_URL` / `IMMUNE_LLM_MODEL` and drop the host LLM
   dependency completely.
6. **Command output.** Confirm how a command handler's return value is
   rendered.

## Simplification once aligned

The adapter currently reads several plausible field spellings at once. That is
a deliberate hedge, not a design goal — collapse it to the exact contract as
soon as it is known, so mistakes surface loudly instead of silently.

## Shared behaviour

Because both adapters call the same `core/`, these are identical across hosts:

- the antibody schema and FTS5 trigram retrieval;
- failure → success pairing and the 30-minute pending window;
- anti-rot retirement after three injected-but-still-failing episodes;
- credential redaction before anything is written to disk;
- `SKILL.md` export format.

Point both plugins at the same `IMMUNE_DB_PATH` and they share one antibody
library.
