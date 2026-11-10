/**
 * Builtin seed packs (`immune seed <pack>`): curated starter rules, installed
 * through the SAME insert path as live learning, so near-duplicates of the
 * user's own rules merge instead of doubling, and every row records which
 * pack it came from. Removal is conservative: a recorded row is deleted only
 * when its prescription still matches what the pack seeded — a rule the user
 * has since edited, merged, or had rewritten carries its own evidence now and
 * is kept (and the report says so).
 */
import type { DatabaseSync } from 'node:sqlite';
import { insertAntibody } from './antibodies.js';
import type { NewAntibody } from '../types.js';

export interface SeedRule {
  trigger_pattern: string;
  symptom: string;
  prescription: string;
  tool_name?: string | null;
}

export interface SeedInstallReport {
  pack: string;
  /** Rules newly inserted (or merged into an existing row). */
  inserted: number;
  /** Rules already recorded for this pack (a repeat `seed` is a no-op). */
  alreadySeeded: number;
}

export interface SeedRemoveReport {
  pack: string;
  removed: number;
  /** Recorded rows whose prescription changed since seeding — evidence kept. */
  keptChanged: number;
  /** Recorded rows that have been delivered since seeding — evidence kept. */
  keptProven: number;
}

export function installSeedPack(
  db: DatabaseSync,
  pack: string,
  rules: SeedRule[],
): SeedInstallReport {
  const report: SeedInstallReport = { pack, inserted: 0, alreadySeeded: 0 };
  const now = Date.now();
  const tx = db.prepare('BEGIN');
  try {
    tx.run();
    for (const rule of rules) {
      const recorded = db
        .prepare('SELECT rule_id FROM seed_packs WHERE pack = ? AND prescription = ?')
        .get(pack, rule.prescription.trim().slice(0, 200)) as { rule_id: number } | undefined;
      if (recorded) {
        report.alreadySeeded += 1;
        continue;
      }
      const id = insertAntibody(db, rule as NewAntibody);
      if (id === null) continue;
      db.prepare('INSERT INTO seed_packs (rule_id, pack, prescription, seeded_at) VALUES (?, ?, ?, ?)').run(
        id,
        pack,
        rule.prescription.trim().slice(0, 200),
        now,
        );
      report.inserted += 1;
    }
    db.prepare('COMMIT').run();
  } catch (error) {
    db.prepare('ROLLBACK').run();
    throw error;
  }
  return report;
}

export function removeSeedPack(db: DatabaseSync, pack: string): SeedRemoveReport {
  const report: SeedRemoveReport = { pack, removed: 0, keptChanged: 0, keptProven: 0 };
  const rows = db
    .prepare('SELECT rule_id, prescription FROM seed_packs WHERE pack = ?')
    .all(pack) as Array<{ rule_id: number; prescription: string }>;
  const tx = db.prepare('BEGIN');
  try {
    tx.run();
    for (const row of rows) {
      const current = db
        .prepare('SELECT prescription, hit_count FROM antibodies WHERE id = ?')
        .get(row.rule_id) as { prescription: string; hit_count: number } | undefined;
      if (!current) {
        // The rule is gone (user pruned it); just drop the marker.
        db.prepare('DELETE FROM seed_packs WHERE rule_id = ?').run(row.rule_id);
        continue;
      }
      if (current.prescription !== row.prescription) {
        // The rule changed since seeding — it carries the user's evidence now.
        report.keptChanged += 1;
        continue;
      }
      if (current.hit_count > 0) {
        // The rule has been delivered and (so far) held — removing proven
        // advice would discard the user's own counter-evidence trail.
        report.keptProven += 1;
        continue;
      }
      db.prepare('DELETE FROM antibodies WHERE id = ?').run(row.rule_id);
      db.prepare('DELETE FROM seed_packs WHERE rule_id = ?').run(row.rule_id);
      report.removed += 1;
    }
    db.prepare('COMMIT').run();
  } catch (error) {
    db.prepare('ROLLBACK').run();
    throw error;
  }
  return report;
}

/** Per-pack counts of still-recorded seed rows, for the list view. */
export function seededPackCounts(db: DatabaseSync): Map<string, number> {
  const rows = db
    .prepare('SELECT pack, COUNT(*) AS n FROM seed_packs GROUP BY pack')
    .all() as Array<{ pack: string; n: number }>;
  return new Map(rows.map((row) => [row.pack, row.n]));
}
