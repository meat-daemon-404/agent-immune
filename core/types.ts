/**
 * Shared types for the immune system.
 *
 * These are host-agnostic: `core/` never imports a ZCode or DSH API, so both
 * adapters can reuse them unchanged.
 */

/** Lifecycle of an antibody. Retired antibodies are kept for audit but never injected. */
export type AntibodyStatus = 'active' | 'retired';

/** A pitfall-avoidance rule distilled from one failed-then-fixed episode. */
export interface Antibody {
  id: number;
  /** Where the pitfall is likely to bite: file names, package names, commands, API keywords. */
  trigger_pattern: string;
  /** The wrong instinct, in one line. */
  symptom: string;
  /** The verified correct move, in one line. */
  prescription: string;
  /** How many times this antibody has been injected into context. */
  hit_count: number;
  /** How many times this antibody was injected and the tool still failed. */
  fail_count: number;
  status: AntibodyStatus;
  /** Which tool the episode came from (e.g. Bash, Edit), for diagnostics. */
  tool_name: string | null;
  created_at: number;
  updated_at: number;
}

/** Fields a caller supplies when creating an antibody; the store owns the rest. */
export type NewAntibody = Pick<
  Antibody,
  'trigger_pattern' | 'symptom' | 'prescription'
> & {
  tool_name?: string | null;
};

/** One failed tool call, captured so a later success can be paired with it. */
export interface FailureSnapshot {
  session_id: string;
  tool_name: string;
  /** Compact, redacted summary of the failed invocation. */
  trace: string;
  /** Antibody ids injected before this failure, so they can be penalised. */
  injected_ids: number[];
  created_at: number;
}

/** An episode ready to be distilled: a failure followed by a success on the same tool. */
export interface Episode {
  session_id: string;
  tool_name: string;
  failureTrace: string;
  successTrace: string;
  /** Antibodies that were in context when the failure happened. */
  injected_ids: number[];
}

/** Result of a distillation attempt. */
export type DistillResult =
  | { ok: true; antibody: NewAntibody }
  | { ok: false; reason: 'skip' | 'invalid' | 'error'; detail?: string };
