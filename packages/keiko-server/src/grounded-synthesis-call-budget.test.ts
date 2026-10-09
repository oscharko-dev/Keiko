import { describe, expect, it } from "vitest";
import {
  createGroundedSynthesisCallBudget,
  createGroundedSynthesisAttemptAdmission,
  groundedSynthesisAttemptUsage,
  normalizeGroundedAnswerPayload,
} from "./grounded-answer.js";

describe("factory-owned physical synthesis allowance", () => {
  it("retains unreported failed output exposure rather than granting a retry from measured zero", () => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 220,
      outputTokensMax: 80,
    });
    tracker
      .admission({ promptTokens: 100, maxOutputTokens: 80 })
      ?.settle(undefined, true, "unknown");
    expect(budget.pendingUsage()).toEqual({ promptTokens: 100, completionTokens: 80 });
    expect(budget.reservedOutputTokens()).toBe(80);
    expect(tracker.admission({ promptTokens: 100, maxOutputTokens: 80 })).toBeUndefined();
    expect(budget.remaining()).toBe(1);
  });
  it("admits internal retry only inside the same original input and two-attempt grants", () => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 220,
      outputTokensMax: 80,
    });
    tracker.admission({ promptTokens: 100, maxOutputTokens: 80 })?.settle(undefined, true);
    const second = tracker.admission({ promptTokens: 100, maxOutputTokens: 80 });
    second?.settle({ promptTokens: 120, completionTokens: 7 }, true);
    second?.settle({ promptTokens: 120, completionTokens: 7 }, true);
    expect(budget.takeUsage()).toEqual({ promptTokens: 220, completionTokens: 7 });
    expect(tracker.admission({ promptTokens: 1, maxOutputTokens: 1 })).toBeUndefined();
    expect(budget.remaining()).toBe(0);
  });

  it("refuses an internal retry whose prompt no longer fits the original input grant", () => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 150,
      outputTokensMax: 80,
    });
    tracker.admission({ promptTokens: 100, maxOutputTokens: 80 })?.settle(undefined, true);
    expect(tracker.admission({ promptTokens: 100, maxOutputTokens: 80 })).toBeUndefined();
    expect(budget.remaining()).toBe(1);
    expect(budget.pendingUsage()).toEqual({ promptTokens: 100, completionTokens: 0 });
  });

  it("releases a local reservation when spend admission refuses before provider dispatch", () => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 100,
      outputTokensMax: 80,
    });
    tracker.admission({ promptTokens: 100, maxOutputTokens: 80 })?.settle(undefined, false);
    expect(budget.remaining()).toBe(2);
    expect(budget.pendingUsage()).toEqual({ promptTokens: 0, completionTokens: 0 });
    tracker.settleFallback(100, { promptTokens: 1, completionTokens: 1 });
    expect(budget.remaining()).toBe(2);
  });
  it("charges actual prompt estimates and retains only reported output for failed attempts", () => {
    expect(groundedSynthesisAttemptUsage(321)).toEqual({ promptTokens: 321, completionTokens: 0 });
    expect(groundedSynthesisAttemptUsage(321, { promptTokens: 400, completionTokens: 17 })).toEqual(
      {
        promptTokens: 400,
        completionTokens: 17,
      },
    );
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
