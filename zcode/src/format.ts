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

/**
 * Render at most a handful of antibodies as an `<immune_memory>` block.
 *
 * Kept deliberately terse: this text is prepended to every matching turn, so
 * verbosity here is paid for on every request.
 */
export function formatImmuneContext(antibodies: Antibody[], maxChars = 1400): string {
  if (antibodies.length === 0) return '';
  const t = strings();
  const lines = antibodies.map(
    (ab, i) =>
      `${i + 1}. [${t.trigger}: ${sanitize(ab.trigger_pattern)}] ` +
      `${t.avoid}: ${sanitize(ab.symptom)} -> ${t.do}: ${sanitize(ab.prescription)}`,
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
    (ab, i) => `${i + 1}. ${sanitize(ab.symptom)} -> ${sanitize(ab.prescription)}`,
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
  let text: string;
  try {
    text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    text = String(detail);
  }
  return `${summarizeToolCall(
    typeof event.tool_name === 'string' ? event.tool_name : 'unknown-tool',
    event.tool_input,
  )} error=${text}`;
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
