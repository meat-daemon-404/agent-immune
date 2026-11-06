/**
 * DSH plugin entry — real Cordis plugin shape (`name` + `inject` + `apply(ctx)`).
 *
 * Shares `core/` with the ZCode plugin, so behaviour and storage format are
 * identical. Only the host binding differs, and that lives in `dsh-adapter.ts`.
 *
 * The three host facts this file depends on, all read out of the DSH checkout:
 *  - results arrive on `tools/post-execute` (waterfall) — there is no separate
 *    failure event, and `isError` only covers infrastructure failures;
 *  - model-facing text goes in through `agent.inject()` / the `agent/pre-step`
 *    decision — `session.appendSystemReminder` does not exist in DSH;
 *  - commands register as `{ name, description, handler }` and the handler
 *    returns a `CommandResult` object, not a bare string.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ImmuneStore } from '../../core/store/index.js';
import { renderSkillMarkdown } from '../../core/export.js';
import { distillEpisode, isSubstantiveHint } from '../../core/distiller.js';
import { matchGenericLesson } from '../../core/lessons.js';
import { strings } from '../../core/i18n.js';
import { isSelfEpisode } from '../../core/selfnoise.js';
import { findGuardHit, guardMode } from '../../core/guards.js';
import { redact } from '../../core/redact.js';
import { registerImmuneUiRoute } from './ui-route.js';
import {
  DSH_EVENTS,
  PLUGIN_NAME,
  createPluginMessage,
  makeLogger,
  normaliseToolEvent,
  textOf,
  type DshCommandResult,
  type DshContentBlock,
  type DshContext,
  type DshPostToolDecision,
  type DshPreStepDecision,
  type DshPreToolDecision,
  type DshSessionEvent,
  type NormalisedToolEvent,
} from './dsh-adapter.js';

export const name = PLUGIN_NAME;

/**
 * `ctx.commands` is a service, so it must be injected — accessing an
 * un-injected service throws `cannot get property "..." without inject`
 * (`vendor\cordis\src\reflect.ts:144`). The plugin registers no tools, so
 * `'tools'` is deliberately absent.
 */
export const inject = ['commands'];

export { PLUGIN_NAME, DSH_EVENTS, normaliseToolEvent } from './dsh-adapter.js';

const t = strings();

/**
 * Where the antibody store lives.
 *
 * `IMMUNE_DB_PATH` wins (tests and the ZCode side set it). Otherwise the store
 * is keyed by the current project under the DSH home, so antibodies learned in
 * one workspace never leak into another and nothing is written into the project
 * tree itself:
 *
 *     <DSH_HOME>/storages/dsh-immune-system/<sha1(cwd)[0..16]>.sqlite
 *
 * `core/store/path.ts` cannot express this — it is shared with the ZCode host
 * and knows nothing about a DSH home — so the DSH-specific default lives here.
 */
function resolveStorePath(): string {
  const explicit = process.env.IMMUNE_DB_PATH?.trim();
  if (explicit) return explicit;
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const projectKey = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 16);
  const dir = join(home, 'storages', 'dsh-immune-system');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${projectKey}.sqlite`);
}

/**
 * Self-noise markers for the DSH host: the plugin's own storage directory.
 * Any failure trace touching it is the plugin's maintenance, not a pitfall.
 */
function selfMarkers(): string[] {
  const explicit = process.env.IMMUNE_DB_PATH?.trim();
  if (explicit) return [explicit];
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return [join(home, 'storages', 'dsh-immune-system')];
}

/**
 * Latest human prompt seen per session.
 *
 * A cold `resume` / `clear` / `compact` start hands `agent/pre-step` a batch
 * that carries no human message (the inbox is rebuilt only from post-seed
 * `agent/inbox/spliced` events), so recall-by-prompt would silently do nothing
 * on the first request after a resume. Recording prompts from the durable
 * `user/message` events closes that gap. Bounded so a long-lived process does
 * not grow without limit.
 */
const lastPrompts = new Map<string, string>();
/** Last turn a recall block was spliced for, so a turn injects at most once. */
const lastInjectedTurn = new Map<string, number>();
const MAX_TRACKED_SESSIONS = 256;

function rememberPrompt(sessionId: string, text: string): void {
  if (!text) return;
  lastPrompts.delete(sessionId);
  lastPrompts.set(sessionId, text);
  if (lastPrompts.size <= MAX_TRACKED_SESSIONS) return;
  const oldest = lastPrompts.keys().next().value;
  if (oldest !== undefined) {
    lastPrompts.delete(oldest);
    lastInjectedTurn.delete(oldest);
  }
}

/** One distilled antibody, as `renderMemory` needs it. */
interface MemoryBlock {
  trigger_pattern: string;
  symptom: string;
  prescription: string;
}

/** The slice of a host message `lastHumanPrompt` inspects. */
interface PromptMessage {
  source?: { kind?: string };
  content?: ReadonlyArray<DshContentBlock>;
}

/**
 * Render antibodies as the compact advisory block.
 *
 * The `<immune_memory>` wrapper is the contract the model sees; brackets inside
 * antibody text are stripped so a distilled line can never close the tag early.
 */
function renderMemory(
  blocks: ReadonlyArray<MemoryBlock>,
  preamble: string,
  maxChars: number,
): string {
  if (blocks.length === 0) return '';
  const body = blocks
    .map(
      (b, i) =>
        `${i + 1}. [${t.trigger}: ${sanitize(b.trigger_pattern)}] ${t.avoid}: ${sanitize(b.symptom)} -> ${t.do}: ${sanitize(b.prescription)}`,
    )
    .join('\n');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return ['<immune_memory>', preamble, clipped, '</immune_memory>'].join('\n');
}

/** Strip tag characters so injected text cannot escape its wrapper. */
function sanitize(value: string): string {
  return value.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the episode trace in the format `core/` distils from.
 *
 * `core/trace.ts` and `core/distiller.ts` read these markers positionally:
 * `extractError` looks for `error=` / `result=`, and `extractInvocation`
 * scans for `"command":"…"` inside the JSON input. Handing them a bare error
 * string yields "no reusable trigger found" and silently distils nothing, so
 * the shape below is load-bearing — it mirrors `summarizeToolCall` on the
 * ZCode side (`zcode\src\format.ts:53`).
 */
function traceFor(event: NormalisedToolEvent, outcome: string): string {
  let input: string;
  try {
    input = JSON.stringify(event.toolInput ?? {});
  } catch {
    input = String(event.toolInput);
  }
  return `tool=${event.toolName} input=${input} ${outcome}`;
}

/**
 * Turn-end distillation budget, in milliseconds. Same env var and default as the
 * ZCode adapter (`zcode/src/drain.ts:23`), clamped so a typo cannot hang a turn.
 * `/immune --budget <ms>` sets a process-wide override for the running session;
 * it is deliberately in-memory only (a restart falls back to the env var), so a
 * stray slash command can never persist a bad number into the project.
 */
let budgetOverrideMs: number | null = null;

function clampBudgetMs(value: number): number {
  return Math.min(60_000, Math.max(1_000, Math.trunc(value)));
}

function drainBudgetMs(): number {
  if (budgetOverrideMs !== null) return budgetOverrideMs;
  const raw = Number(process.env.IMMUNE_DISTILL_BUDGET_MS ?? '');
  return clampBudgetMs(Number.isFinite(raw) && raw > 0 ? raw : 12_000);
}

/**
 * Whether the host actually composed our web-client bundle row.
 *
 * `client-modules` only serves `/plugins/<id>/client.js` for a package whose
 * manifest declares `dsh.client.platform === "web"` and `exports["./client"]`,
 * and it caches a negative verdict for the life of the process. That is why a
 * settings tab can stay missing after an upgrade until the app is restarted;
 * surfacing the live answer in `/immune` and at startup turns that into a
 * one-line check instead of a guess. `ctx.get('clientModules')` is a read-only
 * service lookup (no inject edge), per
 * `packages\context\agent-instructions\src\index.ts:116`.
 */
export function readWebTabState(registry: unknown): string {
  const clientPath = (registry as { clientPath?: (id: string) => string | undefined } | undefined)
    ?.clientPath;
  if (typeof clientPath !== 'function') return 'not loaded';
  try {
    return clientPath.call(registry, PLUGIN_NAME) === undefined ? 'not registered' : 'registered';
  } catch {
    return 'error';
  }
}

function describeWebTab(ctx: DshContext): string {
  const get = ctx.get;
  if (typeof get !== 'function') return 'unknown';
  try {
    return readWebTabState(get.call(ctx, 'clientModules'));
  } catch {
    return 'unknown';
  }
}

/**
 * Log the web-tab verdict once the host has composed its module graph.
 *
 * Activation order is not guaranteed: at `apply()` time `clientModules` may not
 * exist yet, and even when it does the graph is flushed later. So subscribe to
 * the registry's `onGraphChanged` (pull model: re-read `clientPath`) and also
 * check once immediately, logging the first answer only.
 */
function reportWebTabWhenComposed(ctx: DshContext, log: ReturnType<typeof makeLogger>): void {
  const inject = ctx.inject;
  if (typeof inject !== 'function') return;
  try {
    inject.call(ctx, ['clientModules'], (child: unknown) => {
      const registry = (child as { clientModules?: unknown } | undefined)?.clientModules;
      let logged = false;
      const report = (): void => {
        if (logged) return;
        logged = true;
        log.info(`[immune] web tab: ${readWebTabState(registry)}`);
      };
      const onGraphChanged = (registry as { onGraphChanged?: (cb: () => void) => unknown } | undefined)
        ?.onGraphChanged;
      if (typeof onGraphChanged === 'function') {
        try {
          onGraphChanged.call(registry, report);
        } catch {
          /* a host that exposes the hook but rejects it must not break us */
        }
      }
      report();
    });
  } catch {
    /* no cordis-style injection: the plugin still works without a web UI */
  }
}

/** Distil queued episodes. Called at turn end, never inside a tool result path. */
async function drain(store: ImmuneStore, budgetMs = drainBudgetMs()): Promise<void> {
  const deadline = Date.now() + budgetMs;
  store.requeueStuckJobs();
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const job = store.claimJob();
    if (!job) break;
    try {
      const result = await distillEpisode(job.tool_name, job.failure_trace, job.success_trace, {
        signal: AbortSignal.timeout(Math.max(1000, remaining)),
        humanHint: job.human_hint ?? '',
      });
      if (result.ok) {
        store.insertShared(result.antibody, {
          generic: matchGenericLesson(result.antibody.symptom) !== null,
        });
        store.finishJob(job.id, 'done');
      } else {
        store.finishJob(job.id, result.reason === 'skip' ? 'skipped' : 'failed', result.detail ?? '');
      }
    } catch (error) {
      store.finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Where to splice the recall block: right after the last message the driver
 * claimed for this step, so the human prompt still precedes the advisory and
 * any runtime context the driver appended still follows it.
 *
 * Mirrors `agent-instructions` (`packages\context\agent-instructions\src\index.ts:322-348`).
 * Falls back to the end when the claimed batch is not present in the decision
 * (a cold `resume`/`compact` start can hand back a different batch).
 */
function insertAt(decisionMessages: ReadonlyArray<PromptMessage>, claimed: ReadonlyArray<PromptMessage>): number {
  const lastClaimedIndex = decisionMessages.findLastIndex((message) => claimed.includes(message));
  return lastClaimedIndex < 0 ? decisionMessages.length : lastClaimedIndex + 1;
}

export function apply(ctx: DshContext): void {
  try {
    startPlugin(ctx);
  } catch (error) {
    // A broken plugin must never break the session: degrade to a warning and
    // leave the agent running without immunity for this session.
    makeLogger(ctx).warn(
      `[immune] disabled for this session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function startPlugin(ctx: DshContext): void {
  const log = makeLogger(ctx);
  const store = new ImmuneStore({ dbPath: resolveStorePath() });
  log.info(`[immune] storage: ${store.dbPath}`);

  // Native web UI: the settings tab in the DSH web app talks to this route.
  // Optional on purpose — CLI and desktop profiles expose no `webServer`, and
  // requiring one would stop the plugin activating there at all.
  registerImmuneUiRoute(ctx, store, () => drainBudgetMs());

  reportWebTabWhenComposed(ctx, log);

  // Remember every human prompt as it lands, so a resumed session can still be
  // matched even when its first pre-step batch carries no human message.
  ctx.on('session/event', (session, event: DshSessionEvent) => {
    if (event.type !== 'user/message') return;
    const message = event.data as PromptMessage;
    if (message.source?.kind !== 'user') return;
    const text = textOf(message.content ?? []);
    rememberPrompt(session.header.id, text);
    // A fresh human message is the explanation for whatever failed last turn;
    // attaching it makes the distilled prescription human-authored.
    if (isSubstantiveHint(text)) store.attachHumanHint(session.header.id, text);
  });

  // Session start: retire stale antibodies once, then prime with the project's
  // most-used ones. Delivered via `inject()` — the channel the
  // `agent/session-start` docs name explicitly, and its content is visible to
  // the very first request.
  ctx.on(DSH_EVENTS.sessionStart, ({ agent, source }) => {
    store.pruneStale();
    const active = store.listAll(false);
    const block = renderMemory(active.slice(0, 3), t.promptPreamble, 1400);
    if (block) agent.inject(createPluginMessage(block));
    log.info(`[immune] session-start (${source}): ${active.length} active antibody/queries`);
  });

  // Pre-step: recall antibodies that match what the human is about to ask.
  // `inject()` can miss the turn already being assembled, so the block is also
  // spliced into the decision returned by the waterfall's default `next()`.
  ctx.on(DSH_EVENTS.preStep, async ({ agent, messages, turn, step }, next): Promise<DshPreStepDecision> => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    // Recall is a per-turn decision. Re-injecting on every step of a tool loop
    // would repeat the same block, and — because `match()` bumps hit counts —
    // would make "popularity" a function of how many steps a turn happened to
    // take. Both are avoided by acting only on the first step of each turn.
    if (step !== 1) return decision;
    if (lastInjectedTurn.get(agent.id) === turn) return decision;

    // Prefer the prompt the driver actually claimed this step; fall back to the
    // last prompt seen on the session stream (cold resume/compact carry none).
    const prompt = lastHumanPrompt(decision.messages) || lastPrompts.get(agent.id) || '';
    if (!prompt) return decision;

    const hits = store.match(prompt, { limit: 3, sessionId: agent.id });
    const block = renderMemory(hits, t.promptPreamble, 1400);
    if (!block) return decision;

    lastInjectedTurn.set(agent.id, turn);
    const desired = createPluginMessage(block);
    return { kind: 'enter', messages: decision.messages.toSpliced(insertAt(decision.messages, messages), 0, desired) };
  });

  // Guards run before dispatch and can refuse the call outright. Only the
  // `deny` mode is meaningful here: `PreToolDecision` has no context channel,
  // so `warn` cannot be delivered from this hook and is ZCode-only.
  ctx.on(
    DSH_EVENTS.preToolExecute,
    async (exec, next): Promise<DshPreToolDecision> => {
      if (guardMode() === 'deny') {
        const argumentsText = (() => {
          try {
            return redact(JSON.stringify(exec?.arguments ?? {})).slice(0, 2000);
          } catch {
            return '';
          }
        })();
        const hit = findGuardHit(argumentsText);
        if (hit) {
          return { kind: 'deny', reason: `[${hit.rule.id}] ${hit.rule.what} → ${hit.rule.instead}` };
        }
      }
      return next();
    },
  );

  // Tool results: sense the failure -> success inflection.
  ctx.on(
    DSH_EVENTS.postToolExecute,
    async (exec, result, next): Promise<DshPostToolDecision> => {
      // Delegate first so a later listener can still block or replace, then
      // judge the tool's OWN outcome (`result` is the frozen pre-decision
      // snapshot, not another plugin's rewrite — an antibody must describe a
      // real tool failure, never a policy block).
      const downstream = await next();
      const event = normaliseToolEvent(exec, result);
      if (!event) return downstream;

      if (!event.ok) {
        // A sandbox file-access denial is a permission negotiation, not a
        // project pitfall: the host already hands the model an escalation hint,
        // and distilling it would only restate the same command. It also must
        // not penalise the injected antibodies — they were not what got refused.
        if (event.sandboxDenied) return downstream;
        const snapshot = store.recordFailure(
          event.sessionId,
          event.toolName,
          traceFor(event, `error=${event.errorText}`),
        );
        const retired = store.penalize(snapshot.injected_ids, {
          failureText: snapshot.trace,
          toolName: event.toolName,
        });
        // Self-noise (the harness operating on the plugin's own storage) only
        // retires rules; it never seeds an episode or a mutation job.
        if (!isSelfEpisode(snapshot.trace, selfMarkers())) {
          for (const ab of retired) {
            store.enqueueJob(
              event.toolName,
              snapshot.trace,
              `previous rule (retired after ${ab.fail_count} failures): ${ab.prescription}`,
              [],
            );
          }
        }
        return downstream;
      }

      const failure = store.claimFailure(event.sessionId, event.toolName);
      if (failure && !isSelfEpisode(failure.trace, selfMarkers())) {
        store.enqueueJob(
          event.toolName,
          failure.trace,
          traceFor(event, `result=${event.resultText}`),
          failure.injected_ids,
          failure.human_hint,
        );
      }
      return downstream;
    },
  );

  // Distillation runs at turn end, not inside the tool pipeline: `drain` may do
  // an HTTP call to the configured LLM (up to its budget), and a post-execute
  // listener is awaited *inside* the tool result path, so draining there would
  // stall every successful-after-failure tool call. `turn-stopping` is serial
  // and awaited before the boundary commits — the right place for turn-end work.
  ctx.on(DSH_EVENTS.turnStopping, async () => {
    if (store.pendingJobCount() > 0) await drain(store);
  });

  ctx.effect(
    () => () => {
      store.close();
    },
    `${PLUGIN_NAME}: close antibody store`,
  );

  ctx.commands.register({
    name: 'immune',
    description: 'List the pitfall antibodies this project has learned',
    input: { hint: '--all to include retired antibodies · --budget [ms] to view or set the drain budget' },
    handler: ({ rawInput }): DshCommandResult => {
      const args = rawInput.trim().split(/\s+/).filter(Boolean);

      if (args.includes('--budget')) {
        const raw = args[args.indexOf('--budget') + 1];
        if (raw === 'auto' || raw === 'reset' || raw === 'env') {
          budgetOverrideMs = null;
          return { kind: 'success', text: `distill budget reset to ${drainBudgetMs()} ms (env IMMUNE_DISTILL_BUDGET_MS / default)` };
        }
        const value = Number(raw ?? '');
        if (raw === undefined || !Number.isFinite(value) || value <= 0) {
          const source = budgetOverrideMs === null ? 'env IMMUNE_DISTILL_BUDGET_MS / default' : 'session override';
          return {
            kind: 'success',
            text: `distill budget: ${drainBudgetMs()} ms (${source})\nset with: /immune --budget <ms>  ·  clamped to 1000–60000`,
          };
        }
        budgetOverrideMs = clampBudgetMs(value);
        return {
          kind: 'success',
          text: `distill budget set to ${budgetOverrideMs} ms for this session (in-memory; a restart falls back to the env var)`,
        };
      }

      const rows = store.listAll(args.includes('--all'));
      const footer = `\n\n— distill budget ${drainBudgetMs()} ms · queued ${store.pendingJobCount()} · web tab ${describeWebTab(ctx)} · db ${store.dbPath}`;
      if (rows.length === 0) return { kind: 'success', text: t.noAntibodies + footer };
      const text = rows
        .map(
          (a) =>
            `#${a.id} [hits ${a.hit_count}/fails ${a.fail_count}] ${a.status}\n  ${t.trigger}: ${a.trigger_pattern}\n  ${t.avoid}: ${a.symptom}\n  ${t.do}: ${a.prescription}`,
        )
        .join('\n\n');
      return { kind: 'success', text: text + footer };
    },
  });

  ctx.commands.register({
    name: 'immune-forget',
    description:
      'Remove antibodies: <id>, --last (undo the previous turn), --prune (retire never-hit, >14d), --purge (delete them)',
    input: { hint: '<id> | --last | --prune | --purge' },
    handler: ({ rawInput }): DshCommandResult => {
      const args = rawInput.trim().split(/\s+/).filter(Boolean);

      if (args.includes('--last')) {
        const id = store.forgetLast();
        return {
          kind: 'success',
          text: id === null ? t.notFound : `${t.forgot} #${id}`,
        };
      }

      if (args.includes('--prune') || args.includes('--purge')) {
        const purge = args.includes('--purge');
        const window = 14 * 24 * 60 * 60 * 1000;
        const changed = purge ? store.pruneZombies(window) : store.retireZombies(window);
        const label = purge ? t.purged : t.pruned;
        return {
          kind: 'success',
          text:
            changed.length === 0
              ? t.noZombies
              : `${label} ${changed.length}: ${changed.map((n) => `#${n}`).join(' ')}`,
        };
      }

      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) {
        return { kind: 'error', text: `${t.notFound} — usage: <id> | --last | --prune` };
      }
      return {
        kind: 'success',
        text: store.remove(id) ? `${t.forgot} #${id}` : `${t.notFound} #${id}`,
      };
    },
  });

  ctx.commands.register({
    name: 'immune-learn',
    description:
      'Teach a rule directly: <trigger> | [symptom] | <prescription>  (| separated; without |, trigger = first token and prescription = the rest)',
    input: { hint: '<trigger> | [symptom] | <prescription>' },
    handler: ({ rawInput }): DshCommandResult => {
      const text = rawInput.trim();
      // Free text cannot be split by whitespace: "用 pnpm 不是 npm" would put
      // "npm" in the prescription slot. Pipe-separated when given; the
      // separator-free form keeps trigger = first token, prescription = the rest.
      const hasPipes = text.includes('|');
      const segments = hasPipes
        ? text.split('|').map((part) => part.trim())
        : (() => {
            const tokens = text.split(/\s+/);
            const first = tokens[0] ?? '';
            const rest = tokens.slice(1).join(' ');
            return rest ? [first, rest] : [first];
          })();

      const trigger = segments[0] ?? '';
      const prescription = segments[segments.length - 1] ?? '';
      const symptom = segments.length >= 3 ? segments.slice(1, -1).join(' | ') : '';
      if (!trigger || !prescription || segments.length > 3) {
        return {
          kind: 'error',
          text:
            `${t.notFound} — expected: <trigger> | [symptom] | <prescription>\n` +
            `example: pnpm-lock.yaml 这个仓库 | npm 装依赖报错 | 用 pnpm 不要用 npm`,
        };
      }
      const id = store.insert({
        trigger_pattern: trigger,
        symptom: symptom || '(manual rule)',
        prescription,
        tool_name: null,
      });
      return { kind: 'success', text: id === null ? t.notFound : `${t.learned} #${id}` };
    },
  });

  ctx.commands.register({
    name: 'immune-export',
    description: 'Export proven antibodies as a project-pitfalls skill',
    handler: (): DshCommandResult => {
      const rows = store.exportable(3);
      if (rows.length === 0) return { kind: 'success', text: t.noExport };
      const md = renderSkillMarkdown(rows, { minHits: 3 });
      return { kind: 'success', text: `${t.exported} ${rows.length}\n\n${md}` };
    },
  });
}

/** The most recent human prompt in a claimed batch, if any. */
function lastHumanPrompt(messages: ReadonlyArray<PromptMessage>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.source?.kind !== 'user') continue;
    const content: ReadonlyArray<DshContentBlock> | undefined = message.content;
    if (!content) continue;
    const text = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}
