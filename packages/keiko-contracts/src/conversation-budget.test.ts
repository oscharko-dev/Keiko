// Unit tests for estimateConversationBudget (Issue #151 / Epic #142).
//
// Token counts are APPROXIMATE (bytes/4) by design. Tests assert the rounding
// behavior, pressure-band thresholds, and that connected-context byte counts
// from #177/#189/#204 are surfaced in the breakdown for AC#5 disclosure.

import { describe, expect, it } from "vitest";
import {
  estimateConversationBudget,
  type ConversationBudgetInputs,
} from "./conversation-budget.js";

function inputsWith(overrides: Partial<ConversationBudgetInputs> = {}): ConversationBudgetInputs {
  return {
    modelContextWindow: 128_000,
    modelMaxOutputTokens: 4_096,
    userDraftText: "",
    conversationHistory: [],
    ...overrides,
  };
}

describe("estimateConversationBudget", () => {
  it("returns zero bytes and low pressure for an empty draft with no history or extras", () => {
    const estimate = estimateConversationBudget(inputsWith());
    expect(estimate.approximateBytes).toBe(0);
    expect(estimate.approximateTokens).toBe(0);
    expect(estimate.pressure).toBe("low");
    expect(estimate.contextWindowTokens).toBe(128_000);
    expect(estimate.reservedOutputTokens).toBe(4_096);
    expect(estimate.availableInputTokens).toBe(128_000 - 4_096);
    expect(estimate.breakdown).toEqual({
      draftBytes: 0,
      historyBytes: 0,
      documentBytes: 0,
      repoContextBytes: 0,
      knowledgeBytes: 0,
      memoryBytes: 0,
    });
  });

  it("scales approximate bytes proportionally with draft size (ASCII fast path)", () => {
    const small = estimateConversationBudget(inputsWith({ userDraftText: "a".repeat(40) }));
    const big = estimateConversationBudget(inputsWith({ userDraftText: "a".repeat(400) }));
    expect(small.breakdown.draftBytes).toBe(40);
    expect(big.breakdown.draftBytes).toBe(400);
    // bytes/4 ceiling — token approximation is documented as approximate.
    expect(small.approximateTokens).toBe(10);
    expect(big.approximateTokens).toBe(100);
  });

  it("counts every history message's role+content bytes in breakdown.historyBytes", () => {
    const history = [
      { role: "user", content: "hello world" }, // 4 + 11 = 15
      { role: "assistant", content: "hi" }, // 9 + 2 = 11
      { role: "user", content: "foo" }, // 4 + 3 = 7
      { role: "assistant", content: "bar" }, // 9 + 3 = 12
      { role: "tool", content: "x" }, // 4 + 1 = 5
    ];
    const estimate = estimateConversationBudget(inputsWith({ conversationHistory: history }));
    expect(estimate.breakdown.historyBytes).toBe(15 + 11 + 7 + 12 + 5);
    expect(estimate.breakdown.draftBytes).toBe(0);
    expect(estimate.approximateBytes).toBe(estimate.breakdown.historyBytes);
  });

  it("subtracts reservedOutputTokens from the context window to produce availableInputTokens", () => {
    const estimate = estimateConversationBudget(
      inputsWith({ modelContextWindow: 10_000, modelMaxOutputTokens: 2_000 }),
    );
    expect(estimate.contextWindowTokens).toBe(10_000);
    expect(estimate.reservedOutputTokens).toBe(2_000);
    expect(estimate.availableInputTokens).toBe(8_000);
  });

  it("classifies pressure bands at 50% / 75% / 95% boundaries against availableInputTokens", () => {
    // availableInputTokens = 1000. Draft size in bytes → tokens ≈ bytes/4.
    // To hit a target token fraction f: draftBytes = ceil(f * 4000).
    const base = { modelContextWindow: 1100, modelMaxOutputTokens: 100 };
    // 0.40 → low
    const low = estimateConversationBudget(
      inputsWith({ ...base, userDraftText: "a".repeat(1600) }), // 400 tokens / 1000
    );
    expect(low.pressure).toBe("low");
    // 0.60 → moderate (between 0.5 and 0.75)
    const moderate = estimateConversationBudget(
      inputsWith({ ...base, userDraftText: "a".repeat(2400) }), // 600 tokens
    );
    expect(moderate.pressure).toBe("moderate");
    // 0.85 → high (between 0.75 and 0.95)
    const high = estimateConversationBudget(
      inputsWith({ ...base, userDraftText: "a".repeat(3400) }), // 850 tokens
    );
    expect(high.pressure).toBe("high");
    // 1.20 → exceeded (>0.95)
    const exceeded = estimateConversationBudget(
      inputsWith({ ...base, userDraftText: "a".repeat(4800) }), // 1200 tokens
    );
    expect(exceeded.pressure).toBe("exceeded");
  });

  it("includes documentContext, repo, knowledge, and memory bytes in the breakdown and total", () => {
    const estimate = estimateConversationBudget(
      inputsWith({
        userDraftText: "abcd", // 4 bytes
        documentContext: [{ extractedBytes: 100 }, { extractedBytes: 200 }],
        repoContextPackBytes: 1_000,
        knowledgeCapsuleBytes: 500,
        memoryContextBytes: 250,
      }),
    );
    expect(estimate.breakdown.draftBytes).toBe(4);
    expect(estimate.breakdown.documentBytes).toBe(300);
    expect(estimate.breakdown.repoContextBytes).toBe(1_000);
    expect(estimate.breakdown.knowledgeBytes).toBe(500);
    expect(estimate.breakdown.memoryBytes).toBe(250);
    expect(estimate.approximateBytes).toBe(4 + 300 + 1_000 + 500 + 250);
  });

  it("coerces negative, non-finite, and undefined connected-context byte counts to zero (no throws)", () => {
    expect(() =>
      estimateConversationBudget(
        inputsWith({
          modelContextWindow: -1,
          modelMaxOutputTokens: Number.NaN,
          repoContextPackBytes: -500,
          knowledgeCapsuleBytes: Number.POSITIVE_INFINITY,
          memoryContextBytes: undefined,
          documentContext: [{ extractedBytes: -10 }, { extractedBytes: Number.NaN }],
        }),
      ),
    ).not.toThrow();
    const estimate = estimateConversationBudget(
      inputsWith({
        modelContextWindow: -1,
        modelMaxOutputTokens: Number.NaN,
        repoContextPackBytes: -500,
        knowledgeCapsuleBytes: Number.POSITIVE_INFINITY,
        documentContext: [{ extractedBytes: -10 }],
      }),
    );
    expect(estimate.contextWindowTokens).toBe(0);
    expect(estimate.reservedOutputTokens).toBe(0);
    expect(estimate.availableInputTokens).toBe(0);
    expect(estimate.breakdown.repoContextBytes).toBe(0);
    expect(estimate.breakdown.knowledgeBytes).toBe(0);
    expect(estimate.breakdown.documentBytes).toBe(0);
    // Zero available input is treated as exceeded — no eligible model is configured.
    expect(estimate.pressure).toBe("exceeded");
  });

  it("documents that token counts are bytes/4 (approximate, not exact)", () => {
    // Single-byte ASCII characters: 100 bytes → ceil(100/4) = 25 tokens.
    const estimate = estimateConversationBudget(inputsWith({ userDraftText: "x".repeat(100) }));
    expect(estimate.approximateBytes).toBe(100);
    expect(estimate.approximateTokens).toBe(25);
    // A single extra byte must push token count up by one due to ceiling.
    const plusOne = estimateConversationBudget(inputsWith({ userDraftText: "x".repeat(101) }));
    expect(plusOne.approximateTokens).toBe(26);
  });
});
