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
  type PromptSafetyAssessment,
  type PromptTaskAnalysis,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import {
  createBudget,
  remainingBudget,
  reserveBudget,
  type QualityIntelligenceBudgetState,
} from "../qualityIntelligence/budget.js";
import { generatePromptCandidates } from "./candidates.js";
import { estimatePromptTokens, scorePromptCandidate } from "./critic.js";
import { screenCandidatesForSafety, type ScreenedPromptCandidate } from "./validate.js";

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

/**
 * Rank scored candidates by the deterministic total order (winner first). Pure; does not mutate the
 * input. Exposed so callers (and tests) can rank a scorecard set without re-running the loop.
 */
export function rankCandidates(
  scorecards: readonly PromptCandidateScorecard[],
): readonly PromptCandidateScorecard[] {
  return [...scorecards].sort(compareCandidates);
}

export function rankedLoserReason(
  winner: PromptCandidateScorecard,
  loser: PromptCandidateScorecard,
): Extract<PromptCandidateRejection["reason"], "lower-aggregate-score" | "lower-tie-break-rank"> {
  return loser.aggregateScore < winner.aggregateScore
    ? "lower-aggregate-score"
    : "lower-tie-break-rank";
}

interface EvaluationOutcome {
  readonly scored: readonly PromptCandidateScorecard[];
  readonly scoredSafetyAssessments: readonly PromptSafetyAssessment[];
  readonly budgetSkipped: readonly PromptCandidateRejection[];
  readonly tokensConsumed: number;
}

// Evaluate generated candidates in priority order. A candidate is scored only when its deterministic
// token estimate fits the remaining budget; otherwise it is rejected before scoring.
function evaluateCandidates(
  screenedCandidates: readonly ScreenedPromptCandidate[],
  analysis: PromptTaskAnalysis,
  tokenBudget: number,
): EvaluationOutcome {
  const scored: PromptCandidateScorecard[] = [];
  const scoredSafetyAssessments: PromptSafetyAssessment[] = [];
  const budgetSkipped: PromptCandidateRejection[] = [];
  let budget: QualityIntelligenceBudgetState = createBudget(tokenBudget);

  screenedCandidates.forEach(({ candidate, assessment }) => {
    const estimatedTokens = estimatePromptTokens(candidate.prompt);
    if (estimatedTokens > remainingBudget(budget)) {
      budgetSkipped.push({
        candidateId: candidate.candidateId,
        profile: candidate.profile,
        aggregateScore: null,
        reason: "exceeded-token-budget",
      });
      return;
    }
    const card = scorePromptCandidate({
      candidateId: candidate.candidateId,
      profile: candidate.profile,
      prompt: candidate.prompt,
      plan: candidate.plan,
      analysis,
    });
    scored.push(card);
    scoredSafetyAssessments.push(assessment);
    budget = reserveBudget(budget, card.estimatedTokens);
  });

  return { scored, scoredSafetyAssessments, budgetSkipped, tokensConsumed: budget.consumed };
}

function loserRejections(
  winner: PromptCandidateScorecard,
  ranked: readonly PromptCandidateScorecard[],
): readonly PromptCandidateRejection[] {
  return ranked.slice(1).map((card) => ({
    candidateId: card.candidateId,
    profile: card.profile,
    aggregateScore: card.aggregateScore,
    reason: rankedLoserReason(winner, card),
  }));
}

function generationRejections(
  rejected: ReturnType<typeof generatePromptCandidates>["rejected"],
): readonly PromptCandidateRejection[] {
  return rejected.map((entry) => ({
    candidateId: entry.candidateId,
    profile: entry.profile,
    aggregateScore: null,
    reason: entry.reason,
  }));
}

function safetyRejections(
  rejected: readonly ScreenedPromptCandidate[],
): readonly PromptCandidateRejection[] {
  return rejected.map(({ candidate }) => ({
    candidateId: candidate.candidateId,
    profile: candidate.profile,
    aggregateScore: null,
    reason: "safety-validation-failed",
  }));
}

function rankedSafetyAssessmentsFor(
  ranked: readonly PromptCandidateScorecard[],
  assessments: readonly PromptSafetyAssessment[],
): readonly PromptSafetyAssessment[] {
  const safetyByCandidateId = new Map<string, PromptSafetyAssessment>(
    assessments.map((assessment) => [assessment.promptId, assessment]),
  );
  return ranked.map((card) => {
    const assessment = safetyByCandidateId.get(card.candidateId);
    if (assessment === undefined) {
      throw new Error("Prompt candidate optimization lost safety assessment for ranked candidate.");
    }
    return assessment;
  });
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
  const safetyScreen = screenCandidatesForSafety(candidates, args.analysis, args.input);

  const { scored, scoredSafetyAssessments, budgetSkipped, tokensConsumed } = evaluateCandidates(
    safetyScreen.safe,
    args.analysis,
    bounds.tokenBudget,
  );

  const ranked = rankCandidates(scored);
  const [winner] = ranked;
  if (winner === undefined) {
    throw new Error("Prompt candidate optimization produced no scored candidate.");
  }

  const rankedSafetyAssessments = rankedSafetyAssessmentsFor(ranked, scoredSafetyAssessments);
  const [winnerSafetyAssessment] = rankedSafetyAssessments;
  if (winnerSafetyAssessment === undefined) {
    throw new Error("Prompt candidate optimization produced no safety assessment.");
  }

  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    winner,
    ranked,
    winnerSafetyAssessment,
    rankedSafetyAssessments,
    rejected: [
      ...loserRejections(winner, ranked),
      ...budgetSkipped,
      ...safetyRejections(safetyScreen.rejected),
      ...generationRejections(generationRejected),
    ],
    bounds,
    iterations: candidates.length,
    candidatesConsidered: scored.length,
    tokensConsumed,
  };
}
