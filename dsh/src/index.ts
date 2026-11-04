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
import { distillEpisode } from '../../core/distiller.js';
import { strings } from '../../core/i18n.js';
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
const MAX_TRACKED_SESSIONS = 256;

function rememberPrompt(sessionId: string, text: string): void {
  if (!text) return;
  lastPrompts.delete(sessionId);
  lastPrompts.set(sessionId, text);
  if (lastPrompts.size <= MAX_TRACKED_SESSIONS) return;
  const oldest = lastPrompts.keys().next().value;
  if (oldest !== undefined) lastPrompts.delete(oldest);
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

/** Drain queued jobs inline; DSH has no separate turn-end event to defer to. */
async function drain(store: ImmuneStore, budgetMs = 8000): Promise<void> {
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
      });
      if (result.ok) {
        store.insert(result.antibody);
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

  // Remember every human prompt as it lands, so a resumed session can still be
  // matched even when its first pre-step batch carries no human message.
  ctx.on('session/event', (session, event: DshSessionEvent) => {
    if (event.type !== 'user/message') return;
    const message = event.data as PromptMessage;
    if (message.source?.kind !== 'user') return;
    rememberPrompt(session.header.id, textOf(message.content ?? []));
  });

  // Session start: prime with the project's most-used antibodies. Delivered via
  // `inject()` — the channel the `agent/session-start` docs name explicitly.
  ctx.on(DSH_EVENTS.sessionStart, ({ agent }) => {
    const block = renderMemory(store.listAll(false).slice(0, 3), t.promptPreamble, 1400);
    if (block) agent.inject(createPluginMessage(block));
  });

  // Pre-step: recall antibodies that match what the human is about to ask.
  // `inject()` can miss the turn already being assembled, so the block is also
  // spliced into the decision returned by the waterfall's default `next()`.
  ctx.on(DSH_EVENTS.preStep, async ({ agent, messages }, next): Promise<DshPreStepDecision> => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    // Prefer the prompt the driver actually claimed this step; fall back to the
    // last prompt seen on the session stream (cold resume/compact carry none).
    const prompt = lastHumanPrompt(decision.messages) || lastPrompts.get(agent.id) || '';
    if (!prompt) return decision;

    const hits = store.match(prompt, { limit: 3, sessionId: agent.id });
    const block = renderMemory(hits, t.promptPreamble, 1400);
    if (!block) return decision;

    const desired = createPluginMessage(block);
    return { kind: 'enter', messages: decision.messages.toSpliced(insertAt(decision.messages, messages), 0, desired) };
  });

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
        const snapshot = store.recordFailure(
          event.sessionId,
          event.toolName,
          traceFor(event, `error=${event.errorText}`),
        );
        const retired = store.penalize(snapshot.injected_ids, {
          failureText: snapshot.trace,
          toolName: event.toolName,
        });
        for (const ab of retired) {
          store.enqueueJob(
            event.toolName,
            traceFor(event, `error=retired #${ab.id}: ${ab.prescription}`),
            snapshot.trace,
            [],
          );
        }
        return downstream;
      }

      const failure = store.claimFailure(event.sessionId, event.toolName);
      if (failure) {
        store.enqueueJob(
          event.toolName,
          failure.trace,
          traceFor(event, `result=${event.resultText}`),
          failure.injected_ids,
        );
        // No turn-end hook here, so distillation runs after the episode closes.
        await drain(store);
      }
      return downstream;
    },
  );

  ctx.effect(
    () => () => {
      store.close();
    },
    `${PLUGIN_NAME}: close antibody store`,
  );

  ctx.commands.register({
    name: 'immune',
    description: 'List the pitfall antibodies this project has learned',
    input: { hint: '--all to include retired antibodies' },
    handler: ({ rawInput }): DshCommandResult => {
      const rows = store.listAll(rawInput.includes('--all'));
      if (rows.length === 0) return { kind: 'success', text: t.noAntibodies };
      const text = rows
        .map(
          (a) =>
            `#${a.id} [hits ${a.hit_count}/fails ${a.fail_count}] ${a.status}\n  ${t.trigger}: ${a.trigger_pattern}\n  ${t.avoid}: ${a.symptom}\n  ${t.do}: ${a.prescription}`,
        )
        .join('\n\n');
      return { kind: 'success', text };
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
