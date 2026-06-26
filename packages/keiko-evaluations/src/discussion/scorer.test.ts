// Discussion Intelligence scorer unit tests (Epic #491, Issue #502). Mutation-robust per-dimension
// coverage: each test perturbs exactly one structural input of an observation or oracle and asserts the
// corresponding dimension flips to FAIL, so a single-line regression in the scorer or a contract drift
// cannot pass silently. Pure inputs; no model, clock, or randomness.

import { describe, expect, it } from "vitest";
import {
  beginDiscussionTurn,
  discussionModePlan,
  type DiscussionModePlan,
} from "@oscharko-dev/keiko-contracts";
import { aggregateDiscussionQuality, scoreDiscussionQuality } from "./scorer.js";
import type {
  DiscussionEvalFixture,
  DiscussionObservation,
  DiscussionQualityDimension,
} from "./types.js";

function observationFor(mode: DiscussionModePlan["mode"]): DiscussionObservation {
  const plan = discussionModePlan(mode);
  return {
    plan,
    renderedDirectives: plan.directives.map(() => "rendered"),
    gatingAllowed: false,
  };
}

function fixtureFor(
  mode: DiscussionModePlan["mode"],
  dimensions: readonly DiscussionQualityDimension[],
  oracleOverrides: Partial<DiscussionEvalFixture["oracle"]> = {},
): DiscussionEvalFixture {
  const plan = discussionModePlan(mode);
  return {
    name: `unit-${mode}`,
    category: "no-voice",
    description: "unit fixture",
    profile: "none",
    mode,
    topicId: "unit-topic",
    dimensions: new Set(dimensions),
    oracle: {
      expectedMandatedFacets: plan.mandatedFacets,
      expectedGatingAllowed: false,
      expectedUncertaintyDisclosure: plan.requiresUncertaintyDisclosure,
      expectedDecisionRecommendation: plan.producesDecisionRecommendation,
      expectedContradictionPolicies: [plan.contradictionPolicy],
      ...oracleOverrides,
    },
  };
}

function outcomeOf(
  fixture: DiscussionEvalFixture,
  obs: DiscussionObservation,
  dimension: DiscussionQualityDimension,
): string | undefined {
  return scoreDiscussionQuality(fixture, obs).find((d) => d.dimension === dimension)?.outcome;
}

describe("scoreDiscussionQuality - mode-appropriateness", () => {
  it("passes when the decision flag matches the oracle", () => {
    const f = fixtureFor("decide", ["mode-appropriateness"]);
    expect(outcomeOf(f, observationFor("decide"), "mode-appropriateness")).toBe("pass");
  });

  it("fails when the oracle's decision expectation is mutated", () => {
    const f = fixtureFor("decide", ["mode-appropriateness"], {
      expectedDecisionRecommendation: false,
    });
    expect(outcomeOf(f, observationFor("decide"), "mode-appropriateness")).toBe("fail");
  });

  it("fails when the rendered directives are emptied", () => {
    const f = fixtureFor("challenge", ["mode-appropriateness"]);
    const obs = observationFor("challenge");
    const mutated: DiscussionObservation = { ...obs, renderedDirectives: [] };
    expect(outcomeOf(f, mutated, "mode-appropriateness")).toBe("fail");
  });

  it("fails when a rendered directive is a blank string", () => {
    const f = fixtureFor("challenge", ["mode-appropriateness"]);
    const obs = observationFor("challenge");
    const blanked = [...obs.renderedDirectives];
    blanked[0] = "";
    const mutated: DiscussionObservation = { ...obs, renderedDirectives: blanked };
    expect(outcomeOf(f, mutated, "mode-appropriateness")).toBe("fail");
  });

  it("fails when the plan no longer covers a mandated facet (ER-2 meaningful gate)", () => {
    // Mutate `decide` to drop every directive that covers the mandated `evidence` facet, while keeping
    // the rendered directives non-empty. The pre-fix count check passed this; the cover-facets gate
    // catches it.
    const f = fixtureFor("decide", ["mode-appropriateness"]);
    const obs = observationFor("decide");
    const directives = obs.plan.directives.filter(
      (directive) => directive !== "cite-evidence-or-state-none",
    );
    const mutated: DiscussionObservation = {
      ...obs,
      plan: { ...obs.plan, directives },
      renderedDirectives: directives.map(() => "rendered"),
    };
    expect(outcomeOf(f, mutated, "mode-appropriateness")).toBe("fail");
  });
});

describe("scoreDiscussionQuality - disagreement-completeness", () => {
  it("passes when all three facets are mandated for a disagreement-capable mode", () => {
    const f = fixtureFor("challenge", ["disagreement-completeness"]);
    expect(outcomeOf(f, observationFor("challenge"), "disagreement-completeness")).toBe("pass");
  });

  it("fails when a mandated facet is dropped from the observation", () => {
    const f = fixtureFor("challenge", ["disagreement-completeness"]);
    const obs = observationFor("challenge");
    const mutated: DiscussionObservation = {
      ...obs,
      plan: { ...obs.plan, mandatedFacets: ["evidence", "assumptions"] },
    };
    expect(outcomeOf(f, mutated, "disagreement-completeness")).toBe("fail");
  });

  it("passes for brainstorm with its relaxed two-facet expectation", () => {
    const f = fixtureFor("brainstorm", ["disagreement-completeness"]);
    expect(outcomeOf(f, observationFor("brainstorm"), "disagreement-completeness")).toBe("pass");
  });
});

describe("scoreDiscussionQuality - uncertainty-discipline", () => {
  it("passes when disclosure is required and the directive is rendered", () => {
    const f = fixtureFor("review", ["uncertainty-discipline"]);
    expect(outcomeOf(f, observationFor("review"), "uncertainty-discipline")).toBe("pass");
  });

  it("fails when a disclosing mode loses the uncertainty directive", () => {
    const f = fixtureFor("review", ["uncertainty-discipline"]);
    const obs = observationFor("review");
    const mutated: DiscussionObservation = {
      ...obs,
      plan: {
        ...obs.plan,
        directives: obs.plan.directives.filter((d) => d !== "disclose-uncertainty-and-confidence"),
      },
    };
    expect(outcomeOf(f, mutated, "uncertainty-discipline")).toBe("fail");
  });

  it("passes for brainstorm which relaxes uncertainty disclosure", () => {
    const f = fixtureFor("brainstorm", ["uncertainty-discipline"]);
    expect(outcomeOf(f, observationFor("brainstorm"), "uncertainty-discipline")).toBe("pass");
  });
});

describe("scoreDiscussionQuality - evidence-citation-discipline", () => {
  it("passes when evidence is mandated and a citation directive is present", () => {
    const f = fixtureFor("evidence-check", ["evidence-citation-discipline"]);
    expect(outcomeOf(f, observationFor("evidence-check"), "evidence-citation-discipline")).toBe(
      "pass",
    );
  });

  it("fails when a disagreement-capable mode's citation discipline is weakened to best-effort", () => {
    const f = fixtureFor("evidence-check", ["evidence-citation-discipline"]);
    const obs = observationFor("evidence-check");
    const mutated: DiscussionObservation = {
      ...obs,
      plan: { ...obs.plan, citationDiscipline: "best-effort" },
    };
    expect(outcomeOf(f, mutated, "evidence-citation-discipline")).toBe("fail");
  });

  it("fails when the evidence facet is dropped from a disagreement-capable mode", () => {
    const f = fixtureFor("evidence-check", ["evidence-citation-discipline"]);
    const obs = observationFor("evidence-check");
    const mutated: DiscussionObservation = {
      ...obs,
      plan: { ...obs.plan, mandatedFacets: ["assumptions", "uncertainty"] },
    };
    expect(outcomeOf(f, mutated, "evidence-citation-discipline")).toBe("fail");
  });

  it("permits the option-expanding brainstorm mode its looser best-effort discipline", () => {
    const f = fixtureFor("brainstorm", ["evidence-citation-discipline"]);
    expect(outcomeOf(f, observationFor("brainstorm"), "evidence-citation-discipline")).toBe("pass");
  });
});

describe("scoreDiscussionQuality - correction-handling", () => {
  it("passes when the contradiction policy matches the oracle", () => {
    const f = fixtureFor("evidence-check", ["correction-handling"]);
    expect(outcomeOf(f, observationFor("evidence-check"), "correction-handling")).toBe("pass");
  });

  it("fails when the oracle expects a different contradiction policy", () => {
    const f = fixtureFor("evidence-check", ["correction-handling"], {
      expectedContradictionPolicies: ["synthesize-with-caveats"],
    });
    expect(outcomeOf(f, observationFor("evidence-check"), "correction-handling")).toBe("fail");
  });
});

describe("scoreDiscussionQuality - interruption-recovery", () => {
  function recoveryObs(): DiscussionObservation {
    const initial = beginDiscussionTurn("decide", "unit-topic", 0);
    return {
      ...observationFor("decide"),
      recovery: {
        initial,
        interrupted: { ...initial, status: "interrupted" },
        recovered: { ...initial, status: "recovered" },
      },
    };
  }

  it("passes when the recovered context preserves mode/topicId/turnIndex", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    expect(outcomeOf(f, recoveryObs(), "interruption-recovery")).toBe("pass");
  });

  it("fails when the fixture declares recovery but no trajectory is derived", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    expect(outcomeOf(f, observationFor("decide"), "interruption-recovery")).toBe("fail");
  });

  it("fails when the recovered context drops the original topicId", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    const obs = recoveryObs();
    const recovery = obs.recovery;
    expect(recovery).toBeDefined();
    if (recovery === undefined) {
      return;
    }
    const mutated: DiscussionObservation = {
      ...obs,
      recovery: {
        ...recovery,
        recovered: { ...recovery.recovered, topicId: "different-topic" },
      },
    };
    expect(outcomeOf(f, mutated, "interruption-recovery")).toBe("fail");
  });

  it("fails when the recovered context carries the wrong mode (AC4 fail-path)", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    const obs = recoveryObs();
    const recovery = obs.recovery;
    expect(recovery).toBeDefined();
    if (recovery === undefined) {
      return;
    }
    const mutated: DiscussionObservation = {
      ...obs,
      recovery: {
        ...recovery,
        recovered: { ...recovery.recovered, mode: "challenge" },
      },
    };
    expect(outcomeOf(f, mutated, "interruption-recovery")).toBe("fail");
  });

  it("fails when the recovered turnIndex differs from the initial (AC4 fail-path)", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    const obs = recoveryObs();
    const recovery = obs.recovery;
    expect(recovery).toBeDefined();
    if (recovery === undefined) {
      return;
    }
    const mutated: DiscussionObservation = {
      ...obs,
      recovery: {
        ...recovery,
        recovered: { ...recovery.recovered, turnIndex: recovery.initial.turnIndex + 1 },
      },
    };
    expect(outcomeOf(f, mutated, "interruption-recovery")).toBe("fail");
  });
});

describe("scoreDiscussionQuality - capability-gating", () => {
  it("passes when the gating verdict matches the oracle", () => {
    const f = fixtureFor("review", ["capability-gating"], { expectedGatingAllowed: true });
    const obs: DiscussionObservation = { ...observationFor("review"), gatingAllowed: true };
    expect(outcomeOf(f, obs, "capability-gating")).toBe("pass");
  });

  it("fails when the observed gating verdict diverges from the oracle", () => {
    const f = fixtureFor("review", ["capability-gating"], { expectedGatingAllowed: true });
    expect(outcomeOf(f, observationFor("review"), "capability-gating")).toBe("fail");
  });
});

describe("scoreDiscussionQuality - applicability", () => {
  it("marks undeclared dimensions not-applicable", () => {
    const f = fixtureFor("challenge", ["capability-gating"]);
    const results = scoreDiscussionQuality(f, observationFor("challenge"));
    const recovery = results.find((d) => d.dimension === "interruption-recovery");
    expect(recovery?.outcome).toBe("not-applicable");
  });
});

describe("aggregateDiscussionQuality", () => {
  it("computes pass/fail/not-applicable counts and pass rate per dimension", () => {
    const passResult = scoreDiscussionQuality(
      fixtureFor("challenge", ["mode-appropriateness"]),
      observationFor("challenge"),
    );
    const failResult = scoreDiscussionQuality(
      fixtureFor("decide", ["mode-appropriateness"], { expectedDecisionRecommendation: false }),
      observationFor("decide"),
    );
    const aggregated = aggregateDiscussionQuality([passResult, failResult]);
    const entry = aggregated.find((e) => e.dimension === "mode-appropriateness");
    expect(entry?.passCount).toBe(1);
    expect(entry?.failCount).toBe(1);
    expect(entry?.passRate).toBe(0.5);
  });

  it("reports a null pass rate for a dimension no fixture exercised", () => {
    const onlyGating = scoreDiscussionQuality(
      fixtureFor("challenge", ["capability-gating"]),
      observationFor("challenge"),
    );
    const aggregated = aggregateDiscussionQuality([onlyGating]);
    const entry = aggregated.find((e) => e.dimension === "interruption-recovery");
    expect(entry?.passRate).toBeNull();
    expect(entry?.notApplicableCount).toBe(1);
  });
});
