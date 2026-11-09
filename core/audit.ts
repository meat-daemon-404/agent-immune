/**
 * `immune audit` — a health check over the history you already have.
 *
 * Cold start is the problem this solves: a fresh install has an empty
 * library and nothing to show. Every supported host keeps its history on
 * disk, and the failed-then-fixed episodes inside it are exactly what the
 * live pairing loop would have caught. The audit replays the same pairing
 * (core/backfill.ts's pairSession) over that history, reports per-tool
 * failure counts, top repeat offenders and the avoidable token cost when a
 * token median is available, then enqueues the episodes for distillation.
 *
 * Source status is reported honestly: the ZCode db and Codex rollout formats
 * were verified against real files; the Claude Code transcript parser is
 * fixture-tested only (no real transcripts existed on the dev machine).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BACKFILL_TOOLS, type CallRow, loadCalls, loadParts, pairSession } from './backfill.js';
import { isSelfEpisode } from './selfnoise.js';
import { redactAndClamp } from './redact.js';
import type { ImmuneStore } from './store/index.js';

export interface AuditOptions {
  /** Look back this many days (default 30 — an audit is recent history). */
  days?: number;
  sourceDb?: string;
  /** Override ~/.claude/projects (tests). */
  claudeProjectsDir?: string;
  /** Override ~/.codex/sessions (tests). */
  codexSessionsDir?: string;
  /** Restrict to one source; default scans every source found on disk. */
  source?: 'auto' | 'zcode' | 'codex' | 'claude-code';
  /** Cap enqueued episodes (quota guard for slow LLM channels). */
  max?: number;
  /** Report only — nothing enqueued, nothing distilled (--dry-run). */
  dryRun?: boolean;
  selfMarkers?: string[];
}

export interface AuditToolStat {
  tool: string;
  scanned: number;
  failures: number;
  paired: number;
}

export interface AuditFailureFamily {
  tool: string;
  error: string;
  count: number;
}

export interface AuditSourceReport {
  source: 'zcode' | 'codex' | 'claude-code';
  present: boolean;
  note?: string;
  scanned: number;
  failures: number;
  paired: number;
  superseded: number;
  enqueued: number;
  skippedSelf: number;
  byTool: AuditToolStat[];
  topFailures: AuditFailureFamily[];
  medianRequestTokens: number | null;
  medianSamples: number;
}

export interface AuditReport {
  sources: AuditSourceReport[];
  totals: {
    scanned: number;
    failures: number;
    paired: number;
    enqueued: number;
    skippedSelf: number;
  };
}

/** Trace strings are clamped before redaction, like the live loop. */
const TRACE_CLAMP = 1_200;
const TOP_FAMILIES = 5;
/** A family is only reportable when it repeated. */
const MIN_FAMILY_COUNT = 2;
/** Median needs enough of a distribution to mean anything (value.ts's bar). */
const MIN_TOKEN_SAMPLES = 30;

interface Session {
  calls: CallRow[];
  parts: Map<string, { input: unknown; output: string }>;
  /** Per-request token totals, when the source records usage. */
  tokenSamples: number[];
}

function clampText(text: string, max = 2_000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function medianOf(values: number[]): { median: number; samples: number } | null {
  if (values.length < MIN_TOKEN_SAMPLES) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return Number.isFinite(median) && median > 0
    ? { median: Math.round(median), samples: sorted.length }
    : null;
}

function emptySource(source: AuditSourceReport['source'], note?: string): AuditSourceReport {
  return {
    source,
    present: false,
    ...(note !== undefined ? { note } : {}),
    scanned: 0,
    failures: 0,
    paired: 0,
    superseded: 0,
    enqueued: 0,
    skippedSelf: 0,
    byTool: [],
    topFailures: [],
    medianRequestTokens: null,
    medianSamples: 0,
  };
}

/**
 * Replay the pairing loop over one source's sessions and fold the results
 * into a per-source report. The emit path mirrors core/backfill.ts's enqueue
 * (redact -> self-noise gate -> enqueueJob), so a rule distilled from `audit`
 * is indistinguishable from one distilled live.
 */
function runSource(
  source: AuditSourceReport['source'],
  sessions: Session[],
  store: ImmuneStore,
  opts: { cap: number | null; dryRun: boolean; selfMarkers: string[] },
): AuditSourceReport {
  const report = emptySource(source);
  report.present = true;
  const toolIndex = new Map<string, AuditToolStat>();
  const families = new Map<string, AuditFailureFamily>();

  const bumpTool = (tool: string): AuditToolStat => {
    const existing = toolIndex.get(tool);
    if (existing) return existing;
    const created: AuditToolStat = { tool, scanned: 0, failures: 0, paired: 0 };
    toolIndex.set(tool, created);
    return created;
  };

  for (const session of sessions) {
    const stats = pairSession(session.calls, session.parts, (fail, success, repairs) => {
      // Quota guard, same as backfill: a slow LLM channel needs an explicit cap.
      if (opts.cap !== null && report.enqueued >= opts.cap) return;
      const failPart = session.parts.get(fail.tool_call_id);
      const successPart = session.parts.get(success.tool_call_id);
      const failureTrace = redactAndClamp(
        `tool=${fail.tool_name} input=${JSON.stringify(failPart?.input ?? {})} error=${fail.error_message ?? 'unknown'}`,
        TRACE_CLAMP,
      );
      const successTrace = redactAndClamp(
        `tool=${success.tool_name} input=${JSON.stringify(successPart?.input ?? {})} result=ok`,
        TRACE_CLAMP,
      );
      if (isSelfEpisode(`${failureTrace} ${successTrace}`, opts.selfMarkers)) {
        report.skippedSelf += 1;
        return;
      }
      // In dry-run the episode is counted as "would be enqueued" but not stored.
      if (!opts.dryRun) {
        store.enqueueJob(success.tool_name, failureTrace, successTrace, [], '', repairs);
      }
      report.enqueued += 1;
      bumpTool(success.tool_name).paired += 1;
    });
    report.scanned += session.calls.length;
    report.failures += stats.failures;
    report.paired += stats.paired;
    report.superseded += stats.superseded;

    for (const call of session.calls) {
      // Same filter the pairing loop applies: protocol/MCP tools are out of
      // scope for rules, so they are out of scope for the stats too.
      if (!BACKFILL_TOOLS.has(call.tool_name)) continue;
      const stat = bumpTool(call.tool_name);
      stat.scanned += 1;
      if (call.status !== 'error') continue;
      stat.failures += 1;
      const firstLine = (call.error_message ?? 'unknown').split('\n')[0] ?? 'unknown';
      const normalized = firstLine.replace(/\s+/g, ' ').trim();
      const key = `${call.tool_name}|${normalized.toLowerCase().slice(0, 80)}`;
      const family = families.get(key);
      if (family) family.count += 1;
      else families.set(key, { tool: call.tool_name, error: normalized.slice(0, 80), count: 1 });
    }
  }

  report.byTool = [...toolIndex.values()].sort(
    (a, b) => b.failures - a.failures || b.scanned - a.scanned,
  );
  report.topFailures = [...families.values()]
    .filter((family) => family.count >= MIN_FAMILY_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_FAMILIES);
  return report;
}

/**
 * ZCode source: the session database's tool_usage + part tables, through the
 * exact loaders core/backfill.ts uses. Format verified against a real db.
 */
function loadZcodeSessions(sourceDb: string, since: number): Session[] {
  const db = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    const calls = loadCalls(db, since);
    const parts = loadParts(db, [...new Set(calls.map((call) => call.session_id))]);
    const sessions = new Map<string, Session>();
    for (const call of calls) {
      const bucket = sessions.get(call.session_id) ?? { calls: [], parts, tokenSamples: [] };
      bucket.calls.push(call);
      sessions.set(call.session_id, bucket);
    }
    return [...sessions.values()];
  } finally {
    db.close();
  }
}

/** ZCode's model_usage rows give the token median for its own source. */
function zcodeTokenMedian(sourceDb: string): { median: number; samples: number } | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(sourceDb, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT computed_total_tokens AS t FROM model_usage
          WHERE status = 'completed' AND computed_total_tokens > 0
          ORDER BY started_at DESC LIMIT 500`,
      )
      .all() as Array<{ t: number }>;
    return medianOf(rows.map((row) => Number(row.t)));
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only probe; a failed close is not worth an exception.
    }
  }
}

/**
 * Codex source: rollout files under ~/.codex/sessions/YYYY/MM/DD/. Format
 * verified against real rollouts: `response_item` payloads carry
 * function_call {call_id, name, arguments} and function_call_output
 * {call_id, output}, and shell output begins "Exit code: N".
 */
const CODEX_TOOL_MAP: Record<string, string> = {
  shell_command: 'Bash',
  exec_command: 'Bash',
  shell: 'Bash',
  local_shell: 'Bash',
  apply_patch: 'Edit',
};

/** Shell output starts "Exit code: N" — the same verdict the judge reads. */
function codexStatusOf(output: string): { status: 'completed' | 'error'; error?: string } {
  const match = output.match(/^Exit code: (\d+)/);
  if (!match) return { status: 'completed' };
  return Number(match[1]) === 0 ? { status: 'completed' } : { status: 'error', error: clampText(output) };
}

function loadCodexSessions(dir: string, since: number): { sessions: Session[]; present: boolean; note?: string } {
  if (!existsSync(dir)) return { sessions: [], present: false, note: 'no ~/.codex/sessions directory' };
  const sessions: Session[] = [];
  // sessions/YYYY/MM/DD/rollout-*.jsonl — the path carries the date, so
  // day directories older than `since` are pruned without opening any file.
  for (const year of readdirSync(dir)) {
    for (const month of readdirSync(join(dir, year))) {
      for (const day of readdirSync(join(dir, year, month))) {
        const dayMs = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
        if (Number.isFinite(dayMs) && dayMs < since - 86_400_000) continue;
        const dayDir = join(dir, year, month, day);
        for (const file of readdirSync(dayDir)) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
          const parsed = parseCodexFile(join(dayDir, file));
          if (parsed.calls.length > 0) sessions.push(parsed);
        }
      }
    }
  }
  return { sessions, present: true, ...(sessions.length === 0 ? { note: 'no tool calls in rollouts' } : {}) };
}

function parseCodexFile(path: string): Session {
  const calls: CallRow[] = [];
  const parts = new Map<string, { input: unknown; output: string }>();
  const callIndex = new Map<string, { name: string; arguments: string; timestamp: number }>();
  let lines: string[] = [];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return { calls, parts, tokenSamples: [] };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: {
      timestamp?: string;
      type?: string;
      payload?: { type?: string; call_id?: string; name?: string; arguments?: string; output?: string };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A partial trailing line is normal for an active file.
    }
    if (record.type !== 'response_item' || !record.payload) continue;
    const payload = record.payload;
    const timestamp = record.timestamp ? Date.parse(record.timestamp) : Date.now();
    if (payload.type === 'function_call' && payload.call_id) {
      callIndex.set(payload.call_id, {
        name: payload.name ?? 'unknown',
        arguments: payload.arguments ?? '',
        timestamp,
      });
    } else if (payload.type === 'function_call_output' && payload.call_id) {
      const call = callIndex.get(payload.call_id);
      if (!call) continue;
      const tool = CODEX_TOOL_MAP[call.name] ?? null;
      if (!tool) continue; // Unmapped protocol tools are out of scope.
      const output = typeof payload.output === 'string' ? payload.output : '';
      const verdict = codexStatusOf(output);
      const input = safeJson(call.arguments);
      calls.push({
        session_id: path,
        tool_call_id: payload.call_id,
        tool_name: tool,
        status: verdict.status,
        error_message: verdict.error ?? null,
        started_at: call.timestamp,
      });
      parts.set(payload.call_id, { input, output: clampText(output) });
    }
  }
  calls.sort((a, b) => a.started_at - b.started_at);
  return { calls, parts, tokenSamples: [] };
}

/**
 * Claude Code source: transcripts under ~/.claude/projects/<project>/*.jsonl.
 * Assistant lines carry tool_use blocks; user lines carry tool_result blocks
 * with is_error. FIXTURE-TESTED ONLY — no real transcripts existed on the dev
 * machine, and the parser refuses nothing it should not read.
 */
function loadClaudeSessions(dir: string, since: number): { sessions: Session[]; present: boolean; note?: string } {
  if (!existsSync(dir)) return { sessions: [], present: false, note: 'no ~/.claude/projects directory' };
  const sessions: Session[] = [];
  for (const project of readdirSync(dir)) {
    const projectDir = join(dir, project);
    let files: string[] = [];
    try {
      files = readdirSync(projectDir).filter((file) => file.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const parsed = parseClaudeFile(join(projectDir, file), since);
      if (parsed.calls.length > 0) sessions.push(parsed);
    }
  }
  return { sessions, present: true, ...(sessions.length === 0 ? { note: 'no tool calls in transcripts' } : {}) };
}

function parseClaudeFile(path: string, since: number): Session {
  const calls: CallRow[] = [];
  const callById = new Map<string, CallRow>();
  const parts = new Map<string, { input: unknown; output: string }>();
  const tokenSamples: number[] = [];
  let lines: string[] = [];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return { calls, parts, tokenSamples };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: {
      type?: string;
      timestamp?: string;
      message?: {
        content?: unknown;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Usage rides on assistant messages — the per-request token sample.
    if (record.type === 'assistant' && record.message?.usage) {
      const total = Number(record.message.usage.input_tokens ?? 0) + Number(record.message.usage.output_tokens ?? 0);
      if (total > 0) tokenSamples.push(total);
    }
    const timestamp = record.timestamp ? Date.parse(record.timestamp) : Date.now();
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        calls.push({
          session_id: path,
          tool_call_id: block.id,
          tool_name: String(block.name ?? 'unknown'),
          status: 'completed', // The verdict arrives with the tool_result.
          error_message: null,
          started_at: timestamp,
        });
        parts.set(block.id, { input: block.input ?? null, output: '' });
        callById.set(block.id, calls[calls.length - 1]!);
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const text = claudeResultText(block.content);
        const call = callById.get(block.tool_use_id);
        if (call) {
          call.status = block.is_error === true ? 'error' : 'completed';
          call.error_message = block.is_error === true ? clampText(text) : null;
          call.started_at = timestamp;
          call.session_id = path;
        }
        const part = parts.get(block.tool_use_id);
        if (part) part.output = clampText(text);
      }
    }
  }
  calls.sort((a, b) => a.started_at - b.started_at);
  // Transcripts older than the audit window contribute nothing to pairing and
  // are dropped after parsing (the parser needs the whole file to pair).
  const inWindow = calls.filter((call) => call.started_at >= since);
  return { calls: inWindow, parts, tokenSamples };
}

function claudeResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' && block !== null && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Scan every available source, replay pairing over its sessions, and enqueue
 * episodes for distillation (unless dryRun). Sources absent from this machine
 * are reported as absent rather than skipped silently.
 */
export function auditHistory(store: ImmuneStore, opts: AuditOptions = {}): AuditReport {
  const days = opts.days ?? 30;
  const since = Date.now() - days * 86_400_000;
  const cap =
    opts.max !== undefined && Number.isFinite(opts.max) && opts.max > 0 ? Math.trunc(opts.max) : null;
  const selfMarkers = opts.selfMarkers ?? [];
  const wanted = opts.source ?? 'auto';
  const dryRun = opts.dryRun === true;

  const zcodeDb = opts.sourceDb ?? `${homedir()}/.zcode/cli/db/db.sqlite`.replace(/\\/g, '/');
  const codexDir = opts.codexSessionsDir ?? join(homedir(), '.codex', 'sessions');
  const claudeDir = opts.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
  const sources: AuditSourceReport[] = [];

  if (wanted === 'auto' || wanted === 'zcode') {
    if (existsSync(zcodeDb)) {
      const sessions = loadZcodeSessions(zcodeDb, since);
      const report = runSource('zcode', sessions, store, { cap, dryRun, selfMarkers });
      const median = zcodeTokenMedian(zcodeDb);
      report.medianRequestTokens = median?.median ?? null;
      report.medianSamples = median?.samples ?? 0;
      sources.push(report);
    } else {
      sources.push(emptySource('zcode', 'no ~/.zcode/cli/db/db.sqlite'));
    }
  }

  if (wanted === 'auto' || wanted === 'codex') {
    const { sessions, present, note } = loadCodexSessions(codexDir, since);
    if (present) {
      const report = runSource('codex', sessions, store, { cap, dryRun, selfMarkers });
      if (note) report.note = note;
      sources.push(report);
    } else {
      sources.push(emptySource('codex', note));
    }
  }

  if (wanted === 'auto' || wanted === 'claude-code') {
    const { sessions, present, note } = loadClaudeSessions(claudeDir, since);
    if (present) {
      const report = runSource('claude-code', sessions, store, { cap, dryRun, selfMarkers });
      // Provenance is part of the report: this parser is fixture-tested only.
      report.note = note ?? 'parser fixture-tested; not yet verified against a real install';
      const median = medianOf(sessions.flatMap((session) => session.tokenSamples));
      report.medianRequestTokens = median?.median ?? null;
      report.medianSamples = median?.samples ?? 0;
      sources.push(report);
    } else {
      sources.push(emptySource('claude-code', note));
    }
  }

  const totals = sources.reduce(
    (acc, source) => ({
      scanned: acc.scanned + source.scanned,
      failures: acc.failures + source.failures,
      paired: acc.paired + source.paired,
      enqueued: acc.enqueued + source.enqueued,
      skippedSelf: acc.skippedSelf + source.skippedSelf,
    }),
    { scanned: 0, failures: 0, paired: 0, enqueued: 0, skippedSelf: 0 },
  );
  return { sources, totals };
}
