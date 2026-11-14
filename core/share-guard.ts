/**
 * ROADMAP 3.2 — the share gate and the CI gate.
 *
 * Two stateless checks, one file:
 *
 *  1. `shareSanityCheck` runs before ANY shareable artifact (SKILL.md export,
 *     packs) leaves the machine: a rule that still carries a machine path or a
 *     secret-shaped string must FAIL the export instead of shipping to the
 *     team. Redaction (#10) scrubs traces at capture time; this gate is the
 *     second line — it inspects the RULES themselves.
 *
 *  2. `ciCheck` scans PR-diff added lines against rules parsed from the repo's
 *     own AGENTS.md `<!-- immune:generated -->` block — stateless by design:
 *     CI has no immune database, but it has the committed managed section.
 */
import { readFileSync, existsSync } from 'node:fs';
import { redact, redactEmails } from './redact.js';
import { signals } from './relevance.js';
import { SECTION_START, SECTION_END } from './sync-doc.js';

/** Machine paths that must never leave the machine. */
const MACHINE_PATH =
  /(?:(?<![A-Za-z])[A-Za-z]:[\\/](?![\\/])[^\s|'"<>]{1,120}|(?<![:\\A-Za-z0-9])\\\\[A-Za-z0-9._-]{2,}\\[^\s|'"<>]{1,120}|\/home\/[^\s|'"<>]{1,120}|\/Users\/[^\s|'"<>]{1,120}|\/root\/[^\s|'"<>]{1,120})/;

const TOOL_NAMES = new Set(['bash', 'edit', 'write', 'read', 'multiedit', 'notebookedit', 'grep', 'glob']);

export type ShareViolationKind = 'machine-path' | 'secret-shaped' | 'email';

export interface ShareViolation {
  /** Rule index in the export set (1-based, matches the rendered row order). */
  rule: number;
  field: string;
  kind: ShareViolationKind;
  /** The offending snippet, itself redacted before display. */
  sample: string;
}

/**
 * Inspect the rules destined for a shareable artifact. The FIRST violation is
 * enough to stop the export; the list lets the operator fix everything at once.
 */
export function shareSanityCheck(
  rules: ReadonlyArray<
    Pick<AntibodyFields, 'trigger_pattern' | 'symptom' | 'prescription'> & { repair_path?: string[] }
  >,
): ShareViolation[] {
  const out: ShareViolation[] = [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    const candidates: Array<[string, string]> = [
      ['trigger_pattern', String(rule.trigger_pattern ?? '')],
      ['symptom', String(rule.symptom ?? '')],
      ['prescription', String(rule.prescription ?? '')],
    ];
    if (Array.isArray(rule.repair_path) && rule.repair_path.length > 0) {
      candidates.push(['repair_path', rule.repair_path.join(' | ')]);
    }
    for (const [field, text] of candidates) {
      const pathMatch = text.match(MACHINE_PATH);
      if (pathMatch) {
        out.push({ rule: index + 1, field, kind: 'machine-path', sample: redact(pathMatch[0]) });
        continue;
      }
      if (redact(text) !== text) {
        out.push({ rule: index + 1, field, kind: 'secret-shaped', sample: redact(text).slice(0, 60) });
        continue;
      }
      if (redactEmails(text) !== text) {
        out.push({ rule: index + 1, field, kind: 'email', sample: redactEmails(text).slice(0, 60) });
      }
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** Consistent human-readable summary shared by every blocked export path. */
export function formatShareViolations(violations: ReadonlyArray<ShareViolation>): string {
  const lines = ['export blocked by the share gate:'];
  for (const violation of violations) {
    lines.push(`  rule ${violation.rule} ${violation.field}: ${violation.kind} — "${violation.sample}"`);
  }
  lines.push('fix or forget those rules, then re-export');
  return lines.join('\n');
}

/** Minimal rule shape the AGENTS.md block parser needs. */
interface AntibodyFields {
  trigger_pattern: string;
  symptom: string;
  prescription: string;
}

/**
 * Parse the rules a repository committed into its managed AGENTS.md section.
 * The block is fully replaced on every sync (sync-doc.ts), so the parse is
 * stable; a missing block is an EMPTY rule set, not an error.
 */
export function parseManagedBlock(docPath: string): Array<AntibodyFields> {
  if (!existsSync(docPath)) return [];
  let text = '';
  try {
    text = readFileSync(docPath, 'utf8');
  } catch {
    return [];
  }
  const start = text.indexOf(SECTION_START);
  const end = text.indexOf(SECTION_END);
  if (start < 0 || end <= start) return [];
  const body = text.slice(start + SECTION_START.length, end);
  // The generated format is three lines per rule:
  //   - **<trigger>**
  //     - 忌/avoid: <symptom>
  //     - 宜/do: <prescription>
  const rules: Array<AntibodyFields> = [];
  let current: { trigger: string; avoid: string } | null = null;
  for (const line of body.split('\n')) {
    const triggerLine = line.match(/^\s*-\s*\*\*(.+?)\*\*\s*$/);
    if (triggerLine) {
      if (current) rules.push({ trigger_pattern: current.trigger, symptom: current.avoid, prescription: '' });
      current = { trigger: triggerLine[1] ?? '', avoid: '' };
      continue;
    }
    const avoidLine = line.match(/^\s*-\s*忌\/avoid:\s*(.*)$/);
    if (avoidLine && current) {
      current.avoid = avoidLine[1] ?? '';
      continue;
    }
    const doLine = line.match(/^\s*-\s*宜\/do:\s*(.*)$/);
    if (doLine && current) {
      rules.push({ trigger_pattern: current.trigger, symptom: current.avoid, prescription: doLine[1] ?? '' });
      current = null;
    }
  }
  if (current) rules.push({ trigger_pattern: current.trigger, symptom: current.avoid, prescription: '' });
  return rules.filter((rule) => rule.trigger_pattern.length > 0);
}

export interface CiCheckReport {
  addedLines: number;
  rulesConsidered: number;
  findings: Array<{ line: number; text: string; trigger: string }>;
}

/**
 * Scan diff added lines against the managed-block rules. A finding is an
 * advisory: the trigger text (a recall key) appearing in an ADDED line means
 * the pitfall's territory was just touched — worth a look before push.
 *
 * `diffText` is the raw `git diff` output; only + lines are considered.
 */
export function ciCheck(diffText: string, rules: ReadonlyArray<AntibodyFields>): CiCheckReport {
  const added: Array<{ line: number; text: string }> = [];
  let lineNo = 0;
  for (const line of diffText.split('\n')) {
    lineNo += 1;
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1).trim();
    if (text.length < 3) continue;
    added.push({ line: lineNo, text });
  }
  const findings: CiCheckReport['findings'] = [];
  for (const addedLine of added) {
    for (const rule of rules) {
      const tokens = [...signals(rule.trigger_pattern ?? '')].filter((token) => !TOOL_NAMES.has(token));
      if (tokens.length === 0) continue;
      const lower = addedLine.text.toLowerCase();
      // One distinctive token in an added line is enough to name the territory.
      if (tokens.some((token) => lower.includes(token))) {
        findings.push({ line: addedLine.line, text: addedLine.text.slice(0, 120), trigger: rule.trigger_pattern.slice(0, 80) });
        break;
      }
    }
  }
  return { addedLines: added.length, rulesConsidered: rules.length, findings };
}
