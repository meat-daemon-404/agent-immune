/**
 * Turns one failed-then-fixed episode into an antibody.
 *
 * Two paths:
 *  1. An OpenAI-compatible model, when IMMUNE_LLM_* is configured.
 *  2. A deterministic rule-based fallback, so the loop works with zero
 *     configuration (and stays testable offline).
 *
 * Distillation never throws: a failure here must not cost the user a turn.
 */
import type { DistillResult } from './types.js';
import { DISTILL_PROMPT, buildDistillInput, parseDistillOutput } from './prompts.js';
import { chat, readLlmConfig, type LlmConfig } from './llm.js';
import { extractError, extractInvocation } from './trace.js';
import { normalizeKeyword, meaningfulTokens } from './keywords.js';
import { matchGenericLesson } from './lessons.js';
import type { BatchEpisode } from './prompts.js';
import { BATCH_DISTILL_PROMPT, buildBatchInput, parseBatchOutput } from './prompts.js';

/** Failures with no reuse value: the retry usually just works. */
const TRANSIENT =
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|rate.?limit|\b429\b|\b503\b|temporarily unavailable|network error|timed out|超时|网络|限流|请稍后/i;

const FILE_RE = /[\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|yml|yaml|toml|css|scss|html|vue|svelte)\b/g;
const ENV_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g;
const ARG_RE = /"(?:command|file_path|path|pattern|query|url|script)"\s*:\s*"((?:[^"\\]|\\.){2,200})"/g;

/** Pull up to `max` distinct, useful trigger keywords out of the two traces. */
export function extractKeywords(text: string, max = 8): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    const token = normalizeKeyword(raw);
    if (!token) return;
    if (found.some((f) => f.toLowerCase() === token.toLowerCase())) return;
    found.push(token);
  };

  // Commands contribute their meaningful words, not their first word (`cd`,
  // `sudo`), and not their flags.
  for (const m of text.matchAll(ARG_RE)) {
    if (!m[1]) continue;
    for (const token of meaningfulTokens(m[1], 2)) push(token);
  }
  for (const m of text.matchAll(FILE_RE)) if (m[0]) push(m[0]);
  for (const m of text.matchAll(ENV_RE)) if (m[0]) push(m[0]);

  return found.slice(0, max);
}

/** First meaningful line of a trace, cleaned for use as a symptom. */
function firstLine(trace: string, max = 80): string {
  const cleaned = trace
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * Whether a human message is worth storing as a hint.
 *
 * "继续" or "ok" is a turn, not an explanation — attaching it would become a
 * useless prescription ("do: continue"). Only substantive text qualifies.
 */
export function isSubstantiveHint(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 10) return false;
  if (/^(继续|好的|好|行|可以|ok|okay|yes|y|go on|continue|thanks|谢谢)[。.!！]?$/i.test(clean)) {
    return false;
  }
  return true;
}

/**
 * Deterministic fallback: build a rule straight from the failed and successful
 * invocations without calling a model.
 */
export function ruleDistill(
  toolName: string,
  failureTrace: string,
  successTrace: string,
  humanHint = '',
): DistillResult {
  if (TRANSIENT.test(failureTrace)) {
    return { ok: false, reason: 'skip', detail: 'transient failure' };
  }

  // NOTE: an identical retry (same invocation failing then succeeding) is a
  // LEARNABLE episode, not noise — the host's own acceptance flow
  // (scripts/verify-steps23.mjs) encodes exactly that shape, and a retried
  // command often hides a real lesson ("the file was created meanwhile").
  // A previous identical-retry gate here broke the acceptance flow and was
  // removed; transient *network-shaped* failures are still skipped above.

  const keywords = extractKeywords(`${failureTrace} ${successTrace}`);
  if (keywords.length === 0) {
    return { ok: false, reason: 'skip', detail: 'no reusable trigger found' };
  }

  // A trigger is a recall key, not a document: hard-cap it so one episode with
  // long absolute paths cannot dominate the injected block.
  const trigger = `${toolName} ${keywords.join(' ')}`.trim().slice(0, 160);

  // Symptom is the error itself; prescription is the invocation that worked.
  // Keeping these two clean is what makes the injected block readable.
  const error = extractError(failureTrace);
  const rawSymptom = error || firstLine(failureTrace, 80) || 'the first attempt failed';

  // A generic pitfall (edit conflicts, stale reads) is stored with a generic
  // trigger so every instance merges into one rule instead of one-per-file.
  const lesson = matchGenericLesson(rawSymptom);
  if (lesson) {
    return {
      ok: true,
      antibody: {
        trigger_pattern: lesson.trigger,
        symptom: lesson.symptom,
        prescription: lesson.prescription,
        tool_name: toolName,
      },
    };
  }

  const symptom = rawSymptom;

  const invocation = extractInvocation(successTrace);
  // A human explanation outranks anything inferred from the diff: they state
  // the rule ("this repo uses pnpm"), the traces only show what happened.
  const hint = isSubstantiveHint(humanHint) ? humanHint.trim() : '';
  const prescription = hint
    ? hint.slice(0, 200)
    : invocation
      ? `${toolName}: ${invocation}`
      : firstLine(successTrace, 120) || 'use the retried invocation that succeeded';

  return {
    ok: true,
    antibody: { trigger_pattern: trigger, symptom, prescription, tool_name: toolName },
  };
}

/**
 * Distil one episode into an antibody.
 *
 * Uses the configured model when available and silently degrades to the
 * deterministic rule when the model is missing, slow, or returns junk.
 */
export async function distillEpisode(
  toolName: string,
  failureTrace: string,
  successTrace: string,
  opts: { llm?: LlmConfig | null; signal?: AbortSignal; humanHint?: string } = {},
): Promise<DistillResult> {
  const hint = opts.humanHint ?? '';
  const fallback = (): DistillResult => ruleDistill(toolName, failureTrace, successTrace, hint);

  const llm = opts.llm === undefined ? readLlmConfig() : opts.llm;
  if (!llm) return fallback();

  try {
    const raw = await chat(
      llm,
      DISTILL_PROMPT,
      buildDistillInput(failureTrace, successTrace, hint),
      opts.signal,
    );
    const parsed = parseDistillOutput(raw, toolName);
    if (!parsed.ok) return fallback();

    // The model path is normalised with the same curated table, so both paths
    // converge on one generic rule per generic pitfall.
    const lesson = matchGenericLesson(parsed.antibody.symptom);
    if (!lesson) return parsed;
    return {
      ok: true,
      antibody: {
        trigger_pattern: lesson.trigger,
        symptom: lesson.symptom,
        prescription: lesson.prescription,
        tool_name: toolName,
      },
    };
  } catch {
    // Model unreachable or misconfigured: the rule-based path keeps the loop alive.
    return fallback();
  }
}

/** Apply the curated generic table to a model-produced rule. */
function normaliseLesson(
  result: DistillResult,
  toolName: string,
): DistillResult {
  if (!result.ok) return result;
  const lesson = matchGenericLesson(result.antibody.symptom);
  if (!lesson) return result;
  return {
    ok: true,
    antibody: {
      trigger_pattern: lesson.trigger,
      symptom: lesson.symptom,
      prescription: lesson.prescription,
      tool_name: toolName,
    },
  };
}

/**
 * Distil several episodes in ONE model request.
 *
 * The queue drains at turn end under a time budget, so the per-request latency
 * is what limits throughput: batching four episodes turns four round trips into
 * one. Everything that could go wrong degrades to the deterministic rule per
 * episode, so a malformed or partial batch never loses work.
 *
 * Returns a map keyed by episode id; every input id is present.
 */
export async function distillBatch(
  episodes: readonly BatchEpisode[],
  opts: { llm?: LlmConfig | null; signal?: AbortSignal } = {},
): Promise<Map<number, DistillResult>> {
  const results = new Map<number, DistillResult>();
  if (episodes.length === 0) return results;

  const perEpisode = async (): Promise<Map<number, DistillResult>> => {
    for (const episode of episodes) {
      results.set(
        episode.id,
        await distillEpisode(episode.toolName, episode.failedTrace, episode.fixedTrace, {
          llm: opts.llm,
          signal: opts.signal,
          humanHint: episode.humanHint ?? '',
        }),
      );
    }
    return results;
  };

  const llm = opts.llm === undefined ? readLlmConfig() : opts.llm;
  // One episode is not a batch: the single-episode prompt carries more context
  // per request, and it is the path the existing tests pin.
  if (!llm || episodes.length < 2) return perEpisode();

  try {
    const raw = await chat(llm, BATCH_DISTILL_PROMPT, buildBatchInput(episodes), opts.signal);
    const parsed = parseBatchOutput(raw, episodes.map((episode) => episode.id), 'batch');

    for (const episode of episodes) {
      const answer = parsed.get(episode.id);

      // The model declined: respect it.
      if (answer && !answer.ok && answer.reason === 'skip') {
        results.set(episode.id, answer);
        continue;
      }

      if (answer?.ok) {
        // The batch response carries ids, not tool names — re-stamp it, and let
        // the curated generic table normalise it exactly as the single path does.
        const stamped: DistillResult = {
          ok: true,
          antibody: { ...answer.antibody, tool_name: episode.toolName },
        };
        results.set(episode.id, normaliseLesson(stamped, episode.toolName));
        continue;
      }

      // Missing or malformed for this id: the deterministic rule fills the gap
      // so no queued episode is lost.
      results.set(
        episode.id,
        ruleDistill(episode.toolName, episode.failedTrace, episode.fixedTrace, episode.humanHint),
      );
    }
    return results;
  } catch {
    // Transport or parse failure: everything falls back to the rule path.
    return perEpisode();
  }
}
