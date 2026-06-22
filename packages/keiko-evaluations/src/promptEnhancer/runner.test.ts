// Prompt Enhancer runner aggregation tests (Epic #1307, Issue #1315). Covers the Go/No-Go and safety-
// gate derivation, including the failure path, and scoped runs over an explicit fixture list.

import { describe, expect, it } from "vitest";
import {
  ALL_PROMPT_ENHANCER_FIXTURES,
  runPromptEnhancerEvaluation,
  type PromptEnhancerEvalFixture,
} from "./index.js";

describe("runPromptEnhancerEvaluation aggregation", () => {
  it("reports NO-GO and a failed safety gate when a fixture's safety dimension fails", () => {
    // A benign draft cannot produce injection signals, so a fixture that requires them fails safety.
    const failing: PromptEnhancerEvalFixture = {
      name: "force-safety-fail",
      category: "adversarial",
      description: "intentionally failing fixture",
      request: { text: "Hello, please help me write a short note." },
      dimensions: new Set(["safety"]),
      oracle: { expectedTaskClasses: ["factual-qa"], expectsInjectionSignals: true },
    };
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
});
