import { describe, expect, it, vi } from "vitest";
import { CallerAttemptAdmissionError } from "@oscharko-dev/keiko-model-gateway";
import {
  ConversationModelNotReadyError,
  withConversationReadinessAdmission,
} from "./conversation-readiness-admission.js";
import {
  createGroundedSynthesisCallBudget,
  createGroundedSynthesisAttemptAdmission,
  groundedSynthesisAttemptUsage,
  normalizeGroundedAnswerPayload,
} from "./grounded-answer.js";

describe("factory-owned physical synthesis allowance", () => {
  it("does not charge provider usage for a readiness refusal before dispatch", async () => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 220,
      outputTokensMax: 80,
    });
    const providerCall = vi.fn(() => {
      throw new Error("The refused request must not reach the provider");
    });
    const model = withConversationReadinessAdmission(
      { call: providerCall },
      "changed-model",
      { modelId: "admitted-model" },
      {},
    );
    const failure: unknown = await Promise.resolve()
      .then(() =>
        model.call(
          { modelId: "changed-model", messages: [], attemptAdmission: tracker.admission },
          new AbortController().signal,
        ),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversationModelNotReadyError);
    tracker.settleFallbackFailure(100, failure);
    expect(providerCall).not.toHaveBeenCalled();
    expect(budget.pendingUsage()).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(budget.reservedOutputTokens()).toBe(0);
    expect(budget.remaining()).toBe(2);
  });

  it("keeps dispatched injected caller failures conservatively unknown", () => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 220,
      outputTokensMax: 80,
    });
    tracker.settleFallbackFailure(100, new CallerAttemptAdmissionError("Injected caller refusal"));
    expect(budget.pendingUsage()).toEqual({ promptTokens: 100, completionTokens: 80 });
    expect(budget.reservedOutputTokens()).toBe(80);
    expect(budget.remaining()).toBe(1);
  });
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
  it("reduces the actual retry output cap after a reported partial completion", () => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 220,
      outputTokensMax: 80,
    });
    tracker
      .admission({ promptTokens: 100, maxOutputTokens: 80 })
      ?.settle({ promptTokens: 41, completionTokens: 7 }, true, "observed");
    expect(tracker.admission({ promptTokens: 100, maxOutputTokens: 80 })?.maxOutputTokens).toBe(73);
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

it("retains cumulative usage while classifying only the confirmed tool-call attempt as orchestration", () => {
  const budget = createGroundedSynthesisCallBudget();
  const tracker = createGroundedSynthesisAttemptAdmission(budget, {
    inputTokensMax: 1000,
    outputTokensMax: 100,
  });
  tracker
    .admission({ promptTokens: 100, maxOutputTokens: 100 })
    ?.settle({ promptTokens: 100, completionTokens: 5 }, true, "none");
  tracker
    .admission({ promptTokens: 100, maxOutputTokens: 95 })
    ?.settle({ promptTokens: 100, completionTokens: 5 }, true, "observed");
  tracker.confirmToolRound();
  expect(budget.remaining()).toBe(1);
  expect(budget.pendingUsage()).toEqual({ promptTokens: 200, completionTokens: 10 });
  expect(() => {
    tracker.confirmToolRound();
  }).toThrow();
  tracker
    .admission({ promptTokens: 100, maxOutputTokens: 90 })
    ?.settle({ promptTokens: 100, completionTokens: 5 }, true, "observed");
  expect(budget.remaining()).toBe(0);
  expect(tracker.admission({ promptTokens: 1, maxOutputTokens: 1 })).toBeUndefined();
});

it.each(["pending", "undispatched", "unknown"] as const)(
  "never reclassifies a %s attempt to recover synthesis authority",
  (state) => {
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 1000,
      outputTokensMax: 100,
    });
    const reservation = tracker.admission({ promptTokens: 100, maxOutputTokens: 100 });
    if (state === "undispatched") reservation?.settle(undefined, false, "none");
    if (state === "unknown") reservation?.settle(undefined, true, "unknown");
    expect(() => {
      tracker.confirmToolRound();
    }).toThrow();
    expect(budget.remaining()).toBe(state === "undispatched" ? 2 : 1);
  },
);

it("never replenishes token or deadline grants when complete tool rounds release synthesis slots", () => {
  const budget = createGroundedSynthesisCallBudget();
  let now = 1;
  const tracker = createGroundedSynthesisAttemptAdmission(budget, {
    inputTokensMax: 220,
    outputTokensMax: 80,
    deadlineAtMs: 100,
    nowMs: () => now,
  });
  for (let round = 0; round < 2; round++) {
    tracker
      .admission({ promptTokens: 100, maxOutputTokens: 80 })
      ?.settle({ promptTokens: 100, completionTokens: 5 }, true, "observed");
    tracker.confirmToolRound();
  }
  expect(budget.remaining()).toBe(2);
  expect(budget.pendingUsage()).toEqual({ promptTokens: 200, completionTokens: 10 });
  expect(tracker.admission({ promptTokens: 21, maxOutputTokens: 80 })).toBeUndefined();
  expect(tracker.admission({ promptTokens: 20, maxOutputTokens: 80 })?.maxOutputTokens).toBe(70);
  now = 100;
  expect(() => tracker.admission({ promptTokens: 1, maxOutputTokens: 1 })).toThrow();
});
