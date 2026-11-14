import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  detectProjectBaseline,
  filterRulesByBaseline,
  inferRuleBaseline,
  type BaselineLevel,
} from './baseline.js';
import type { SeedPackRule } from './packs.js';
import { redact, redactOutbound } from './redact.js';
import type { ImmuneStore } from './store/index.js';

export interface ParsedSkillDocument {
  frontmatterName?: string;
  rules: SeedPackRule[];
  skippedTooShort: number;
}

export interface SkillIngestOptions {
  pack?: string;
  cwd?: string;
  baseline?: BaselineLevel;
}

export interface SkillIngestReport {
  packId: string;
  filesRead: number;
  parsed: number;
  baselineFiltered: number;
  baseline: BaselineLevel;
  inserted: number;
  alreadySeeded: number;
  skippedTooShort: number;
}

const BOILERPLATE_HEADINGS = new Set([
  'table of contents',
  'toc',
  'license',
  'mit license',
  'contributing',
  'acknowledgements',
  'acknowledgments',
  'changelog',
  'references',
  'links',
  'resources',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo']);
const MAX_SKILL_FILES = 200;

function sanitizeText(raw: string, maxLen: number): string {
  const scrubbed = redact(redactOutbound(raw))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (scrubbed.length <= maxLen) return scrubbed;
  return `${scrubbed.slice(0, maxLen - 1).trimEnd()}…`;
}

export function normalizeSkillPackId(rawName: string): string {
  const stripped = rawName.trim().replace(/^skill:/i, '');
  const slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `skill:${slug || 'external'}`;
}

function stripFrontmatter(raw: string): { body: string; name?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { body: raw };
  const fm = match[1] ?? '';
  const nameMatch = /^name\s*:\s*['"]?([^\r\n'"]+)['"]?/im.exec(fm);
  return {
    body: match[2] ?? '',
    name: nameMatch?.[1]?.trim(),
  };
}

function stripFencedCodeBlocks(md: string): string {
  return md.replace(/```[\s\S]*?```/g, ' ');
}

function extractInlineTokens(text: string): string[] {
  const backticks: string[] = [];
  const re = /`([^`]{2,48})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) backticks.push(m[1].trim());
  }
  const words = text
    .replace(/`[^`]+`/g, ' ')
    .replace(/[*_~#>|]/g, ' ')
    .split(/[\s,.;:!?()[\]{}"'\/\\]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of [...backticks, ...words]) {
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
    if (out.length >= 14) break;
  }
  return out;
}

function normalizeTrigger(heading: string, extraText: string): string {
  const tokens = extractInlineTokens(`${heading} ${extraText}`);
  return sanitizeText(tokens.join(' '), 160);
}

function parseLabeledValue(lines: string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const clean = line.replace(/^\s*[-*+]\s+/, '').trim();
    const match = pattern.exec(clean);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function parseToolHint(lines: string[]): string | null {
  const raw = parseLabeledValue(lines, /^\*{0,2}(?:tool|tools)\*{0,2}\s*[:：]\s*(.+)$/i);
  if (!raw) return null;
  const first = raw.split(/[\s,|/]+/).find(Boolean);
  if (!first) return null;
  if (/^(bash|edit|write|read|multiedit)$/i.test(first)) {
    const head = first[0];
    if (!head) return null;
    return head.toUpperCase() + first.slice(1).toLowerCase();
  }
  return null;
}

function buildRuleFromFields(opts: {
  heading: string;
  symptomRaw: string;
  prescriptionRaw: string;
  baselineSource: string;
  toolName?: string | null;
}): SeedPackRule | null {
  const trigger = normalizeTrigger(opts.heading, `${opts.symptomRaw} ${opts.prescriptionRaw}`);
  const symptom = sanitizeText(opts.symptomRaw, 260);
  const prescription = sanitizeText(opts.prescriptionRaw, 380);
  if (trigger.length < 8 || symptom.length < 8 || prescription.length < 10) return null;
  return {
    tool_name: opts.toolName ?? null,
    baseline: inferRuleBaseline(opts.baselineSource),
    trigger_pattern: trigger,
    symptom,
    prescription,
  };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.replace(/`/g, '').trim());
}

function extractTableRules(heading: string, lines: string[]): SeedPackRule[] {
  const rules: SeedPackRule[] = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const rawHeader = lines[i];
    const rawSep = lines[i + 1];
    if (!rawHeader || !rawSep) continue;
    const headerLine = rawHeader.trim();
    const sepLine = rawSep.trim();
    if (!headerLine.startsWith('|') || !/^\|?[\s:|-]+\|[\s:|-]*$/.test(sepLine)) continue;
    const headers = splitMarkdownTableRow(headerLine).map((h) => h.toLowerCase());
    const avoidIdx = headers.findIndex((h) =>
      /(avoid|legacy|instead|old|anti|problem|don'?t|避免|旧|问题)/.test(h),
    );
    const useIdx = headers.findIndex((h) =>
      /(prefer|modern|use|fix|recommend|solution|api|推荐|现代|建议|方案)/.test(h),
    );
    const baseIdx = headers.findIndex((h) => /(baseline|support|compat|基线)/.test(h));
    if (useIdx < 0 || (avoidIdx < 0 && headers.length < 2)) continue;
    const fallbackAvoid = avoidIdx >= 0 ? avoidIdx : useIdx === 0 ? 1 : 0;
    let r = i + 2;
    while (r < lines.length) {
      const rowLine = lines[r];
      if (!rowLine || !rowLine.trim().startsWith('|')) break;
      const cells = splitMarkdownTableRow(rowLine);
      const avoid = cells[fallbackAvoid] ?? '';
      const use = cells[useIdx] ?? '';
      const baselineCell = baseIdx >= 0 ? cells[baseIdx] ?? '' : '';
      if (avoid && use) {
        const rule = buildRuleFromFields({
          heading: `${heading} ${avoid}`,
          symptomRaw: avoid,
          prescriptionRaw: use,
          baselineSource: `${heading} ${avoid} ${use} ${baselineCell}`,
        });
        if (rule) rules.push(rule);
      }
      r++;
    }
    i = r - 1;
  }
  return rules;
}

function extractSectionRule(heading: string, rawLines: string[]): SeedPackRule | null {
  const cleanText = stripFencedCodeBlocks(rawLines.join('\n'));
  const lines = cleanText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('|') && !/^<!--/.test(l));

  const avoid = parseLabeledValue(
    lines,
    /^\*{0,2}(?:avoid|don'?t|incorrect|anti-?pattern|problem|symptom|避免|反模式|问题)\*{0,2}\s*[:：]\s*(.+)$/i,
  );
  const prefer = parseLabeledValue(
    lines,
    /^\*{0,2}(?:prefer|use|do|correct|prescription|recommendation|fix|solution|推荐|使用|建议|修复)\*{0,2}\s*[:：]\s*(.+)$/i,
  );
  const baselineNote = parseLabeledValue(
    lines,
    /^\*{0,2}(?:baseline|support|compatibility|基线)\*{0,2}\s*[:：]\s*(.+)$/i,
  );
  const toolName = parseToolHint(lines);

  if (prefer) {
    const symptomRaw = avoid ?? `关于 ${heading} 的常见误区或旧写法`;
    return buildRuleFromFields({
      heading,
      symptomRaw,
      prescriptionRaw: prefer,
      baselineSource: `${heading} ${baselineNote ?? ''} ${avoid ?? ''} ${prefer}`,
      toolName,
    });
  }

  // Fallback for sections without explicit Avoid/Prefer labels: pair first two non-trivial lines
  // or treat heading as symptom context and concise body summary as prescription.
  const sentences = lines
    .map((l) => l.replace(/^[-*+]\s+/, '').trim())
    .filter((l) => l.length >= 16);
  if (sentences.length === 0) return null;

  const summary = sentences.slice(0, 2).join('；');
  const symptomRaw = avoid ?? `实现「${heading}」时容易忽略现代最佳实践`;
  return buildRuleFromFields({
    heading,
    symptomRaw,
    prescriptionRaw: summary,
    baselineSource: `${heading} ${baselineNote ?? ''} ${summary}`,
    toolName,
  });
}

function extractBulletGuidanceRules(heading: string, rawLines: string[]): SeedPackRule[] {
  const cleanText = stripFencedCodeBlocks(rawLines.join('\n'));
  const rules: SeedPackRule[] = [];
  for (const rawLine of cleanText.split(/\r?\n/)) {
    const bullet = /^\s*[-*+]\s+\*{0,2}([^:*—–\n]{3,60})\*{0,2}\s*[:：—–-]\s*(.{16,})$/.exec(
      rawLine,
    );
    if (!bullet) continue;
    const topic = bullet[1]?.trim();
    const guidance = bullet[2]?.trim();
    if (!topic || !guidance) continue;
    if (/^(avoid|don'?t|prefer|use|do|tool|baseline|note)$/i.test(topic)) continue;
    const rule = buildRuleFromFields({
      heading: `${heading} ${topic}`,
      symptomRaw: `处理 ${topic} 时避免手写易错旧方案`,
      prescriptionRaw: guidance,
      baselineSource: `${heading} ${topic} ${guidance}`,
    });
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Parse external Markdown guidance (SKILL.md, cheat sheets, rulebooks) into
 * compact FTS5-indexable SeedPackRule entries with zero runtime LLM calls.
 */
export function parseSkillMarkdown(markdown: string, defaultTitle = 'guidance'): ParsedSkillDocument {
  const { body, name } = stripFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const rules: SeedPackRule[] = [];
  const seenPrescriptions = new Set<string>();
  let skippedTooShort = 0;

  let currentHeading = defaultTitle;
  let sectionLines: string[] = [];
  let inFence = false;

  const pushRule = (rule: SeedPackRule | null) => {
    if (!rule) {
      skippedTooShort++;
      return;
    }
    const key = rule.prescription.toLowerCase();
    if (seenPrescriptions.has(key)) return;
    seenPrescriptions.add(key);
    rules.push(rule);
  };

  const flushSection = () => {
    if (sectionLines.length === 0) return;
    if (BOILERPLATE_HEADINGS.has(currentHeading.toLowerCase())) return;
    const tableRules = extractTableRules(currentHeading, sectionLines);
    if (tableRules.length > 0) {
      for (const r of tableRules) pushRule(r);
      return;
    }
    const bulletRules = extractBulletGuidanceRules(currentHeading, sectionLines);
    const labeledPrefer = parseLabeledValue(
      sectionLines,
      /^\*{0,2}(?:prefer|use|do|correct|prescription|recommendation|fix|solution|推荐|使用|建议|修复)\*{0,2}\s*[:：]\s*(.+)$/i,
    );
    if (bulletRules.length >= 2 && !labeledPrefer) {
      for (const r of bulletRules) pushRule(r);
      return;
    }
    const sectionRule = extractSectionRule(currentHeading, sectionLines);
    if (sectionRule) {
      pushRule(sectionRule);
    } else if (sectionLines.some((l) => l.trim().length > 0)) {
      skippedTooShort++;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      sectionLines.push(line);
      continue;
    }
    if (!inFence) {
      const hMatch = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
      const nextHeading = hMatch?.[2]?.trim();
      if (nextHeading) {
        flushSection();
        currentHeading = nextHeading;
        sectionLines = [];
        continue;
      }
    }
    sectionLines.push(line);
  }
  flushSection();

  return {
    frontmatterName: name,
    rules,
    skippedTooShort,
  };
}

function collectMarkdownFiles(inputs: string[], cwd: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  const walk = (targetPath: string) => {
    if (files.length >= MAX_SKILL_FILES) return;
    const resolved = resolve(cwd, targetPath);
    if (seen.has(resolved) || !existsSync(resolved)) return;
    seen.add(resolved);
    let st;
    try {
      st = statSync(resolved);
    } catch {
      return;
    }
    if (st.isFile()) {
      const ext = extname(resolved).toLowerCase();
      if (ext === '.md' || ext === '.mdx' || ext === '.txt') files.push(resolved);
      return;
    }
    if (!st.isDirectory()) return;
    let entries;
    try {
      entries = readdirSync(resolved, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SKILL_FILES) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(resolved, entry.name));
    }
  };

  for (const input of inputs) walk(input);
  return files;
}

/**
 * Ingest Markdown skill/guidance files or directories into FTS5-indexed seed rules
 * under a named `skill:<slug>` pack, filtered by project Baseline.
 */
export function ingestSkillPaths(
  store: ImmuneStore,
  inputs: string[],
  opts: SkillIngestOptions = {},
): SkillIngestReport {
  const cwd = opts.cwd ?? process.cwd();
  const files = collectMarkdownFiles(inputs, cwd);
  const baseline = opts.baseline ?? detectProjectBaseline(cwd);

  const allParsed: SeedPackRule[] = [];
  const seenPrescriptions = new Set<string>();
  let detectedName: string | undefined;
  let skippedTooShort = 0;

  for (const filePath of files) {
    const raw = readFileSync(filePath, 'utf8');
    const title = basename(filePath, extname(filePath));
    const doc = parseSkillMarkdown(raw, title);
    if (!detectedName && doc.frontmatterName) detectedName = doc.frontmatterName;
    skippedTooShort += doc.skippedTooShort;
    for (const rule of doc.rules) {
      const key = rule.prescription.toLowerCase();
      if (seenPrescriptions.has(key)) continue;
      seenPrescriptions.add(key);
      allParsed.push(rule);
    }
  }

  const fallbackName =
    opts.pack ??
    detectedName ??
    (inputs[0] ? basename(resolve(cwd, inputs[0]), extname(inputs[0])) : 'external');
  const packId = normalizeSkillPackId(fallbackName);
  const compatible = filterRulesByBaseline(allParsed, baseline);
  const baselineFiltered = allParsed.length - compatible.length;
  const installed = compatible.length > 0 ? store.seedPack(packId, compatible) : { inserted: 0, alreadySeeded: 0 };

  return {
    packId,
    filesRead: files.length,
    parsed: allParsed.length,
    baselineFiltered,
    baseline,
    inserted: installed.inserted,
    alreadySeeded: installed.alreadySeeded,
    skippedTooShort,
  };
}
