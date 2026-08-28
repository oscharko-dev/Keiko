// Discussion Intelligence scorer unit tests (Epic #491, Issue #502). Mutation-robust per-dimension
// coverage: each test perturbs exactly one structural input of an observation or oracle and asserts the
// corresponding dimension flips to FAIL, so a single-line regression in the scorer or a contract drift
// cannot pass silently. Pure inputs; no model, clock, or randomness.

import { describe, expect, it } from "vitest";
import type { DiscussionModePlan } from "@oscharko-dev/keiko-contracts";
import {
  beginDiscussionTurn,
  discussionModePlan,
} from "@oscharko-dev/keiko-contracts/runtime/discussion-intelligence";
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
      expectsRecoveredContext: false,
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

  // ─── KEIKO-0258 — isolated pins for the two remaining mode-appropriateness checks ───
  // "decision-producing mode renders the decision directive" (scorer.ts:92-94)
  it("fails when a decision-producing plan drops the offer-decision-with-tradeoffs directive", () => {
    // `decide` produces a decision recommendation. Drop offer-decision-with-tradeoffs (a
    // no-facet-covering directive) while keeping every other check satisfied:
    //   - producesDecisionRecommendation stays true, oracle expects true → line 89 passes
    //   - remaining directives (cite-evidence-or-state-none, list-explicit-assumptions,
    //     disclose-uncertainty-and-confidence, defer-to-user-on-unresolved-contradiction) still cover
    //     the mandated facets (evidence, assumptions, uncertainty) → line 101-106 passes
    //   - renderedDirectives non-empty → line 101 passes
    //   - plan.directives.length > 0 → line 95 passes
    // The only check that fires is the decision-directive presence.
    const f = fixtureFor("decide", ["mode-appropriateness"]);
    const obs = observationFor("decide");
    const directives = obs.plan.directives.filter(
      (directive) => directive !== "offer-decision-with-tradeoffs",
    );
    const mutated: DiscussionObservation = {
      ...obs,
      plan: { ...obs.plan, directives },
      renderedDirectives: directives.map(() => "rendered"),
    };
    expect(outcomeOf(f, mutated, "mode-appropriateness")).toBe("fail");
  });

  // "mode renders at least one directive" (scorer.ts:95) — isolate this specific check.
  it("fails when plan.directives is empty while every other sibling check still passes", () => {
    // Empty plan.directives forces line 95 (plan.directives.length > 0) to fail. To keep the sibling
    // "rendered directives cover facets" check (line 101-106) passing, we ALSO empty mandatedFacets so
    // discussionDirectivesCoverFacets returns true trivially; renderedDirectives stays non-empty. The
    // decision-directive check is inert on `challenge` (producesDecisionRecommendation=false), and the
    // oracle-vs-plan flag check trivially agrees (both false).
    const f = fixtureFor("challenge", ["mode-appropriateness"]);
    const obs = observationFor("challenge");
    const mutated: DiscussionObservation = {
      ...obs,
      plan: { ...obs.plan, directives: [], mandatedFacets: [] },
      // Keep renderedDirectives non-empty so line 101 (`renderedDirectives.length > 0`) still passes.
      renderedDirectives: ["rendered"],
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

  // KEIKO-0258: isolate the `flag matches expectation` check (scorer.ts:136-138) by mutating ONLY the
  // oracle's expected value away from the plan's actual value. The disclosure-directive sibling (line
  // 141-142) and mandated-facet sibling (line 145-146) both still hold because we haven't changed the
  // plan itself — only the oracle. Only the flag-match check fires.
  it("fails when the oracle's expectedUncertaintyDisclosure disagrees with the plan", () => {
    const f = fixtureFor("review", ["uncertainty-discipline"], {
      expectedUncertaintyDisclosure: false,
    });
    expect(outcomeOf(f, observationFor("review"), "uncertainty-discipline")).toBe("fail");
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

  // KEIKO-0663: expectedContradictionPolicies is optional, so a fixture that declares
  // correction-handling without setting it must fail closed, not pass vacuously. Explicitly
  // unset the field (not merely omitted from overrides, and not set to `undefined` -- disallowed
  // under exactOptionalPropertyTypes for an already-optional readonly field -- but genuinely
  // absent, via rest-destructuring) to prove the check itself, independent of the sibling
  // "assumptions facet mandated" check.
  it("fails closed when the oracle omits expectedContradictionPolicies entirely", () => {
    const f = fixtureFor("evidence-check", ["correction-handling"]);
    const {
      expectedContradictionPolicies: _expectedContradictionPolicies,
      ...oracleWithoutPolicies
    } = f.oracle;
    void _expectedContradictionPolicies;
    const fWithoutPolicies: DiscussionEvalFixture = { ...f, oracle: oracleWithoutPolicies };
    expect(
      outcomeOf(fWithoutPolicies, observationFor("evidence-check"), "correction-handling"),
    ).toBe("fail");
  });

  // KEIKO-0258: isolate the `assumptions facet mandated for correction handling` check
  // (scorer.ts:183-184). Drop assumptions from mandatedFacets while leaving the contradiction-policy
  // sibling satisfied — the oracle still lists the plan's policy so line 178-181 passes; only the
  // assumptions-facet check fires.
  it("fails when the mandatedFacets drop 'assumptions' for a correction-handling fixture", () => {
    const f = fixtureFor("evidence-check", ["correction-handling"]);
    const obs = observationFor("evidence-check");
    const mutated: DiscussionObservation = {
      ...obs,
      plan: {
        ...obs.plan,
        mandatedFacets: obs.plan.mandatedFacets.filter((facet) => facet !== "assumptions"),
      },
    };
    expect(outcomeOf(f, mutated, "correction-handling")).toBe("fail");
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

  // KEIKO-0552: expectsRecoveredContext must actually gate the preservation outcome, not just be
  // declared. Together these two tests pin all four (expected × observed) truth-table quadrants
  // for the field — the (true, true) pass case is covered by the previous test and the
  // (true, false) fail case by "fails when the fixture declares recovery but no trajectory is
  // derived" below. A fixture that expects recovery to NOT preserve context but observes
  // preservation anyway must fail (proves the field is READ, not inert documentation), and the
  // symmetric quadrant — expects no-preservation and observes no-preservation — must pass
  // (proves the field is honoured on the "agree" side, not defaulted to always-fail).
  it("fails when the oracle expects no preserved context but the recovery preserves it anyway", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: false });
    expect(outcomeOf(f, recoveryObs(), "interruption-recovery")).toBe("fail");
  });

  it("passes when the oracle expects no preserved context and the recovery drops it (KEIKO-0552 symmetric)", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: false });
    const obs = recoveryObs();
    const recovery = obs.recovery;
    if (recovery === undefined) throw new Error("recoveryObs must derive a trajectory");
    // Drop the topicId on the recovered turn so preservation-check reports "context lost".
    const notPreserved: DiscussionObservation = {
      ...obs,
      recovery: {
        ...recovery,
        recovered: { ...recovery.recovered, topicId: "different-topic" },
      },
    };
    expect(outcomeOf(f, notPreserved, "interruption-recovery")).toBe("pass");
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

  // KEIKO-0258: isolate the three trajectory-status checks (scorer.ts:204-206), each mutated one at a
  // time. mode/topicId/turnIndex remain preserved so lines 207-209 all pass; the only failing check is
  // the specific status the sub-test perturbs.
  it("fails when the initial-turn status is not 'active'", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    const obs = recoveryObs();
    const recovery = obs.recovery;
    expect(recovery).toBeDefined();
    if (recovery === undefined) {
      return;
    }
    const mutated: DiscussionObservation = {
      ...obs,
      recovery: { ...recovery, initial: { ...recovery.initial, status: "interrupted" } },
    };
    expect(outcomeOf(f, mutated, "interruption-recovery")).toBe("fail");
  });

  it("fails when the interrupted-turn status is not 'interrupted'", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    const obs = recoveryObs();
    const recovery = obs.recovery;
    expect(recovery).toBeDefined();
    if (recovery === undefined) {
      return;
    }
    const mutated: DiscussionObservation = {
      ...obs,
      recovery: { ...recovery, interrupted: { ...recovery.interrupted, status: "active" } },
    };
    expect(outcomeOf(f, mutated, "interruption-recovery")).toBe("fail");
  });

  it("fails when the recovered-turn status is not 'recovered'", () => {
    const f = fixtureFor("decide", ["interruption-recovery"], { expectsRecoveredContext: true });
    const obs = recoveryObs();
    const recovery = obs.recovery;
    expect(recovery).toBeDefined();
    if (recovery === undefined) {
      return;
    }
    const mutated: DiscussionObservation = {
      ...obs,
      recovery: { ...recovery, recovered: { ...recovery.recovered, status: "active" } },
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
