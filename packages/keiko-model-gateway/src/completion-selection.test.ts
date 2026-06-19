// Completion-model selection (Issue #1210, ADR-0042 D5) — infilling/FIM capability predicates, the
// pure selection decision tree (as-you-type → manual → deterministic), the cost ceiling, the
// base-FIM injection guardrail, and the config-bound entry point. Tests are mutation-aware: each
// conjunct of the decision tree is made individually decisive and every tie-break is pinned.

import { describe, expect, it } from "vitest";
import type {
  CostClass,
  InfillingAlignment,
  LatencyClass,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import {
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  modelSupportsInfilling,
  selectCompletionModelFromCapabilities,
} from "./capabilities.js";
import { selectCompletionModel } from "./model-selection.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";

// A chat capability with sensible defaults; overrides drive the behaviour under test.
function chatCap(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Test"],
    knownLimitations: [],
    ...overrides,
  };
}

function infillCap(
  id: string,
  alignment: InfillingAlignment | undefined,
  latencyClass: LatencyClass,
  costClass: CostClass,
): ModelCapability {
  return chatCap(id, {
    supportsInfilling: true,
    ...(alignment !== undefined ? { infillingAlignment: alignment } : {}),
    latencyClass,
    costClass,
  });
}

describe("modelSupportsInfilling", () => {
  it("is true for a chat model that advertises suffix-aware completion", () => {
    expect(modelSupportsInfilling(chatCap("a", { supportsInfilling: true }))).toBe(true);
  });

  it("is false when the flag is absent (conservative default)", () => {
    expect(modelSupportsInfilling(chatCap("a"))).toBe(false);
  });

  it("is false when the flag is explicitly false", () => {
    expect(modelSupportsInfilling(chatCap("a", { supportsInfilling: false }))).toBe(false);
  });

  // Kind guard is decisive: infilling is a chat-only capability even if a non-chat record claims it.
  it("is false for a non-chat kind even when supportsInfilling is true", () => {
    const embedding: ModelCapability = {
      ...chatCap("e", { supportsInfilling: true }),
      kind: "embedding",
    };
    expect(modelSupportsInfilling(embedding)).toBe(false);
  });
});

describe("isAlignedInfillingModel", () => {
  it("accepts an instruct-aligned infilling model", () => {
    expect(isAlignedInfillingModel(infillCap("a", "instruct", "fast", "low"))).toBe(true);
  });

  it("accepts an edit-tuned infilling model", () => {
    expect(isAlignedInfillingModel(infillCap("a", "edit-tuned", "fast", "low"))).toBe(true);
  });

  // The prompt-injection guardrail: raw base-FIM is never aligned.
  it("rejects a raw base-FIM model", () => {
    expect(isAlignedInfillingModel(infillCap("a", "base", "fast", "low"))).toBe(false);
  });

  // Fail-closed: an undeclared alignment is treated as unsafe.
  it("rejects an infilling model with an undeclared alignment", () => {
    expect(isAlignedInfillingModel(infillCap("a", undefined, "fast", "low"))).toBe(false);
  });

  it("rejects a model that does not advertise infilling at all", () => {
    expect(isAlignedInfillingModel(chatCap("a", { infillingAlignment: "instruct" }))).toBe(false);
  });
});

describe("isAsYouTypeCompletionModel", () => {
  it("accepts an aligned, fast infilling model", () => {
    expect(isAsYouTypeCompletionModel(infillCap("a", "instruct", "fast", "low"))).toBe(true);
  });

  // Latency conjunct is decisive: a standard/slow aligned model is never as-you-type.
  it("rejects an aligned model that is not fast", () => {
    expect(isAsYouTypeCompletionModel(infillCap("a", "instruct", "standard", "low"))).toBe(false);
    expect(isAsYouTypeCompletionModel(infillCap("a", "instruct", "slow", "low"))).toBe(false);
  });

  it("rejects a fast base-FIM model", () => {
    expect(isAsYouTypeCompletionModel(infillCap("a", "base", "fast", "low"))).toBe(false);
  });
});

describe("selectCompletionModelFromCapabilities — as-you-type", () => {
  it("elects a fast, aligned, in-budget model for as-you-type ghost text", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("fast-instruct", "instruct", "fast", "low"),
    ]);
    expect(result).toEqual({
      mode: "as-you-type",
      modelId: "fast-instruct",
      latencyClass: "fast",
    });
  });

  it("prefers a fast aligned model over a slower aligned model", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("slow-instruct", "instruct", "standard", "low"),
      infillCap("fast-instruct", "instruct", "fast", "high"),
    ]);
    expect(result.mode).toBe("as-you-type");
    expect(result.modelId).toBe("fast-instruct");
  });

  it("picks the cheapest among fast aligned candidates", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("fast-high", "instruct", "fast", "high"),
      infillCap("fast-low", "instruct", "fast", "low"),
      infillCap("fast-medium", "edit-tuned", "fast", "medium"),
    ]);
    expect(result.modelId).toBe("fast-low");
  });

  it("breaks an equal-cost tie in favour of the first-declared model", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("tie-first", "instruct", "fast", "low"),
      infillCap("tie-second", "edit-tuned", "fast", "low"),
    ]);
    expect(result.modelId).toBe("tie-first");
  });
});

describe("selectCompletionModelFromCapabilities — manual", () => {
  it("elects a slower aligned model for manual-invoke when no fast aligned model exists", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("standard-instruct", "instruct", "standard", "low"),
    ]);
    expect(result).toEqual({
      mode: "manual",
      modelId: "standard-instruct",
      latencyClass: "standard",
    });
  });

  it("picks the cheapest aligned candidate for manual mode", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("slow-high", "instruct", "slow", "high"),
      infillCap("standard-low", "edit-tuned", "standard", "low"),
    ]);
    expect(result.mode).toBe("manual");
    expect(result.modelId).toBe("standard-low");
  });
});

describe("selectCompletionModelFromCapabilities — deterministic degradation", () => {
  it("degrades when no model advertises infilling (no-infilling-model)", () => {
    const result = selectCompletionModelFromCapabilities([chatCap("plain")]);
    expect(result).toEqual({ mode: "deterministic", degradeReason: "no-infilling-model" });
  });

  it("never elects a raw base-FIM model even when it is fast (only-base-infilling-model)", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("fast-base", "base", "fast", "low"),
    ]);
    expect(result).toEqual({ mode: "deterministic", degradeReason: "only-base-infilling-model" });
  });

  it("treats an undeclared alignment as base for degradation (only-base-infilling-model)", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("fast-unknown", undefined, "fast", "low"),
    ]);
    expect(result.degradeReason).toBe("only-base-infilling-model");
  });
});

describe("selectCompletionModelFromCapabilities — cost ceiling (#1206)", () => {
  it("excludes a candidate above the ceiling and degrades when it was the only option", () => {
    const result = selectCompletionModelFromCapabilities(
      [infillCap("fast-high", "instruct", "fast", "high")],
      { maxCostClass: "low" },
    );
    expect(result).toEqual({ mode: "deterministic", degradeReason: "over-cost-ceiling" });
  });

  it("elects the same model when the ceiling admits it", () => {
    const result = selectCompletionModelFromCapabilities(
      [infillCap("fast-high", "instruct", "fast", "high")],
      { maxCostClass: "high" },
    );
    expect(result.mode).toBe("as-you-type");
    expect(result.modelId).toBe("fast-high");
  });

  it("selects the cheaper in-budget aligned model when an over-ceiling one also exists", () => {
    const result = selectCompletionModelFromCapabilities(
      [
        infillCap("fast-high", "instruct", "fast", "high"),
        infillCap("fast-low", "edit-tuned", "fast", "low"),
      ],
      { maxCostClass: "medium" },
    );
    expect(result.modelId).toBe("fast-low");
  });

  // Reason precedence: an aligned-but-over-ceiling model reports the budget cause, not only-base,
  // even when a base model is also present within budget.
  it("reports over-cost-ceiling ahead of only-base when both conditions hold", () => {
    const result = selectCompletionModelFromCapabilities(
      [
        infillCap("aligned-high", "instruct", "fast", "high"),
        infillCap("base-low", "base", "fast", "low"),
      ],
      { maxCostClass: "low" },
    );
    expect(result).toEqual({ mode: "deterministic", degradeReason: "over-cost-ceiling" });
  });

  it("treats an omitted ceiling as no budget limit", () => {
    const result = selectCompletionModelFromCapabilities([
      infillCap("fast-high", "instruct", "fast", "high"),
    ]);
    expect(result.mode).toBe("as-you-type");
  });
});

// Config-bound entry point: only configured providers are eligible.
function provider(modelId: string): ModelProviderConfig {
  return {
    modelId,
    baseUrl: "https://provider.example/v1",
    apiKey: "test-config-secret-value-1234567890",
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
  };
}

function config(
  modelIds: readonly string[],
  capabilities: readonly ModelCapability[],
): GatewayConfig {
  return {
    providers: modelIds.map(provider),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities,
  };
}

describe("selectCompletionModel — config-bound", () => {
  it("elects a configured fast aligned model for as-you-type", () => {
    const result = selectCompletionModel(
      config(["fast-instruct"], [infillCap("fast-instruct", "instruct", "fast", "low")]),
    );
    expect(result.mode).toBe("as-you-type");
    expect(result.modelId).toBe("fast-instruct");
  });

  it("ignores a capability that names no configured provider (degrades to deterministic)", () => {
    const result = selectCompletionModel(
      // The capability exists but no provider offers it, so it can never be elected.
      config(["other-model"], [infillCap("unconfigured-instruct", "instruct", "fast", "low")]),
    );
    expect(result.mode).toBe("deterministic");
    expect(result.degradeReason).toBe("no-infilling-model");
  });

  it("forwards the cost ceiling to the selection", () => {
    const result = selectCompletionModel(
      config(["fast-high"], [infillCap("fast-high", "instruct", "fast", "high")]),
      { maxCostClass: "low" },
    );
    expect(result).toEqual({ mode: "deterministic", degradeReason: "over-cost-ceiling" });
  });
});
