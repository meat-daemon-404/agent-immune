/**
 * "What did it save" — measured, not asserted.
 *
 * A suppressed repeat is at least one round-trip that did not happen: the
 * failure that did not recur, plus the retry that would have followed it. The
 * size of a round-trip is not a guess — the host records `computed_total_tokens`
 * for every request, so we take the median of this project's own completed
 * requests and multiply.
 *
 * Deliberately NOT produced here: a dollar figure. Pricing varies per model,
 * some models are unpriced, and cache-hit arithmetic depends on state we cannot
 * observe. The token estimate has one stated assumption (2 round-trips per
 * suppressed repeat) and no invented exchange rate.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { hostDbPath } from './store/models.js';

export interface AvoidedEstimate {
  /** Repeats the suppression window caught, as counted by the plugin. */
  suppressed: number;
  /** Median tokens of one completed request in this project. */
  medianRequestTokens: number;
  /** How many requests the median is based on. */
  samples: number;
  /** suppressed × median × ROUND_TRIPS_PER_REPEAT. */
  avoidedTokens: number;
}

/** A suppressed repeat removes the failing attempt and the retry that follows. */
export const ROUND_TRIPS_PER_REPEAT = 2;
/** Median needs enough of a distribution to mean anything. */
const MIN_SAMPLES = 30;

/**
 * Estimate avoided tokens from the host's own usage rows.
 *
 * Returns null when the host database is unavailable, has too little history,
 * or the plugin counted no suppressions — in each case printing a number would
 * be fiction.
 */
export function estimateAvoided(
  suppressed: number,
  env: NodeJS.ProcessEnv = process.env,
): AvoidedEstimate | null {
  if (suppressed <= 0) return null;

  const path = hostDbPath(env);
  if (!existsSync(path)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT computed_total_tokens AS t FROM model_usage
          WHERE status = 'completed' AND computed_total_tokens > 0
          ORDER BY started_at DESC LIMIT ?`,
      )
      .all(500) as Array<{ t: number }>;
    if (rows.length < MIN_SAMPLES) return null;

    const values = rows.map((r) => Number(r.t)).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)] ?? 0;
    if (!Number.isFinite(median) || median <= 0) return null;

    return {
      suppressed,
      medianRequestTokens: Math.round(median),
      samples: values.length,
      avoidedTokens: Math.round(suppressed * median * ROUND_TRIPS_PER_REPEAT),
    };
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

/** 2_400_000 -> "2.4M"; small counts stay exact. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
