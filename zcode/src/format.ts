/**
 * Formatting helpers for the ZCode adapter.
 *
 * Two jobs: render antibodies as a compact context block, and summarise tool
 * events into the short traces the distiller works from.
 */
import type { Antibody } from '../../core/types.js';
import { strings } from '../../core/i18n.js';

/** Neutralise angle brackets so antibody text cannot close the wrapper tag. */
function sanitize(value: string): string {
  return value.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Clamp one field so a single antibody cannot dominate the block. */
function clampField(value: string, max: number): string {
  const text = sanitize(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Strip tag characters so injected text cannot close or open the wrapper.
 * Distilled fields come from raw error traces and model output; a trace line
 * containing `</immune_memory>` (or prompt-injection markup) must not escape
 * the block. Same contract as the DSH side's sanitize(): the database keeps
 * the faithful text, the renderer guarantees the delimiter.
 */
function sanitizeField(value: string): string {
  return value.replace(/[<>]/g, ' ');
}

/**
 * Render at most a handful of antibodies as an `<immune_memory>` block.
 *
 * Each field is clamped individually AND the whole block is clamped: per-field
 * caps keep one bloated rule from consuming the whole budget, and the global
 * cap keeps three of them from doing it together.
 */
export function formatImmuneContext(antibodies: Antibody[], maxChars = 1200): string {
  if (antibodies.length === 0) return '';
  const t = strings();
  const lines = antibodies.map(
    (ab, i) =>
      `${i + 1}. [${t.trigger}: ${clampField(sanitizeField(ab.trigger_pattern), 80)}] ` +
      `${t.avoid}: ${clampField(sanitizeField(ab.symptom), 80)} -> ` +
      `${t.do}: ${clampField(sanitizeField(ab.prescription), 100)}`,
  );
  const body = lines.join('\n');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;

  return ['<immune_memory>', t.promptPreamble, clipped, '</immune_memory>'].join('\n');
}

/**
 * Render a just-in-time warning for PreToolUse.
 *
 * Tighter than the prompt-time block: this appears on the tool call itself, so
 * every extra word competes with the tool result the model is about to read.
 */
export function formatToolWarning(antibodies: Antibody[], maxChars = 700): string {
  if (antibodies.length === 0) return '';
  const t = strings();
  const lines = antibodies.map(
    (ab, i) =>
      `${i + 1}. ${clampField(sanitizeField(ab.symptom), 70)} -> ${clampField(sanitizeField(ab.prescription), 90)}`,
  );
  const body = lines.join('\n');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `<immune_memory>\n${t.toolPreamble}\n${clipped}\n</immune_memory>`;
}

/** Short, redactable description of a tool invocation. */
export function summarizeToolCall(toolName: string, toolInput: unknown): string {
  let input: string;
  try {
    input = JSON.stringify(toolInput ?? {});
  } catch {
    input = String(toolInput ?? '');
  }
  return `tool=${toolName} input=${input}`;
}

/** Describe a failure from a PostToolUseFailure event. */
export function summarizeFailure(event: Record<string, unknown>): string {
  const detail = event.error_details ?? event.error ?? 'unknown error';
  const text = errorTextOf(detail);
  return `${summarizeToolCall(
    typeof event.tool_name === 'string' ? event.tool_name : 'unknown-tool',
    event.tool_input,
  )} error=${text}`;
}

/**
 * Pull the real error text out of a failure payload.
 *
 * The runtime hands over a structured object for Bash failures —
 * `{stdout, stderr, interrupted, isImage}` — and stringifying the whole thing
 * buries the error under a JSON dump of successful output. Prefer stderr, then
 * a message field, then stringify as the last resort.
 */
function errorTextOf(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object' && detail !== null) {
    const obj = detail as Record<string, unknown>;
    for (const key of ['stderr', 'message', 'error', 'stdout']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * Describe a success from a PostToolUse event.
 *
 * Prefers the runtime's own preview when present, because `tool_response` is a
 * raw handler result whose shape differs per tool.
 */
export function summarizeSuccess(event: Record<string, unknown>): string {
  const preview = event.tool_result_preview ?? event.toolResponse ?? event.tool_response;
  let text: string;
  try {
    text = typeof preview === 'string' ? preview : JSON.stringify(preview ?? {});
  } catch {
    text = String(preview);
  }
  return `${summarizeToolCall(
    typeof event.tool_name === 'string' ? event.tool_name : 'unknown-tool',
    event.tool_input,
  )} result=${text}`;
}
