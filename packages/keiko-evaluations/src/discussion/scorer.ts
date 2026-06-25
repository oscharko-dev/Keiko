// Discussion Intelligence discussion-quality scorer (Epic #491, Issue #502; ADR-0065).
//
// Pure per-dimension scoring + suite aggregation for the seven discussion-quality dimensions. Each
// dimension is a pure function (observation, oracle) -> DiscussionDimensionResult. A dimension a fixture
// does not declare is "not-applicable" and excluded from aggregation.
//
// Each dimension combines a STRUCTURAL gate (presence of the mode plan's mandated apparatus — mandated
// facets, the matching directives, uncertainty / citation discipline, contradiction policy, and the
// preserved recovery context) with the fixture's oracle expectation. The structural gate is what makes
// the suite regression-sensitive: dropping a mandated facet, a directive, the uncertainty-disclosure
// flag, the citation discipline, or breaking the recovery preservation flips the corresponding
// dimension to FAIL.
//
// Determinism: pure. Rationales are harness-authored and content-free (counts, closed-vocabulary
// labels, numbers) — they never echo a topicId or any raw text.

import {
  DISAGREEMENT_FACETS,
  discussionDirectivesCoverFacets,
  type DisagreementFacet,
  type DiscussionDirective,
  type DiscussionModePlan,
} from "@oscharko-dev/keiko-contracts";
import {
  DISCUSSION_QUALITY_DIMENSIONS,
  type DiscussionDimensionResult,
  type DiscussionEvalFixture,
  type DiscussionObservation,
  type DiscussionOracle,
  type DiscussionQualityDimension,
  type DiscussionScorecardEntry,
} from "./types.js";

// The directive that, when a mode discloses uncertainty, must appear in its rendered directive set.
const UNCERTAINTY_DIRECTIVE: DiscussionDirective = "disclose-uncertainty-and-confidence";
// The directive a decision-producing mode must render.
const DECISION_DIRECTIVE: DiscussionDirective = "offer-decision-with-tradeoffs";
// The citation disciplines that REQUIRE the model to cite evidence (or explicitly state none). A
// disagreement-capable mode must carry one of these; only the option-expanding `brainstorm` mode (which
// mandates no uncertainty facet) is permitted the looser `best-effort` discipline.
const STRICT_CITATION_DISCIPLINES: readonly DiscussionModePlan["citationDiscipline"][] = [
  "require-citations",
  "require-citations-or-state-no-evidence",
];

interface Check {
  readonly label: string;
  readonly ok: boolean;
}

function gate(
  dimension: DiscussionQualityDimension,
  checks: readonly Check[],
): DiscussionDimensionResult {
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

function sameFacetSet(
  actual: readonly DisagreementFacet[],
  expected: readonly DisagreementFacet[],
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  return expected.every((facet) => actual.includes(facet));
}

// ─── Dimension scorers ─────────────────────────────────────────────────────────────
function scoreModeAppropriateness(
  obs: DiscussionObservation,
  oracle: DiscussionOracle,
): DiscussionDimensionResult {
  const plan = obs.plan;
  return gate("mode-appropriateness", [
    {
      label: "decision-recommendation flag matches expectation",
      ok: plan.producesDecisionRecommendation === oracle.expectedDecisionRecommendation,
    },
    {
      label: "decision-producing mode renders the decision directive",
      ok: !plan.producesDecisionRecommendation || plan.directives.includes(DECISION_DIRECTIVE),
    },
    { label: "mode renders at least one directive", ok: plan.directives.length > 0 },
    {
      // ER-2: a meaningful gate. The runner maps directives 1:1, so a count comparison was always
      // true. Instead assert every rendered directive is a non-empty instruction string AND that the
      // rendered directive set covers the mode's mandated disagreement facets (the contract guard),
      // so dropping or blanking a facet-covering directive flips this dimension to FAIL.
      label: "rendered directives are non-empty and cover the mandated facets",
      ok:
        obs.renderedDirectives.length > 0 &&
        obs.renderedDirectives.every((text) => typeof text === "string" && text.length > 0) &&
        discussionDirectivesCoverFacets(plan),
    },
  ]);
}

function scoreDisagreementCompleteness(
  obs: DiscussionObservation,
  oracle: DiscussionOracle,
): DiscussionDimensionResult {
  const facets = obs.plan.mandatedFacets;
  const disagreementCapable = sameFacetSet(oracle.expectedMandatedFacets, DISAGREEMENT_FACETS);
  const checks: Check[] = [
    {
      label: "mandated facets match oracle expectation",
      ok: sameFacetSet(facets, oracle.expectedMandatedFacets),
    },
  ];
  if (disagreementCapable) {
    for (const facet of DISAGREEMENT_FACETS) {
      checks.push({ label: `mandates ${facet}`, ok: facets.includes(facet) });
    }
  }
  return gate("disagreement-completeness", checks);
}

function scoreUncertaintyDiscipline(
  obs: DiscussionObservation,
  oracle: DiscussionOracle,
): DiscussionDimensionResult {
  const plan = obs.plan;
  return gate("uncertainty-discipline", [
    {
      label: "uncertainty-disclosure flag matches expectation",
      ok: plan.requiresUncertaintyDisclosure === oracle.expectedUncertaintyDisclosure,
    },
    {
      label: "disclosing modes render the uncertainty directive",
      ok: !plan.requiresUncertaintyDisclosure || plan.directives.includes(UNCERTAINTY_DIRECTIVE),
    },
    {
      label: "uncertainty facet mandated when disclosure required",
      ok: !plan.requiresUncertaintyDisclosure || plan.mandatedFacets.includes("uncertainty"),
    },
  ]);
}

function scoreEvidenceCitationDiscipline(obs: DiscussionObservation): DiscussionDimensionResult {
  const plan = obs.plan;
  // A disagreement-capable mode (one that mandates all three facets) must carry a STRICT citation
  // discipline — citing evidence is part of disagreeing with rigor. The option-expanding `brainstorm`
  // mode, which relaxes the uncertainty facet, is the only mode permitted the looser `best-effort`
  // discipline. The gate keys off the contract `citationDiscipline` field, so weakening any
  // disagreement-capable mode's discipline flips this dimension to FAIL.
  const disagreementCapable = DISAGREEMENT_FACETS.every((facet) =>
    plan.mandatedFacets.includes(facet),
  );
  return gate("evidence-citation-discipline", [
    { label: "evidence facet mandated", ok: plan.mandatedFacets.includes("evidence") },
    {
      label: "disagreement-capable modes carry a strict citation discipline",
      ok: !disagreementCapable || STRICT_CITATION_DISCIPLINES.includes(plan.citationDiscipline),
    },
  ]);
}

function scoreCorrectionHandling(
  obs: DiscussionObservation,
  oracle: DiscussionOracle,
): DiscussionDimensionResult {
  const policy = obs.plan.contradictionPolicy;
  return gate("correction-handling", [
    {
      label: "contradiction policy matches oracle expectation",
      ok:
        oracle.expectedContradictionPolicies === undefined ||
        oracle.expectedContradictionPolicies.includes(policy),
    },
    {
      label: "assumptions facet mandated for correction handling",
      ok: obs.plan.mandatedFacets.includes("assumptions"),
    },
  ]);
}

function scoreInterruptionRecovery(
  fixtureMode: DiscussionEvalFixture["mode"],
  fixtureTopicId: string,
  obs: DiscussionObservation,
): DiscussionDimensionResult {
  const recovery = obs.recovery;
  if (recovery === undefined) {
    return {
      dimension: "interruption-recovery",
      outcome: "fail",
      rationale: "failed: fixture declares interruption-recovery but no trajectory was derived.",
    };
  }
  const { initial, interrupted, recovered } = recovery;
  return gate("interruption-recovery", [
    { label: "initial turn is active", ok: initial.status === "active" },
    { label: "interrupted turn is interrupted", ok: interrupted.status === "interrupted" },
    { label: "recovered turn is recovered", ok: recovered.status === "recovered" },
    { label: "recovered mode preserved", ok: recovered.mode === fixtureMode },
    { label: "recovered topicId preserved", ok: recovered.topicId === fixtureTopicId },
    { label: "recovered turnIndex preserved", ok: recovered.turnIndex === initial.turnIndex },
  ]);
}

function scoreCapabilityGating(
  obs: DiscussionObservation,
  oracle: DiscussionOracle,
): DiscussionDimensionResult {
  return gate("capability-gating", [
    {
      label: "voice-gating verdict matches profile expectation",
      ok: obs.gatingAllowed === oracle.expectedGatingAllowed,
    },
  ]);
}

function scoreDimension(
  dimension: DiscussionQualityDimension,
  fixture: DiscussionEvalFixture,
  obs: DiscussionObservation,
): DiscussionDimensionResult {
  const oracle = fixture.oracle;
  switch (dimension) {
    case "mode-appropriateness":
      return scoreModeAppropriateness(obs, oracle);
    case "disagreement-completeness":
      return scoreDisagreementCompleteness(obs, oracle);
    case "uncertainty-discipline":
      return scoreUncertaintyDiscipline(obs, oracle);
    case "evidence-citation-discipline":
      return scoreEvidenceCitationDiscipline(obs);
    case "correction-handling":
      return scoreCorrectionHandling(obs, oracle);
    case "interruption-recovery":
      return scoreInterruptionRecovery(fixture.mode, fixture.topicId, obs);
    case "capability-gating":
      return scoreCapabilityGating(obs, oracle);
  }
}

/**
 * Score one fixture's observation across all seven dimensions. A dimension the fixture does not declare
 * is "not-applicable". Pure.
 */
export function scoreDiscussionQuality(
  fixture: DiscussionEvalFixture,
  obs: DiscussionObservation,
): readonly DiscussionDimensionResult[] {
  return DISCUSSION_QUALITY_DIMENSIONS.map((dimension) =>
    fixture.dimensions.has(dimension)
      ? scoreDimension(dimension, fixture, obs)
      : {
          dimension,
          outcome: "not-applicable" as const,
          rationale: "not exercised by this fixture.",
        },
  );
}

// ─── Suite aggregation ─────────────────────────────────────────────────────────────
function aggregateDimension(
  dimension: DiscussionQualityDimension,
  results: readonly (readonly DiscussionDimensionResult[])[],
): DiscussionScorecardEntry {
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

export function aggregateDiscussionQuality(
  results: readonly (readonly DiscussionDimensionResult[])[],
): readonly DiscussionScorecardEntry[] {
  return DISCUSSION_QUALITY_DIMENSIONS.map((dimension) => aggregateDimension(dimension, results));
}
