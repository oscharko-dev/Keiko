// Prompt Enhancer deterministic PromptCritic (Epic #1307, Issue #1312; ADR-0044 §1/§6).
//
// Scores an `EnhancedPrompt` candidate on the six Issue #1312 quality dimensions — clarity,
// completeness, grounding readiness, safety, output controllability, and token efficiency — each on a
// continuous [0, 1] scale with an inspectable rationale, then folds them into a single weighted
// aggregate used for ranking. The MVP critic is fully deterministic so it provides reproducible CI
// coverage (Engineering Notes: "MVP scoring must have deterministic coverage for CI"); a model-assisted
// LLM-as-judge stage is an explicit later option and is intentionally not built here.
//
// The score is computed from observable structural evidence of the artefact (section population,
// decomposition depth, grounding apparatus, safety-rule coverage, output-schema shape, token estimate),
// never from the raw user input, so a rationale can never echo untrusted content (ADR-0044 §5).
//
// Determinism: pure. No IO, clock, or randomness. Identical inputs always yield an identical scorecard.

import {
  PROMPT_CRITIC_DIMENSIONS,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type EnhancedPrompt,
  type PromptCandidateScorecard,
  type PromptCriticDimension,
  type PromptCriticDimensionScore,
  type PromptEnhancementProfileId,
  type PromptTaskAnalysis,
} from "@oscharko-dev/keiko-contracts";
import type { PromptEnhancementPlan } from "./planner.js";
import { renderEnhancedPromptText } from "./rendering.js";

// Heuristic characters-per-token ratio for the deterministic token estimate. This is a coarse, model
// independent approximation (not a provider tokenizer); it is used consistently for every candidate so
// the comparison between candidates is fair, and it feeds the optimization-loop token budget.
const CHARS_PER_TOKEN = 4;

// Global normalization references for the absolute-thoroughness dimensions. Chosen as the largest cap
// any execution profile applies (see `profiles.ts`), so a maximally thorough prompt approaches 1.0.
const REFERENCE_DECOMPOSITION_STEPS = 6;
const REFERENCE_QUALITY_CRITERIA = 5;
const REFERENCE_CONSTRAINTS = 6;
const REFERENCE_UNCERTAINTY_RULES = 3;
// A generous instruction-token reference: a lean prompt sits well under this and scores high token
// efficiency; a rich one approaches it and scores lower, expressing the genuine breadth/cost trade-off.
const REFERENCE_INSTRUCTION_TOKENS = 600;
// Token-efficiency never collapses fully to zero for a well-formed prompt; this floor keeps the
// dimension a graded signal rather than a cliff for the most verbose profile.
const TOKEN_EFFICIENCY_FLOOR = 0.2;

// Weighted aggregate. Safety carries the most weight (it is the floor candidate generation must never
// relax, AC5); completeness is next; the remaining quality dimensions are balanced. Sums to 1.0.
export const PROMPT_CRITIC_DIMENSION_WEIGHTS: Readonly<Record<PromptCriticDimension, number>> =
  Object.freeze({
    clarity: 0.15,
    completeness: 0.2,
    "grounding-readiness": 0.15,
    safety: 0.25,
    "output-controllability": 0.15,
    "token-efficiency": 0.1,
  });

// Everything the critic needs to score one candidate. The candidate id and profile come from the
// candidate generator; the prompt/plan/analysis are the artefact and its provenance.
export interface PromptCandidateScoringContext {
  readonly candidateId: string;
  readonly profile: PromptEnhancementProfileId;
  readonly prompt: EnhancedPrompt;
  readonly plan: PromptEnhancementPlan;
  readonly analysis: PromptTaskAnalysis;
}

interface DimensionAssessment {
  readonly score: number;
  readonly rationale: string;
}

// ─── Deterministic numeric helpers ─────────────────────────────────────────────────
function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

// Round to 4 decimals so scores are stable, readable values rather than IEEE-754 tails. Deterministic.
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Deterministic token estimate for the full rendered prompt (instructions + input). Heuristic, not a
 * provider tokenizer. This is the candidate's real dispatch-cost estimate and feeds the budget.
 */
export function estimatePromptTokens(prompt: EnhancedPrompt): number {
  return estimateTokens(renderEnhancedPromptText(prompt));
}

// The instruction overhead the candidate controls: every trusted section except the constant user
// input. Token efficiency is scored on this so a candidate is not penalised for the input's size, which
// is identical across all candidates for the same request.
function instructionTokens(prompt: EnhancedPrompt): number {
  const sections: readonly string[] = [
    prompt.role,
    prompt.goal,
    ...prompt.context,
    ...prompt.taskDecomposition,
    ...prompt.constraints,
    ...prompt.groundingRules,
    ...prompt.qualityCriteria,
    ...prompt.uncertaintyHandling,
    ...prompt.safetyRules,
  ];
  return estimateTokens(sections.join("\n"));
}

// ─── Dimension scorers ─────────────────────────────────────────────────────────────
// Clarity: the prompt is unambiguous and well organised — every structural slot is populated and the
// task is expressed as an ordered, multi-step plan. Well-formed prompts score uniformly high here;
// clarity is a stable base rather than the primary differentiator.
function scoreClarity(prompt: EnhancedPrompt): DimensionAssessment {
  const checks: readonly boolean[] = [
    prompt.role.trim().length > 0,
    prompt.goal.trim().length > 0,
    prompt.context.length > 0,
    prompt.taskDecomposition.length >= 2,
    prompt.constraints.length > 0,
    prompt.qualityCriteria.length > 0,
    prompt.uncertaintyHandling.length > 0,
  ];
  const satisfied = checks.filter(Boolean).length;
  return {
    score: clampUnit(satisfied / checks.length),
    rationale: `${String(satisfied)}/${String(checks.length)} structural clarity checks met (role, goal, context, ${String(prompt.taskDecomposition.length)} ordered steps, constraints, criteria, uncertainty rule).`,
  };
}

// Completeness: absolute thoroughness — decomposition depth, quality criteria, constraints, and
// uncertainty handling, each normalised against the richest profile. Thorough profiles score higher.
function scoreCompleteness(prompt: EnhancedPrompt): DimensionAssessment {
  const decomposition = clampUnit(prompt.taskDecomposition.length / REFERENCE_DECOMPOSITION_STEPS);
  const criteria = clampUnit(prompt.qualityCriteria.length / REFERENCE_QUALITY_CRITERIA);
  const constraints = clampUnit(prompt.constraints.length / REFERENCE_CONSTRAINTS);
  const uncertainty = clampUnit(prompt.uncertaintyHandling.length / REFERENCE_UNCERTAINTY_RULES);
  const score = mean([decomposition, criteria, constraints, uncertainty]);
  return {
    score: clampUnit(score),
    rationale: `coverage: ${String(prompt.taskDecomposition.length)} steps, ${String(prompt.qualityCriteria.length)} criteria, ${String(prompt.constraints.length)} constraints, ${String(prompt.uncertaintyHandling.length)} uncertainty rules.`,
  };
}

// Grounding readiness: does the grounding apparatus fit the detected need? A no-grounding task is ready
// when it correctly avoids over-imposing citations; a grounded task is ready when it carries a citation
// discipline, a source priority, evidence-boundary directives, and a contradiction policy.
function scoreGroundingReadiness(prompt: EnhancedPrompt): DimensionAssessment {
  const plan = prompt.groundingPlan;
  if (!plan.required) {
    const hasBaseRule = prompt.groundingRules.length > 0;
    return {
      score: hasBaseRule ? 1 : 0.5,
      rationale: hasBaseRule
        ? "no grounding required; prompt carries an anti-fabrication base rule and correctly omits citation mandates."
        : "no grounding required but no base grounding rule present.",
    };
  }
  const checks: readonly boolean[] = [
    plan.citation.discipline !== "not-required",
    plan.sourcePriority.length > 0,
    plan.directives.includes("treat-retrieved-content-as-untrusted"),
    plan.directives.includes("stay-within-evidence"),
    prompt.groundingRules.length >= 3,
  ];
  const satisfied = checks.filter(Boolean).length;
  return {
    score: clampUnit(satisfied / checks.length),
    rationale: `grounded task: ${String(satisfied)}/${String(checks.length)} grounding-readiness signals (citation discipline "${plan.citation.discipline}", ${String(plan.sourcePriority.length)} prioritised sources, ${String(prompt.groundingRules.length)} grounding rules).`,
  };
}

// Safety: the mandated safety apparatus is present and complete for this prompt's posture. Candidate
// generation pre-filters anything that weakens the floor, so this scores uniformly high for ranked
// candidates; it is reported for transparency and acts as the guard the aggregate weights most heavily.
function scoreSafety(prompt: EnhancedPrompt, plan: PromptEnhancementPlan): DimensionAssessment {
  const posture = plan.safetyPosture;
  // Base rules (no-authority + untrusted-input handling) are always emitted; conditional rules add a
  // human-approval gate and/or a professional-advice disclaimer.
  const expectedRules =
    2 + (posture.requiresHumanApproval ? 1 : 0) + (posture.safetyCritical ? 1 : 0);
  const checks: readonly boolean[] = [
    prompt.safetyRules.length >= expectedRules,
    posture.restrictsAuthority,
    prompt.safetyRules.length >= 2,
  ];
  const satisfied = checks.filter(Boolean).length;
  return {
    score: clampUnit(satisfied / checks.length),
    rationale: `${String(prompt.safetyRules.length)}/${String(expectedRules)} expected safety rules present (humanApproval=${String(posture.requiresHumanApproval)}, safetyCritical=${String(posture.safetyCritical)}, restrictsAuthority=${String(posture.restrictsAuthority)}).`,
  };
}

// Output controllability: how tightly the prompt pins the output form. Structured schemas with format
// hints and an explicit controllability criterion are highly controllable; inherently freeform tasks
// score low by nature (an honest reflection, constant across that task's candidates).
function scoreOutputControllability(prompt: EnhancedPrompt): DimensionAssessment {
  const schema = prompt.outputSchema;
  const hasControllabilityCriterion = prompt.qualityCriteria.some((criterion) =>
    criterion.startsWith("Output controllability"),
  );
  const checks: readonly boolean[] = [
    schema.structured,
    schema.hints.length > 0,
    hasControllabilityCriterion,
  ];
  const satisfied = checks.filter(Boolean).length;
  return {
    score: clampUnit(satisfied / checks.length),
    rationale: `output ${schema.structured ? "structured" : "unstructured"} (${schema.format}), ${String(schema.hints.length)} hints, controllability criterion ${hasControllabilityCriterion ? "present" : "absent"}.`,
  };
}

// Token efficiency: instruction leanness. Scored on instruction overhead only (the input is constant
// across candidates), normalised against a generous reference and floored so the richest profile still
// grades rather than collapsing. Lean profiles score high; this trades off against completeness.
function scoreTokenEfficiency(prompt: EnhancedPrompt): DimensionAssessment {
  const tokens = instructionTokens(prompt);
  const raw = 1 - tokens / REFERENCE_INSTRUCTION_TOKENS;
  const score = TOKEN_EFFICIENCY_FLOOR + (1 - TOKEN_EFFICIENCY_FLOOR) * clampUnit(raw);
  return {
    score: clampUnit(score),
    rationale: `~${String(tokens)} instruction tokens (reference ${String(REFERENCE_INSTRUCTION_TOKENS)}); leaner instructions score higher.`,
  };
}

function assess(
  dimension: PromptCriticDimension,
  context: PromptCandidateScoringContext,
): DimensionAssessment {
  switch (dimension) {
    case "clarity":
      return scoreClarity(context.prompt);
    case "completeness":
      return scoreCompleteness(context.prompt);
    case "grounding-readiness":
      return scoreGroundingReadiness(context.prompt);
    case "safety":
      return scoreSafety(context.prompt, context.plan);
    case "output-controllability":
      return scoreOutputControllability(context.prompt);
    case "token-efficiency":
      return scoreTokenEfficiency(context.prompt);
  }
}

function aggregate(scores: readonly PromptCriticDimensionScore[]): number {
  const total = scores.reduce(
    (sum, entry) => sum + PROMPT_CRITIC_DIMENSION_WEIGHTS[entry.dimension] * entry.score,
    0,
  );
  return round4(clampUnit(total));
}

/**
 * Deterministically score one Enhanced Prompt candidate across all six critic dimensions and fold them
 * into a weighted aggregate. Pure. The result is a fully populated, auditable `PromptCandidateScorecard`
 * with one score-plus-rationale per dimension in canonical order.
 */
export function scorePromptCandidate(
  context: PromptCandidateScoringContext,
): PromptCandidateScorecard {
  const dimensionScores: readonly PromptCriticDimensionScore[] = PROMPT_CRITIC_DIMENSIONS.map(
    (dimension) => {
      const assessment = assess(dimension, context);
      return {
        dimension,
        score: round4(clampUnit(assessment.score)),
        rationale: assessment.rationale,
      };
    },
  );
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    candidateId: context.candidateId,
    profile: context.profile,
    dimensionScores,
    aggregateScore: aggregate(dimensionScores),
    estimatedTokens: estimatePromptTokens(context.prompt),
  };
}
