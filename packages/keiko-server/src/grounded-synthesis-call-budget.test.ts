import { describe, expect, it } from "vitest";
import {
  createGroundedSynthesisCallBudget,
  groundedSynthesisAttemptUsage,
  normalizeGroundedAnswerPayload,
} from "./grounded-answer.js";

describe("factory-owned physical synthesis allowance", () => {
  it("charges actual prompt estimates and retains only reported output for failed attempts", () => {
    expect(groundedSynthesisAttemptUsage(321)).toEqual({ promptTokens: 321, completionTokens: 0 });
    expect(groundedSynthesisAttemptUsage(321, { promptTokens: 400, completionTokens: 17 })).toEqual({
      promptTokens: 400,
      completionTokens: 17,
    });
    expect(groundedSynthesisAttemptUsage(321, { promptTokens: 1, completionTokens: 3 })).toEqual({
      promptTokens: 321,
      completionTokens: 3,
    });
  });
  it("holds the two-dispatch ceiling across usage settlement", () => {
    const budget = createGroundedSynthesisCallBudget();
    expect(budget.tryReserve()).toBe(true);
    budget.recordUsage({ promptTokens: 321, completionTokens: 0 });
    const snapshot = budget.pendingUsage();
    budget.recordUsage({ promptTokens: 17, completionTokens: 3 });
    expect(snapshot).toEqual({ promptTokens: 321, completionTokens: 0 });
    expect(budget.takeUsage()).toEqual({ promptTokens: 338, completionTokens: 3 });
    expect(budget.pendingUsage()).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(budget.tryReserve()).toBe(true);
    expect(budget.tryReserve()).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it("preserves an actual attempt count during answer normalization", () => {
    expect(
      normalizeGroundedAnswerPayload({
        content: "A substantive answer.",
        usage: { promptTokens: 338, completionTokens: 3 },
        synthesisCallCount: 2,
      }),
    ).toMatchObject({ synthesisCallCount: 2 });
    expect(normalizeGroundedAnswerPayload("An injected answer.")).not.toHaveProperty(
      "synthesisCallCount",
    );
  });
});
