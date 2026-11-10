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
  /**
   * The write actions that repaired the problem when this rule was learned
   * (the action diff, newest last, capped at three). Provenance: it shows HOW
   * the lesson was learned. Empty for seeded and older rules.
   */
  repair_path: string[];
  /**
   * Optional. Who wrote the current prescription: '' (older or captured),
   * 'rule', 'llm' or 'human'. `immune rewrite` replaces command dumps and
   * records 'llm', so an operator can tell rewritten wording from evidence.
   */
  prescription_source?: string;
  /**
   * Optional. ROADMAP 1.4b: what taught the lesson — '' (self-repair),
   * 'user_correction' (a human hint closed the episode). Provenance only;
   * never a behavior switch.
   */
  origin?: string;
  /** ROADMAP 2.2: the rule this refined child was mutated from (lineage). */
  parent_id?: number | null;
  /** ROADMAP 2.2: when the last evidence-based trigger refinement landed. */
  mutated_at?: number;
  /** ROADMAP 3.1: which workspace taught the rule (lockfile content hash). */
  env_fingerprint?: string;
  /** ROADMAP 3.1: nonzero when the workspace changed and the rule awaits re-validation. */
  probation_at?: number;
  /** ROADMAP 3.1: why a rule left the active set when it was not anti-rot. */
  retire_reason?: string;
  created_at: number;
  updated_at: number;
}

/** Fields a caller supplies when creating an antibody; the store owns the rest. */
export type NewAntibody = Pick<
  Antibody,
  'trigger_pattern' | 'symptom' | 'prescription'
> & {
  tool_name?: string | null;
  repair_path?: string[];
  origin?: string;
  env_fingerprint?: string;
};

/** One failed tool call, captured so a later success can be paired with it. */
export interface FailureSnapshot {
  session_id: string;
  tool_name: string;
  /** Compact, redacted summary of the failed invocation. */
  trace: string;
  /** Antibody ids injected before this failure, so they can be penalised. */
  injected_ids: number[];
  /**
   * What the human said in the turn AFTER the failure.
   *
   * Real sessions often read: tool fails → agent asks → the human explains
   * ("这个仓库用 pnpm, 不要用 npm") → the next call works. That sentence is the
   * best distillation input available, and it is what makes the resulting
   * prescription better than the model's own guess at a retry.
   */
  human_hint: string;
  /**
   * Non-probe write actions recorded between the failure and the closing
   * success (the EMG action-diff): what actually repaired the problem, e.g.
   * ["Edit tsconfig.json", "Write vite.config.ts"]. Empty when the fix was a
   * plain retry.
   */
  repair_path: string[];
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
  | {
      ok: true;
      antibody: NewAntibody;
      /**
       * Which path produced the rule. `rule` on a configured-LLM run means the
       * model call failed and the loop degraded silently — the runtime
       * counter is the only way an operator learns that.
       */
      source?: 'llm' | 'rule';
      /** Why the LLM path did not produce the rule, when it did not. */
      degradedReason?: string;
    }
  | { ok: false; reason: 'skip' | 'invalid' | 'error'; detail?: string };
