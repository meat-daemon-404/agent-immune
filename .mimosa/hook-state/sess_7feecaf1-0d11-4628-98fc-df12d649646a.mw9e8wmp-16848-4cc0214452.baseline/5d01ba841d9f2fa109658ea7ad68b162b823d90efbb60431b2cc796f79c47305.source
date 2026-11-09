/**
 * Library snapshots: export / import for cross-machine and team sync.
 *
 * The format is deliberately boring JSON with an explicit format tag, so a
 * future version can refactor the table without breaking old snapshots. Merge
 * semantics are conservative on purpose:
 *
 *  - the prescription is the identity (same rule as the store's own dedupe);
 *  - when both sides know a rule, hit and fail counts take the MAX (a rule used
 *    on two machines has two independent tallies, not two conflicting ones);
 *  - status is active when EITHER side says active — retirement is one
 *    machine's judgement, not a consensus decision;
 *  - rows missing trigger or prescription are counted invalid, not fatal.
 */

import type { Antibody, NewAntibody } from './types.js';
import type { ImmuneStore } from './store/index.js';

export const SNAPSHOT_FORMAT = 'dsh-immune-library';
export const SNAPSHOT_VERSION = 1;

export interface SnapshotAntibody {
  trigger_pattern: string;
  symptom: string;
  prescription: string;
  hit_count: number;
  fail_count: number;
  status: string;
  tool_name: string | null;
  created_at: number;
}

export interface LibrarySnapshot {
  format: string;
  version: number;
  exported_at: string;
  count: number;
  antibodies: SnapshotAntibody[];
}

export function exportLibrary(store: ImmuneStore): LibrarySnapshot {
  const rows = store.listAll(true);
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exported_at: new Date().toISOString(),
    count: rows.length,
    antibodies: rows.map((a: Antibody) => ({
      trigger_pattern: a.trigger_pattern,
      symptom: a.symptom,
      prescription: a.prescription,
      hit_count: a.hit_count,
      fail_count: a.fail_count,
      status: a.status,
      tool_name: a.tool_name,
      repair_path: a.repair_path ?? [],
      created_at: a.created_at,
    })),
  };
}

export interface ImportReport {
  added: number;
  merged: number;
  invalid: number;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStatus(value: unknown): 'active' | 'retired' {
  return value === 'retired' ? 'retired' : 'active';
}

/**
 * Merge a snapshot into the store. Returns the per-row outcome counts so the
 * caller can report exactly what happened.
 */
export function importLibrary(store: ImmuneStore, snapshot: unknown): ImportReport {
  const report: ImportReport = { added: 0, merged: 0, invalid: 0 };
  if (typeof snapshot !== 'object' || snapshot === null) return report;

  const raw = (snapshot as Record<string, unknown>).antibodies;
  if (!Array.isArray(raw)) return report;

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      report.invalid += 1;
      continue;
    }
    const row = item as Record<string, unknown>;
    const trigger = typeof row.trigger_pattern === 'string' ? row.trigger_pattern.trim() : '';
    const prescription = typeof row.prescription === 'string' ? row.prescription.trim() : '';
    const symptom = typeof row.symptom === 'string' ? row.symptom.trim() : '';
    if (!trigger || !prescription) {
      report.invalid += 1;
      continue;
    }

    const incoming: SnapshotAntibody = {
      trigger_pattern: trigger,
      symptom: symptom || '(imported rule)',
      prescription,
      hit_count: Math.max(0, asNumber(row.hit_count, 0)),
      fail_count: Math.max(0, asNumber(row.fail_count, 0)),
      status: asStatus(row.status),
      tool_name: typeof row.tool_name === 'string' ? row.tool_name : null,
      created_at: asNumber(row.created_at, Date.now()),
    };

    const existing = store
      .listAll(true)
      .find((a) => a.prescription === incoming.prescription);

    if (existing) {
      const mergedHits = Math.max(existing.hit_count, incoming.hit_count);
      const mergedFails = Math.max(existing.fail_count, incoming.fail_count);
      const mergedStatus = existing.status === 'active' || incoming.status === 'active' ? 'active' : 'retired';
      const changed =
        mergedHits !== existing.hit_count ||
        mergedFails !== existing.fail_count ||
        mergedStatus !== existing.status;
      if (changed) {
        // status has no numeric setter; go through setStatus when it changed.
        if (mergedStatus !== existing.status) store.setStatus(existing.id, mergedStatus);
        applyTallies(store, existing.id, mergedHits, mergedFails, incoming.created_at);
      }
      report.merged += 1;
      continue;
    }

    const created: NewAntibody = {
      trigger_pattern: incoming.trigger_pattern,
      symptom: incoming.symptom,
      prescription: incoming.prescription,
      tool_name: incoming.tool_name,
    };
    const id = store.insert(created);
    if (id === null) {
      report.invalid += 1;
      continue;
    }
    if (incoming.hit_count > 0 || incoming.fail_count > 0) {
      applyTallies(store, id, incoming.hit_count, incoming.fail_count, incoming.created_at);
    }
    if (incoming.status === 'retired') store.setStatus(id, 'retired');
    report.added += 1;
  }

  return report;
}

import type { DatabaseSync } from 'node:sqlite';

/** Set tallies (and optionally creation time) directly; import owns merge policy. */
function applyTallies(
  store: ImmuneStore,
  id: number,
  hitCount: number,
  failCount: number,
  createdAt?: number,
): void {
  const db = (store as unknown as { db: DatabaseSync }).db;
  if (createdAt && createdAt > 0) {
    // Snapshot time is preserved so zombie aging counts from the original
    // lesson, not from when this machine imported it.
    db.prepare('UPDATE antibodies SET hit_count = ?, fail_count = ?, created_at = ? WHERE id = ?').run(
      hitCount,
      failCount,
      createdAt,
      id,
    );
    return;
  }
  db.prepare('UPDATE antibodies SET hit_count = ?, fail_count = ? WHERE id = ?').run(
    hitCount,
    failCount,
    id,
  );
}
