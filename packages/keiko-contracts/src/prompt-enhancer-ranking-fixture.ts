// KEIKO-1026 — the shared ranking-order fixture.
//
// The deterministic candidate total order (aggregate score, then safety, completeness and
// token-efficiency, then profile position) is implemented TWICE and cannot be shared as code:
// keiko-model-gateway's `compareCandidates` ranks candidates, keiko-contracts'
// `compareRankedScorecards` validates that a persisted selection is already in that order, and
// keiko-contracts is the leaf — it may not import the gateway (ADR-0019 direction 1).
//
// Two independent implementations of one total order drift silently: the validator would start
// rejecting selections the producer emits, and neither suite would notice, because each only ever
// exercised its own copy. This fixture is the link. It is plain DATA — no formula, no import from
// either implementation — and both suites assert the SAME expected order against it, so a change to
// either comparator turns exactly one of them red.
//
// Living in keiko-contracts is what makes it reachable from both sides: the gateway already depends
// on contracts, and contracts depends on nothing.

import {
  PROMPT_CRITIC_DIMENSIONS,
  type PromptCandidateScorecard,
} from "./prompt-enhancer-critic.js";
import { PROMPT_ENHANCER_SCHEMA_VERSION } from "./prompt-enhancer.js";

interface RankingFixtureInput {
  readonly candidateId: string;
  readonly profile: PromptCandidateScorecard["profile"];
  readonly aggregateScore: number;
  readonly safety: number;
  readonly completeness: number;
  readonly tokenEfficiency: number;
}

// Every dimension is present in canonical order (the scorecard contract requires exactly one entry
// per PROMPT_CRITIC_DIMENSIONS member); only the three tie-break dimensions carry meaningful values.
function scorecardOf(input: RankingFixtureInput): PromptCandidateScorecard {
  const byDimension: Readonly<Record<string, number>> = {
    safety: input.safety,
    completeness: input.completeness,
    "token-efficiency": input.tokenEfficiency,
  };
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    candidateId: input.candidateId,
    profile: input.profile,
    dimensionScores: PROMPT_CRITIC_DIMENSIONS.map((dimension) => ({
      dimension,
      score: byDimension[dimension] ?? 0.5,
      rationale: "fixture",
    })),
    aggregateScore: input.aggregateScore,
    estimatedTokens: 100,
  };
}

// Deliberately supplied OUT of rank order, so a comparator that returns 0 for everything (or that
// preserves input order) fails rather than accidentally passing.
const RANKING_FIXTURE_INPUTS: readonly RankingFixtureInput[] = [
  // Loses on profile position only — every score is identical to `agg-high-safety-high`.
  {
    candidateId: "tie-profile-late",
    profile: "agentic",
    aggregateScore: 0.9,
    safety: 0.9,
    completeness: 0.8,
    tokenEfficiency: 0.7,
  },
  // Lowest aggregate: last regardless of its perfect dimension scores.
  {
    candidateId: "agg-low",
    profile: "fast",
    aggregateScore: 0.1,
    safety: 1,
    completeness: 1,
    tokenEfficiency: 1,
  },
  // Same aggregate and safety as the winner, lower completeness.
  {
    candidateId: "tie-completeness-lower",
    profile: "fast",
    aggregateScore: 0.9,
    safety: 0.9,
    completeness: 0.5,
    tokenEfficiency: 1,
  },
  // The winner: highest aggregate, highest safety, highest completeness, earliest profile.
  {
    candidateId: "agg-high-safety-high",
    profile: "fast",
    aggregateScore: 0.9,
    safety: 0.9,
    completeness: 0.8,
    tokenEfficiency: 0.7,
  },
  // Same aggregate as the winner, lower safety — safety outranks completeness and efficiency.
  {
    candidateId: "tie-safety-lower",
    profile: "fast",
    aggregateScore: 0.9,
    safety: 0.4,
    completeness: 1,
    tokenEfficiency: 1,
  },
  // Same aggregate, safety and completeness as the winner; lower token efficiency.
  {
    candidateId: "tie-efficiency-lower",
    profile: "fast",
    aggregateScore: 0.9,
    safety: 0.9,
    completeness: 0.8,
    tokenEfficiency: 0.2,
  },
];

/** Unordered scorecards to feed a ranker or a sortedness validator. */
export const PROMPT_CANDIDATE_RANKING_FIXTURE: readonly PromptCandidateScorecard[] = Object.freeze(
  RANKING_FIXTURE_INPUTS.map(scorecardOf),
);

/**
 * The one correct order for `PROMPT_CANDIDATE_RANKING_FIXTURE`, by candidateId, winner first.
 *
 * Both implementations of the total order must produce exactly this. Written out by hand from the
 * documented rule — never derived from either comparator, which would make the fixture agree with
 * whichever one it was derived from.
 */
export const PROMPT_CANDIDATE_RANKING_EXPECTED_ORDER: readonly string[] = Object.freeze([
  "agg-high-safety-high",
  "tie-profile-late",
  "tie-efficiency-lower",
  "tie-completeness-lower",
  "tie-safety-lower",
  "agg-low",
]);
