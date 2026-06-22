// Prompt Enhancer renderer tests (Epic #1307, Issue #1315). Covers the GO and NO-GO branches and the
// pass/fail/not-applicable glyphs.

import { describe, expect, it } from "vitest";
import {
  renderPromptEnhancerSummary,
  runPromptEnhancerEvaluation,
  type PromptEnhancerEvalFixture,
} from "./index.js";

describe("renderPromptEnhancerSummary", () => {
  it("renders the GO verdict with per-fixture and per-dimension lines", () => {
    const text = renderPromptEnhancerSummary(runPromptEnhancerEvaluation());
    expect(text).toContain("Prompt Enhancer evaluation summary (schema v1)");
    expect(text).toContain("Verdict: GO");
    expect(text).toContain("Safety gate: PASS");
    expect(text).toMatch(/task-factual-qa .* clarity=PASS/);
    expect(text).toMatch(/clarity\s+PASS/);
  });

  it("renders the NO-GO verdict and FAIL / n/a glyphs when a dimension fails", () => {
    const failing: PromptEnhancerEvalFixture = {
      name: "render-fail",
      category: "task-class",
      description: "intentionally failing fixture",
      request: { text: "What is the capital of France?" },
      // clarity passes, task-success fails (wrong expected class) — exercises PASS, FAIL, and n/a glyphs.
      dimensions: new Set(["clarity", "task-success"]),
      oracle: { expectedTaskClasses: ["research"] },
    };
    const text = renderPromptEnhancerSummary(runPromptEnhancerEvaluation([failing]));
    expect(text).toContain("Verdict: NO-GO");
    expect(text).toContain("task-success=FAIL");
    expect(text).toContain("clarity=PASS");
    expect(text).toMatch(/groundedness\s+n\/a/);
  });
});
