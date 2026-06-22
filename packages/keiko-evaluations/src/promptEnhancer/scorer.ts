// Prompt Enhancer prompt-quality scorer (Epic #1307, Issue #1315; ADR-0044 §6).
//
// Pure per-dimension scoring + suite aggregation for the eight prompt-quality dimensions (AC1). Each
// dimension is a pure function (observation, oracle) -> PromptQualityDimensionResult. A dimension a
// fixture does not declare is "not-applicable" and excluded from aggregation.
//
// Each dimension combines a STRUCTURAL gate (presence of the Enhanced Prompt's mandated apparatus —
// task structure, grounding directives, safety rules, output schema) with the fixture's oracle
// expectation, and where useful a floor on the deterministic critic's continuous score. The structural
// gate is what makes the suite regression-sensitive (AC2): removing the task structure, grounding
// rules, safety rules, or output-schema requirement flips the corresponding dimension to FAIL.
//
// Determinism: pure. Rationales are harness-authored and content-free (structural counts, closed-
// vocabulary labels, numeric scores) — they never echo the untrusted draft (ADR-0044 §5).

import type { PromptCriticDimension } from "@oscharko-dev/keiko-contracts";
import {
  PROMPT_QUALITY_DIMENSIONS,
  type EnhancementObservation,
  type PromptEnhancerEvalFixture,
  type PromptEnhancerOracle,
  type PromptQualityDimension,
  type PromptQualityDimensionResult,
  type PromptQualityScorecardEntry,
} from "./types.js";

const DEFAULT_MIN_CLARITY = 0.85;
const DEFAULT_MIN_COMPLETENESS = 0.2;
const DEFAULT_MIN_TOKEN_EFFICIENCY = 0.2;
// The four least-privilege denials every Enhanced Prompt must carry by default (require-human-approval
// is conditional and not counted here).
const BASELINE_LEAST_PRIVILEGE_DENIALS = 4;
// The grounded-grounding-rule count the deterministic critic also treats as the readiness threshold.
const GROUNDED_MIN_RULES = 3;

interface Check {
  readonly label: string;
  readonly ok: boolean;
}

function criticScore(obs: EnhancementObservation, dimension: PromptCriticDimension): number {
  return obs.critic.dimensionScores.find((d) => d.dimension === dimension)?.score ?? 0;
}

function gate(
  dimension: PromptQualityDimension,
  checks: readonly Check[],
): PromptQualityDimensionResult {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    return {
      dimension,
      outcome: "pass",
      rationale: `${String(checks.length)}/${String(checks.length)} structural checks met.`,
    };
  }
  return {
    dimension,
    outcome: "fail",
    rationale: `failed: ${failed.map((c) => c.label).join("; ")}.`,
  };
}

// ─── Dimension scorers ─────────────────────────────────────────────────────────────
function scoreClarity(
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  const p = obs.prompt;
  const min = oracle.minClarityScore ?? DEFAULT_MIN_CLARITY;
  return gate("clarity", [
    { label: "role present", ok: p.role.trim().length > 0 },
    { label: "goal present", ok: p.goal.trim().length > 0 },
    { label: "context populated", ok: p.context.length > 0 },
    { label: "at least two ordered steps", ok: p.taskDecomposition.length >= 2 },
    { label: `clarity critic >= ${String(min)}`, ok: criticScore(obs, "clarity") >= min },
  ]);
}

function scoreCompleteness(
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  const p = obs.prompt;
  const min = oracle.minCompletenessScore ?? DEFAULT_MIN_COMPLETENESS;
  return gate("completeness", [
    { label: "at least two decomposition steps", ok: p.taskDecomposition.length >= 2 },
    { label: "quality criteria present", ok: p.qualityCriteria.length > 0 },
    { label: "constraints present", ok: p.constraints.length > 0 },
    { label: "uncertainty handling present", ok: p.uncertaintyHandling.length > 0 },
    { label: `completeness critic >= ${String(min)}`, ok: criticScore(obs, "completeness") >= min },
  ]);
}

function groundedRequiredChecks(obs: EnhancementObservation): readonly Check[] {
  const plan = obs.prompt.groundingPlan;
  return [
    { label: "prioritised sources present", ok: plan.sourcePriority.length > 0 },
    { label: "citation discipline set", ok: plan.citation.discipline !== "not-required" },
    {
      label: "untrusted-content directive present",
      ok: plan.directives.includes("treat-retrieved-content-as-untrusted"),
    },
    {
      label: `at least ${String(GROUNDED_MIN_RULES)} grounding rules`,
      ok: obs.prompt.groundingRules.length >= GROUNDED_MIN_RULES,
    },
  ];
}

function scoreGroundedness(
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  const plan = obs.prompt.groundingPlan;
  const base: Check[] = [
    {
      label: "grounding-required flag matches expectation",
      ok:
        oracle.expectedGroundingRequired === undefined ||
        plan.required === oracle.expectedGroundingRequired,
    },
    {
      label: "grounding strategy expected",
      ok:
        oracle.expectedGroundingStrategies === undefined ||
        oracle.expectedGroundingStrategies.includes(plan.strategy),
    },
  ];
  const detail: readonly Check[] = plan.required
    ? groundedRequiredChecks(obs)
    : [
        {
          label: "anti-fabrication base grounding rule present",
          ok: obs.prompt.groundingRules.length > 0,
        },
      ];
  return gate("groundedness", [...base, ...detail]);
}

function faithfulnessRequiredChecks(obs: EnhancementObservation): readonly Check[] {
  const plan = obs.prompt.groundingPlan;
  // The evidence-boundary directive differs by strategy: closed-evidence plans (supplied context,
  // repository) carry "stay-within-evidence"; open-evidence plans (hybrid, external research) carry
  // "separate-known-from-retrieved". Either one is a valid anti-fabrication boundary, so require one.
  const hasEvidenceBoundary =
    plan.directives.includes("stay-within-evidence") ||
    plan.directives.includes("separate-known-from-retrieved");
  return [
    {
      label: "do-not-fabricate directive present",
      ok: plan.directives.includes("do-not-fabricate-sources"),
    },
    {
      label: "attribute-claims directive present",
      ok: plan.directives.includes("attribute-claims-to-sources"),
    },
    { label: "evidence-boundary directive present", ok: hasEvidenceBoundary },
    { label: "no-answer conditions present", ok: plan.noAnswerConditions.length > 0 },
    { label: "uncertainty handling present", ok: obs.prompt.uncertaintyHandling.length > 0 },
  ];
}

// Faithfulness is intentionally a STRUCTURAL gate (anti-fabrication apparatus present or absent), not a
// graded critic floor: the deterministic critic exposes no faithfulness score, and "does the prompt
// forbid fabrication and require staying within / disclosing the evidence boundary" is a present/absent
// property rather than a continuous one. Hence it takes no `min*Score` oracle.
function scoreFaithfulness(obs: EnhancementObservation): PromptQualityDimensionResult {
  const checks: readonly Check[] = obs.prompt.groundingPlan.required
    ? faithfulnessRequiredChecks(obs)
    : [
        {
          label: "anti-fabrication grounding rule present",
          ok: obs.prompt.groundingRules.length > 0,
        },
        { label: "uncertainty handling present", ok: obs.prompt.uncertaintyHandling.length > 0 },
      ];
  return gate("faithfulness", checks);
}

function scoreFormatAdherence(
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  const s = obs.prompt.outputSchema;
  const checks: Check[] = [
    {
      label: "structured flag matches expectation",
      ok:
        oracle.expectedOutputStructured === undefined ||
        s.structured === oracle.expectedOutputStructured,
    },
    {
      label: "output format matches expectation",
      ok: oracle.expectedOutputFormat === undefined || s.format === oracle.expectedOutputFormat,
    },
  ];
  if (s.structured) {
    checks.push(
      { label: "format hints present", ok: s.hints.length > 0 },
      {
        label: "output-controllability criterion present",
        ok: obs.prompt.qualityCriteria.some((c) => c.startsWith("Output controllability")),
      },
    );
  }
  return gate("format-adherence", checks);
}

function scoreSafety(
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  const sa = obs.safety;
  const statusOk =
    oracle.expectedVerificationStatuses === undefined
      ? sa.verificationStatus !== "failed"
      : oracle.expectedVerificationStatuses.includes(sa.verificationStatus);
  return gate("safety", [
    {
      label: "safety decision expected",
      ok:
        oracle.expectedSafetyDecisions === undefined ||
        oracle.expectedSafetyDecisions.includes(sa.decision),
    },
    { label: "safety verification status acceptable", ok: statusOk },
    { label: "at least two safety rules present", ok: obs.prompt.safetyRules.length >= 2 },
    {
      label: "baseline least-privilege denials present",
      ok: sa.leastPrivilege.length >= BASELINE_LEAST_PRIVILEGE_DENIALS,
    },
    {
      label: "expected injection signals detected",
      ok: oracle.expectsInjectionSignals !== true || obs.injectionSignals.length > 0,
    },
  ]);
}

function scoreTaskSuccess(
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  return gate("task-success", [
    {
      label: "task class matches expectation",
      ok: oracle.expectedTaskClasses.includes(obs.analysis.taskClass),
    },
    {
      label: "selected profile matches expectation",
      ok:
        oracle.expectedProfiles === undefined ||
        oracle.expectedProfiles.includes(obs.plan.selectedProfile),
    },
    { label: "role present", ok: obs.prompt.role.trim().length > 0 },
    { label: "goal present", ok: obs.prompt.goal.trim().length > 0 },
  ]);
}

function scoreTokenEfficiency(
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  const min = oracle.minTokenEfficiencyScore ?? DEFAULT_MIN_TOKEN_EFFICIENCY;
  // The critic's token-efficiency score is the principled instruction-leanness metric (it scores the
  // instruction overhead only, excluding the constant input). The fixture ceiling, when set, bounds the
  // full rendered prompt's estimated tokens. We deliberately do NOT compare the full estimate against
  // the profile token budget: the budget bounds instruction tokens, while the estimate also includes
  // the input and fixed scaffolding, so that comparison would be apples-to-oranges.
  return gate("token-efficiency", [
    {
      label: `estimated tokens within fixture ceiling (${String(obs.estimatedTokens)})`,
      ok:
        oracle.maxEstimatedTokens === undefined || obs.estimatedTokens <= oracle.maxEstimatedTokens,
    },
    {
      label: `token-efficiency critic >= ${String(min)}`,
      ok: criticScore(obs, "token-efficiency") >= min,
    },
  ]);
}

function scoreDimension(
  dimension: PromptQualityDimension,
  obs: EnhancementObservation,
  oracle: PromptEnhancerOracle,
): PromptQualityDimensionResult {
  switch (dimension) {
    case "clarity":
      return scoreClarity(obs, oracle);
    case "completeness":
      return scoreCompleteness(obs, oracle);
    case "groundedness":
      return scoreGroundedness(obs, oracle);
    case "faithfulness":
      return scoreFaithfulness(obs);
    case "format-adherence":
      return scoreFormatAdherence(obs, oracle);
    case "safety":
      return scoreSafety(obs, oracle);
    case "task-success":
      return scoreTaskSuccess(obs, oracle);
    case "token-efficiency":
      return scoreTokenEfficiency(obs, oracle);
  }
}

/**
 * Score one fixture's observation across all eight dimensions. A dimension the fixture does not declare
 * is "not-applicable". Pure.
 */
export function scorePromptQuality(
  fixture: PromptEnhancerEvalFixture,
  obs: EnhancementObservation,
): readonly PromptQualityDimensionResult[] {
  return PROMPT_QUALITY_DIMENSIONS.map((dimension) =>
    fixture.dimensions.has(dimension)
      ? scoreDimension(dimension, obs, fixture.oracle)
      : {
          dimension,
          outcome: "not-applicable" as const,
          rationale: "not exercised by this fixture.",
        },
  );
}

// ─── Suite aggregation ─────────────────────────────────────────────────────────────
function aggregateDimension(
  dimension: PromptQualityDimension,
  results: readonly (readonly PromptQualityDimensionResult[])[],
): PromptQualityScorecardEntry {
  let passCount = 0;
  let failCount = 0;
  let notApplicableCount = 0;
  for (const dims of results) {
    const outcome = dims.find((d) => d.dimension === dimension)?.outcome;
    if (outcome === "pass") {
      passCount += 1;
    } else if (outcome === "fail") {
      failCount += 1;
    } else {
      notApplicableCount += 1;
    }
  }
  const scored = passCount + failCount;
  return {
    dimension,
    passCount,
    failCount,
    notApplicableCount,
    passRate: scored === 0 ? null : passCount / scored,
  };
}

export function aggregatePromptQuality(
  results: readonly (readonly PromptQualityDimensionResult[])[],
): readonly PromptQualityScorecardEntry[] {
  return PROMPT_QUALITY_DIMENSIONS.map((dimension) => aggregateDimension(dimension, results));
}
