/**
 * Command-line surface for the immune database.
 *
 * Slash commands in this plugin are Markdown prompts, so they cannot call the
 * database themselves. They ask the model to run this CLI instead, which keeps
 * the logic testable and out of the prompt.
 *
 * Usage: node dist/zcode/src/cli.js <list|stats|export|prune|forget> [...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ImmuneStore } from '../../core/store/index.js';
import { renderSkillMarkdown } from '../../core/export.js';
import { strings } from '../../core/i18n.js';
import { dshDirOf } from './root-marker.js';

const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/** Terminal columns a string occupies; CJK glyphs are double width. */
function width(text: string): number {
  let total = 0;
  for (const ch of text) total += WIDE.test(ch) ? 2 : 1;
  return total;
}

function pad(value: string, columns: number): string {
  const used = width(value);
  return used >= columns ? value : value + ' '.repeat(columns - used);
}

/** Clamp to a column budget without splitting a double-width glyph. */
function clamp(value: string, columns: number): string {
  if (width(value) <= columns) return value;
  let out = '';
  let used = 0;
  for (const ch of value) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (used + w > columns - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function cmdList(store: ImmuneStore, includeRetired: boolean): void {
  const t = strings();
  const rows = store.listAll(includeRetired);
  if (rows.length === 0) {
    process.stdout.write(`${t.noAntibodies}\n`);
    return;
  }
  const indent = ' '.repeat(27);
  const header = `${pad('#', 5)}${pad('hits', 6)}${pad('fails', 7)}${pad('status', 9)}${t.trigger}\n`;
  process.stdout.write(header);
  for (const ab of rows) {
    process.stdout.write(
      `${pad(String(ab.id), 5)}${pad(String(ab.hit_count), 6)}${pad(String(ab.fail_count), 7)}` +
        `${pad(ab.status, 9)}${clamp(ab.trigger_pattern, 64)}\n` +
        `${indent}${t.avoid}: ${clamp(ab.symptom, 90)}\n` +
        `${indent}${t.do}: ${clamp(ab.prescription, 90)}\n`,
    );
  }
}

function cmdStats(store: ImmuneStore): void {
  const all = store.listAll(true);
  const active = all.filter((a) => a.status === 'active');
  const retired = all.length - active.length;
  const hits = active.reduce((sum, a) => sum + a.hit_count, 0);
  process.stdout.write(
    `antibodies: ${all.length} (active ${active.length}, retired ${retired})\n` +
      `injections: ${hits}\n` +
      `queued distill jobs: ${store.pendingJobCount()}\n` +
      `database: ${store.dbPath}\n`,
  );
}

function cmdExport(store: ImmuneStore, args: string[]): void {
  const minHits = Number(args[0] ?? '');
  const threshold = Number.isFinite(minHits) && minHits > 0 ? minHits : 3;
  const rows = store.exportable(threshold);
  if (rows.length === 0) {
    process.stdout.write(`${strings().noExport}\n`);
    return;
  }

  const outPath = args[1]
    ? resolve(args[1])
    : join(dshDirOf(), 'skills', 'project-pitfalls', 'SKILL.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderSkillMarkdown(rows, { minHits: threshold }), 'utf8');
  process.stdout.write(`${strings().exported} ${rows.length} -> ${outPath}\n`);
}

function main(argv: string[]): number {
  const [command = 'list', ...args] = argv;
  const store = new ImmuneStore();
  try {
    switch (command) {
      case 'list':
        cmdList(store, args.includes('--all'));
        return 0;
      case 'stats':
        cmdStats(store);
        return 0;
      case 'export':
        cmdExport(store, args);
        return 0;
      case 'prune':
        store.pruneStale();
        process.stdout.write('Pruned stale pending failures and injection records.\n');
        return 0;
      case 'forget': {
        // --last  : undo the antibody the previous turn just learned
        // --prune : drop never-injected antibodies older than 14 days
        if (args.includes('--last')) {
          const id = store.forgetLast();
          process.stdout.write(
            id === null ? `${strings().notFound}\n` : `${strings().forgot} #${id}.\n`,
          );
          return 0;
        }
        if (args.includes('--prune')) {
          const removed = store.pruneZombies(14 * 24 * 60 * 60 * 1000);
          process.stdout.write(
            removed.length === 0
              ? `${strings().noZombies}\n`
              : `${strings().pruned} ${removed.length}: ${removed.map((n) => `#${n}`).join(' ')}\n`,
          );
          return 0;
        }

        const id = Number(args[0]);
        if (!Number.isFinite(id)) {
          process.stderr.write(
            'usage: immune forget <id> | --last | --prune\n',
          );
          return 2;
        }
        process.stdout.write(store.remove(id) ? `${strings().forgot} #${id}.\n` : `${strings().notFound} #${id}.\n`);
        return 0;
      }
      default:
        process.stderr.write('usage: immune <list|stats|export|prune|forget> [...args]\n');
        return 2;
    }
  } finally {
    store.close();
  }
}

process.exitCode = main(process.argv.slice(2));
