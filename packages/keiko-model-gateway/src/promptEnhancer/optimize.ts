// Prompt Enhancer bounded candidate optimization (Epic #1307, Issue #1312; ADR-0044 §1/§4/§6).
//
// Ties candidate generation (`candidates.ts`) to the deterministic critic (`critic.ts`): it generates a
// bounded slate of safety-preserving candidates, scores them, ranks them with a deterministic total
// order, and returns the winner plus every rejected alternative with a reason (AC1–AC4).
//
// The optimization is a bounded best-of-N selection — the deterministic, CI-reproducible core of the
// APE/OPRO pattern (generate variants → score → keep the best). Three independent bounds are enforced
// (AC4): `candidateCount` caps how many distinct variants are generated, `maxIterations` caps how many
// evaluation rounds run, and `tokenBudget` caps the cumulative token cost of the scored candidates,
// reusing the gateway's token-budget primitives. Long-running autonomous evolutionary breeding and
// unbounded LLM-as-judge loops are explicitly out of scope.
//
// Determinism: pure. No IO, clock, or randomness. Identical inputs always yield an identical selection.

import {
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type PromptCandidateRejection,
  type PromptCandidateScorecard,
  type PromptCandidateSelection,
  type PromptCriticDimension,
  type PromptEnhancementProfileId,
  type PromptOptimizationBounds,
  type PromptTaskAnalysis,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import {
  createBudget,
  remainingBudget,
  reserveBudget,
  type QualityIntelligenceBudgetState,
} from "../qualityIntelligence/budget.js";
import { generatePromptCandidates, type PromptCandidate } from "./candidates.js";
import { scorePromptCandidate } from "./critic.js";

// Default and limiting bounds. `candidateCount` cannot exceed the number of distinct generation
// profiles (the slate size). The defaults give the "at least three candidates" behaviour out of the box.
export const DEFAULT_CANDIDATE_COUNT = 3;
export const MAX_CANDIDATE_COUNT = PROMPT_ENHANCEMENT_PROFILE_IDS.length;
export const DEFAULT_MAX_ITERATIONS = 3;
export const DEFAULT_TOKEN_BUDGET = 8_000;

export interface OptimizePromptCandidatesArgs {
  readonly analysis: PromptTaskAnalysis;
  readonly input: RawPromptInput;
  // Optional bounds; each falls back to its default and is clamped to a safe range.
  readonly bounds?: Partial<PromptOptimizationBounds> | undefined;
  // Optional baseline profile preference, forwarded to candidate generation.
  readonly profilePreference?: PromptEnhancementProfileId | undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  if (integer < min) return min;
  if (integer > max) return max;
  return integer;
}

function resolveBounds(
  bounds: Partial<PromptOptimizationBounds> | undefined,
): PromptOptimizationBounds {
  return {
    candidateCount: clampInt(
      bounds?.candidateCount,
      DEFAULT_CANDIDATE_COUNT,
      1,
      MAX_CANDIDATE_COUNT,
    ),
    maxIterations: clampInt(
      bounds?.maxIterations,
      DEFAULT_MAX_ITERATIONS,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    tokenBudget: clampInt(bounds?.tokenBudget, DEFAULT_TOKEN_BUDGET, 1, Number.MAX_SAFE_INTEGER),
  };
}

function dimensionScore(card: PromptCandidateScorecard, dimension: PromptCriticDimension): number {
  return card.dimensionScores.find((entry) => entry.dimension === dimension)?.score ?? 0;
}

function profileRank(profile: PromptEnhancementProfileId): number {
  const index = PROMPT_ENHANCEMENT_PROFILE_IDS.indexOf(profile);
  return index < 0 ? PROMPT_ENHANCEMENT_PROFILE_IDS.length : index;
}

// Deterministic total order over scored candidates. Higher aggregate wins; ties break toward the safer,
// more complete, then leaner candidate, and finally by catalog profile order. Every candidate has a
// distinct profile (candidate generation deduplicates by selected profile), so the profile-rank key is
// a total order on its own — the winner is therefore always uniquely and stably defined.
function compareCandidates(a: PromptCandidateScorecard, b: PromptCandidateScorecard): number {
  const keys: readonly number[] = [
    b.aggregateScore - a.aggregateScore,
    dimensionScore(b, "safety") - dimensionScore(a, "safety"),
    dimensionScore(b, "completeness") - dimensionScore(a, "completeness"),
    dimensionScore(b, "token-efficiency") - dimensionScore(a, "token-efficiency"),
    profileRank(a.profile) - profileRank(b.profile),
  ];
  for (const key of keys) {
    if (key !== 0) return key < 0 ? -1 : 1;
  }
  return 0;
}

interface EvaluationOutcome {
  readonly scored: readonly PromptCandidateScorecard[];
  readonly budgetSkipped: readonly PromptCandidateRejection[];
  readonly iterations: number;
  readonly tokensConsumed: number;
}

// Evaluate the generated candidates in priority order within the token budget. The highest-priority
// (baseline) candidate is always scored so a selection always exists; each later candidate is admitted
// only while it fits the remaining budget. Every evaluated candidate counts as one iteration.
function evaluateCandidates(
  candidates: readonly PromptCandidate[],
  analysis: PromptTaskAnalysis,
  tokenBudget: number,
): EvaluationOutcome {
  const scored: PromptCandidateScorecard[] = [];
  const budgetSkipped: PromptCandidateRejection[] = [];
  let budget: QualityIntelligenceBudgetState = createBudget(tokenBudget);
  let iterations = 0;

  candidates.forEach((candidate, index) => {
    iterations += 1;
    const card = scorePromptCandidate({
      candidateId: candidate.candidateId,
      profile: candidate.profile,
      prompt: candidate.prompt,
      plan: candidate.plan,
      analysis,
    });
    const isBaseline = index === 0;
    if (isBaseline || card.estimatedTokens <= remainingBudget(budget)) {
      scored.push(card);
      budget = reserveBudget(budget, card.estimatedTokens);
      return;
    }
    budgetSkipped.push({
      candidateId: card.candidateId,
      profile: card.profile,
      aggregateScore: null,
      reason: "exceeded-token-budget",
    });
  });

  return { scored, budgetSkipped, iterations, tokensConsumed: budget.consumed };
}

/**
 * Generate, score, rank, and select the best Enhanced Prompt candidate under the configured bounds.
 * Pure. Returns the winning scorecard, every scored candidate in deterministic rank order (winner
 * first), and every rejected alternative with an auditable reason.
 *
 * Generation breadth is `min(candidateCount, maxIterations)` so no candidate is generated without being
 * evaluated; the token budget may further exclude a candidate from scoring.
 */
export function optimizePromptCandidates(
  args: OptimizePromptCandidatesArgs,
): PromptCandidateSelection {
  const bounds = resolveBounds(args.bounds);
  const generationCount = Math.min(bounds.candidateCount, bounds.maxIterations);
  const { candidates, rejected: generationRejected } = generatePromptCandidates({
    analysis: args.analysis,
    input: args.input,
    candidateCount: generationCount,
    profilePreference: args.profilePreference,
  });

  // The baseline candidate is always present (the baseline plan trivially preserves its own floor), so
  // `candidates` is non-empty and a winner always exists.
  const { scored, budgetSkipped, iterations, tokensConsumed } = evaluateCandidates(
    candidates,
    args.analysis,
    bounds.tokenBudget,
  );

  const ranked = [...scored].sort(compareCandidates);
  const [winner] = ranked;
  if (winner === undefined) {
    throw new Error("Prompt candidate optimization produced no scored candidate.");
  }

  const losers: readonly PromptCandidateRejection[] = ranked.slice(1).map((card) => ({
    candidateId: card.candidateId,
    profile: card.profile,
    aggregateScore: card.aggregateScore,
    reason: "lower-aggregate-score" as const,
  }));
  const generationRejections: readonly PromptCandidateRejection[] = generationRejected.map(
    (entry) => ({
      candidateId: entry.candidateId,
      profile: entry.profile,
      aggregateScore: null,
      reason: entry.reason,
    }),
  );

  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    winner,
    ranked,
    rejected: [...losers, ...budgetSkipped, ...generationRejections],
    bounds,
    iterations,
    candidatesConsidered: scored.length,
    tokensConsumed,
  };
}
