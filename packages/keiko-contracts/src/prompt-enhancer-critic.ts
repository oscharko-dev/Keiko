// Prompt Enhancer candidate-critic contract surface (Epic #1307, Issue #1312; ADR-0044 §1/§6).
//
// Wire-safe, provider-neutral type shapes for the deterministic PromptCritic: the scoring dimensions,
// a transparent per-candidate scorecard, the auditable selection result of the bounded optimization
// loop, and the configured optimization bounds. The deterministic scoring *logic* lives in the model
// gateway (`keiko-model-gateway/src/promptEnhancer/critic.ts`); this module owns only the contract
// shapes so the server (#1314) and offline evaluation suite (#1315) can transmit and render scorecards
// without re-deriving them.
//
// These dimensions are deliberately a distinct set from the agent-run-trajectory `EVALUATION_DIMENSIONS`
// (`evaluations.ts`): those score a completed workflow run pass/fail, whereas these score the *quality
// of an Enhanced Prompt artefact* on a continuous [0, 1] scale so candidates can be ranked.
//
// Determinism: pure value tables and types only. No IO, clock, randomness, or module-level side
// effects. Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports.

import {
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type PromptEnhancementProfileId,
} from "./prompt-enhancer.js";

// ─── Critic dimensions ─────────────────────────────────────────────────────────────
// The six deterministic prompt-quality dimensions the critic scores (Issue #1312 acceptance
// criteria). The order is the canonical scorecard order; the critic emits exactly one score per
// dimension in this order.
export type PromptCriticDimension =
  | "clarity"
  | "completeness"
  | "grounding-readiness"
  | "safety"
  | "output-controllability"
  | "token-efficiency";

export const PROMPT_CRITIC_DIMENSIONS: readonly PromptCriticDimension[] = [
  "clarity",
  "completeness",
  "grounding-readiness",
  "safety",
  "output-controllability",
  "token-efficiency",
] as const;

export const isPromptCriticDimension = (value: unknown): value is PromptCriticDimension =>
  typeof value === "string" && (PROMPT_CRITIC_DIMENSIONS as readonly string[]).includes(value);

// ─── Per-dimension score ───────────────────────────────────────────────────────────
// One dimension's deterministic score plus an inspectable rationale. `score` is a finite value in the
// closed interval [0, 1]. `rationale` is a short, human-readable explanation that cites the structural
// evidence behind the score; it never echoes the raw user input (safe-error discipline, ADR-0044 §5).
export interface PromptCriticDimensionScore {
  readonly dimension: PromptCriticDimension;
  readonly score: number;
  readonly rationale: string;
}

// ─── Candidate scorecard ───────────────────────────────────────────────────────────
// The full transparent scorecard for one prompt candidate: every dimension score, the weighted
// aggregate used for ranking, and the candidate's deterministic token estimate.
export interface PromptCandidateScorecard {
  readonly schemaVersion: typeof PROMPT_ENHANCER_SCHEMA_VERSION;
  // Deterministic, content-free candidate identifier (e.g. `${requestId}::${profile}`).
  readonly candidateId: string;
  // The generation profile this candidate was produced under.
  readonly profile: PromptEnhancementProfileId;
  // Exactly one entry per `PROMPT_CRITIC_DIMENSIONS` member, in canonical order.
  readonly dimensionScores: readonly PromptCriticDimensionScore[];
  // Weighted aggregate of the dimension scores, in [0, 1]. The ranking key.
  readonly aggregateScore: number;
  // Deterministic token estimate for the rendered prompt (a heuristic char-based estimate, not a
  // model tokenizer); feeds the token-efficiency dimension and the optimization-loop token budget.
  readonly estimatedTokens: number;
}

// ─── Rejected alternatives (auditable with reasons) ────────────────────────────────
export type PromptCandidateRejectionReason =
  // A scored candidate ranked below the winner.
  | "lower-aggregate-score"
  // A scored candidate tied the aggregate but lost a deterministic tie-break.
  | "lower-tie-break-rank"
  // The candidate's token estimate would exceed the remaining optimization token budget; never scored.
  | "exceeded-token-budget"
  // Structurally identical to an already-considered, higher-ranked candidate.
  | "duplicate-candidate"
  // The candidate did not preserve the baseline safety/grounding/output floor (defensive; such a
  // candidate is dropped before scoring — candidate generation never relaxes safety, AC5).
  | "safety-floor-not-preserved";

export const PROMPT_CANDIDATE_REJECTION_REASONS: readonly PromptCandidateRejectionReason[] = [
  "lower-aggregate-score",
  "lower-tie-break-rank",
  "exceeded-token-budget",
  "duplicate-candidate",
  "safety-floor-not-preserved",
] as const;

export const isPromptCandidateRejectionReason = (
  value: unknown,
): value is PromptCandidateRejectionReason =>
  typeof value === "string" &&
  (PROMPT_CANDIDATE_REJECTION_REASONS as readonly string[]).includes(value);

// One rejected alternative, auditable with its reason. `aggregateScore` is null when the candidate was
// never scored (e.g. skipped because it would exceed the token budget).
export interface PromptCandidateRejection {
  readonly candidateId: string;
  readonly profile: PromptEnhancementProfileId;
  readonly aggregateScore: number | null;
  readonly reason: PromptCandidateRejectionReason;
}

// ─── Optimization bounds ───────────────────────────────────────────────────────────
// The configured envelope the bounded optimization loop is held within (AC4). All three bounds are
// independent and every one is enforced: `candidateCount` caps how many distinct variants are
// generated, `maxIterations` caps how many progressive-widening rounds run, and `tokenBudget` caps the
// cumulative token estimate of the candidates that are actually scored.
export interface PromptOptimizationBounds {
  readonly candidateCount: number;
  readonly tokenBudget: number;
  readonly maxIterations: number;
}

// ─── Selection result ──────────────────────────────────────────────────────────────
// The auditable output of the bounded optimization loop: the winning scorecard, every scored candidate
// in deterministic rank order (winner first), every rejected alternative with its reason, the bounds
// the loop honoured, and the work the loop performed.
export interface PromptCandidateSelection {
  readonly schemaVersion: typeof PROMPT_ENHANCER_SCHEMA_VERSION;
  readonly winner: PromptCandidateScorecard;
  readonly ranked: readonly PromptCandidateScorecard[];
  readonly rejected: readonly PromptCandidateRejection[];
  readonly bounds: PromptOptimizationBounds;
  // Number of progressive-widening rounds actually run (1 .. bounds.maxIterations).
  readonly iterations: number;
  // Number of distinct candidates actually scored.
  readonly candidatesConsidered: number;
  // The token budget consumed by the scored candidates, accounted through the gateway's token-budget
  // primitive and therefore capped at `bounds.tokenBudget`.
  readonly tokensConsumed: number;
}
