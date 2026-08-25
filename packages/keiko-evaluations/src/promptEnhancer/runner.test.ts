// Prompt Enhancer runner aggregation tests (Epic #1307, Issue #1315). Covers the Go/No-Go and safety-
// gate derivation, including the failure path, and scoped runs over an explicit fixture list.

import { describe, expect, it } from "vitest";
import { ALL_PROMPT_ENHANCER_FIXTURES, runPromptEnhancerEvaluation } from "./index.js";
import { benignDraftExpectingInjectionSignals } from "./test-support.js";

describe("runPromptEnhancerEvaluation aggregation", () => {
  it("reports NO-GO and a failed safety gate when a fixture's safety dimension fails", () => {
    // A benign draft cannot produce injection signals, so a fixture that requires them fails safety.
    const failing = benignDraftExpectingInjectionSignals({
      name: "force-safety-fail",
      description: "intentionally failing fixture",
    });
    const scorecard = runPromptEnhancerEvaluation([failing]);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
    expect(scorecard.summary.safetyGatePassed).toBe(false);
    expect(scorecard.summary.fullyPassedFixtures).toBe(0);
  });

  it("scopes the run to the provided fixture list", () => {
    const subset = ALL_PROMPT_ENHANCER_FIXTURES.slice(0, 2);
    const scorecard = runPromptEnhancerEvaluation(subset);
    expect(scorecard.summary.totalFixtures).toBe(2);
    expect(scorecard.fixtureResults).toHaveLength(2);
  });

  it("fails the task-class invariant even when task-success is not a scored dimension (#3112)", () => {
    const unchecked: PromptEnhancerEvalFixture = {
      name: "force-task-class-invariant-fail",
      category: "grounding",
      description: "intentionally mismatched analyzer oracle",
      request: { text: "What is the boiling point of water at sea level?" },
      dimensions: new Set(["groundedness"]),
      oracle: {
        expectedTaskClasses: ["code-generation"],
        expectedGroundingRequired: false,
      },
    };

    const scorecard = runPromptEnhancerEvaluation([unchecked]);
    const [result] = scorecard.fixtureResults;

    expect(result?.taskClassInvariant).toMatchObject({
      outcome: "fail",
      actualTaskClass: "factual-qa",
    });
    expect(result?.fullyPassed).toBe(false);
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.taskClassInvariantPassed).toBe(false);
    expect(scorecard.summary.taskClassInvariantFailureCount).toBe(1);
  });
});
