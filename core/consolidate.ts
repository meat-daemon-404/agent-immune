/**
 * Consolidate repeated lessons without changing their evidence.
 *
 * The normal insert path catches exact and near-identical prescriptions, but a
 * model rewrite can leave two useful wordings of one lesson apart. This is the
 * explicit operator action for that case: same normalized symptom + same tool
 * are grouped, then every pair must pass the same prescription threshold and
 * share a trigger token. Similar symptoms alone are NOT enough to merge.
 *
 * The keeper is the most proven rule (hits, then older id). Its wording stays;
 * the trigger union widens recall; counters, repairs and model attribution are
 * carried over. Retirees are retired, not deleted, so they remain recoverable.
 */
import type { ImmuneStore } from './store/index.js';
import type { Antibody } from './types.js';
import { prescriptionSimilarity } from './similarity.js';

/**
 * Prescription similarity required before two rules may merge. The CLI's
 * "same symptom, different wording" report must use the SAME number, or the
 * display disagrees with what the tool would actually merge.
 */
export const CONSOLIDATE_SIMILARITY = 0.7;

/**
 * ROADMAP 2.4b: the pairwise similarity sample size for findLessonGroups.
 * Measured on a worst-case 300-member single group: full pairwise = 616 ms,
 * sampled (top-20 members, <=190 pairs) = single-digit ms. The apply path is
 * unaffected.
 */
export const MAX_SIMILARITY_SAMPLE = 20;

export interface ConsolidationCandidate {
  keepId: number;
  retireId: number;
  similarity: number;
  keepPrescription: string;
  retirePrescription: string;
  keepHits: number;
  retireHits: number;
  symptom: string;
}

export interface ConsolidationResult {
  /** Duplicate rules retired, once each. */
  retired: number;
  /** Pairs in the proposed groups; retired.length <= merged.length. */
  merged: ConsolidationCandidate[];
}

/** Normalized grouping key: wording case/whitespace must not split one lesson. */
export function lessonKey(rule: Pick<Antibody, 'symptom' | 'tool_name'>): string {
  return `${(rule.tool_name ?? '').trim().toLowerCase()}::${rule.symptom
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()}`;
}

function shareTrigger(left: string, right: string): boolean {
  const tokens = new Set(left.toLowerCase().split(/\s+/).filter(Boolean));
  return right.toLowerCase().split(/\s+/).some((token) => tokens.has(token));
}

function repairUnion(rows: Antibody[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const action of row.repair_path) {
      if (!out.includes(action)) out.push(action);
    }
  }
  return out.slice(-3);
}

/**
 * Plan the groups first, so dry-run and apply see exactly the same candidates.
 * Pairwise greedy grouping avoids requiring every paraphrase to score against
 * the keeper's wording; a pair still needs both a high score and shared trigger.
 */
export function findConsolidationCandidates(store: ImmuneStore): ConsolidationCandidate[] {
  const rules = store
    .listAll(false)
    .filter((rule) => rule.status === 'active')
    .sort((a, b) => b.hit_count - a.hit_count || a.id - b.id);
  const assigned = new Set<number>();
  const out: ConsolidationCandidate[] = [];

  for (const keeper of rules) {
    if (assigned.has(keeper.id)) continue;
    for (const other of rules) {
      if (other.id <= keeper.id || assigned.has(other.id)) continue;
      if (lessonKey(keeper) !== lessonKey(other)) continue;
      if (!shareTrigger(keeper.trigger_pattern, other.trigger_pattern)) continue;
      const similarity = prescriptionSimilarity(keeper.prescription, other.prescription);
      if (similarity < CONSOLIDATE_SIMILARITY) continue;
      assigned.add(other.id);
      out.push({
        keepId: keeper.id,
        retireId: other.id,
        similarity,
        keepPrescription: keeper.prescription,
        retirePrescription: other.prescription,
        keepHits: keeper.hit_count,
        retireHits: other.hit_count,
        symptom: keeper.symptom,
      });
    }
  }
  return out;
}

export interface LessonGroup {
  key: string;
  symptom: string;
  rules: Array<{ id: number; hits: number; prescription: string }>;
  /** Best pairwise prescription similarity inside the group. */
  maxSimilarity: number;
}

/**
 * Rules that share a symptom but did not clear the merge bar.
 *
 * This exists because the honest answer to a real library was "no candidates":
 * five rules taught the same lesson in different words (and one in English),
 * and text similarity cannot see that. Reporting the group lets a person decide
 * instead of the tool either merging blindly or staying silent.
 */
export function findLessonGroups(store: ImmuneStore): LessonGroup[] {
  const active = store.listAll(false).filter((rule) => rule.status === 'active');
  const groups = new Map<string, Antibody[]>();
  for (const rule of active) {
    const key = lessonKey(rule);
    const bucket = groups.get(key) ?? [];
    bucket.push(rule);
    groups.set(key, bucket);
  }

  const out: LessonGroup[] = [];
  for (const [key, rules] of groups) {
    if (rules.length < 2) continue;
    // ROADMAP 2.4b guard, measured: the FULL pairwise similarity over one
    // 300-member group costs 616 ms — too big for the turn boundary the sleep
    // scan and doctor ride. maxSimilarity is computed over the most-delivered
    // MAX_SIMILARITY_SAMPLE members; it is a sampling (said so here), and the
    // consolidation apply path still does its own exact pairwise.
    const sampled = rules
      .slice()
      .sort((a, b) => b.hit_count - a.hit_count || a.id - b.id)
      .slice(0, MAX_SIMILARITY_SAMPLE);
    let best = 0;
    for (let i = 0; i < sampled.length; i += 1) {
      for (let j = i + 1; j < sampled.length; j += 1) {
        best = Math.max(
          best,
          prescriptionSimilarity(sampled[i]!.prescription, sampled[j]!.prescription),
        );
      }
    }
    out.push({
      key,
      symptom: rules[0]!.symptom,
      rules: rules
        .sort((a, b) => b.hit_count - a.hit_count || a.id - b.id)
        .map((rule) => ({ id: rule.id, hits: rule.hit_count, prescription: rule.prescription })),
      maxSimilarity: best,
    });
  }
  return out;
}

/** Apply a previously reviewed candidate list, or all current candidates. */
export function consolidateRules(
  store: ImmuneStore,
  candidates: ConsolidationCandidate[] = findConsolidationCandidates(store),
): ConsolidationResult {
  let retired = 0;
  // A group is one keeper and its duplicates. The explicit list is trusted as
  // the plan, but the database is re-read so stale UI results cannot merge a
  // rule that was edited or retired in the meantime.
  const byKeeper = new Map<number, number[]>();
  for (const candidate of candidates) {
    const ids = byKeeper.get(candidate.keepId) ?? [];
    ids.push(candidate.retireId);
    byKeeper.set(candidate.keepId, ids);
  }

  // One read serves the whole application: the re-read is still the source of
  // truth (stale UI results cannot merge a rule that changed meanwhile), it
  // just stops costing one full table scan per id.
  const rowsById = new Map(store.listAll(false).map((rule) => [rule.id, rule]));
  for (const [keepId, retireIds] of byKeeper) {
    const keeper = rowsById.get(keepId);
    if (!keeper || keeper.status !== 'active') continue;
    const rows = [keeper];
    for (const id of retireIds) {
      const row = rowsById.get(id);
      if (row && row.status === 'active') rows.push(row);
    }
    if (rows.length === 1) continue;

    const trigger = rows
      .map((row) => row.trigger_pattern)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((token, index, all) => all.findIndex((x) => x.toLowerCase() === token.toLowerCase()) === index)
      .join(' ')
      .slice(0, 200);
    const hitCount = rows.reduce((sum, row) => sum + row.hit_count, 0);
    const failCount = rows.reduce((sum, row) => sum + row.fail_count, 0);
    const repairs = repairUnion(rows);
    store.consolidateInto(keepId, {
      trigger,
      hitCount,
      failCount,
      repairs,
      retireIds: rows.slice(1).map((row) => row.id),
    });
    retired += rows.length - 1;
  }
  return { retired, merged: candidates };
}
