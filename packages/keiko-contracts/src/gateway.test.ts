// Gateway contract tests (Issue #1210, ADR-0042 D5): the infilling/FIM capability predicates that
// are the single source of truth for "does a model satisfy the editor completion requirement?", the
// alignment enum, the additive-only contract version, and the content-free serialisability of the
// completion-model selection result (AC3).

import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CAPABILITY_CONTRACT_VERSION,
  INFILLING_ALIGNMENTS,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  modelSupportsInfilling,
} from "./gateway.js";
import type {
  CompletionModelSelection,
  InfillingAlignment,
  LatencyClass,
  ModelCapability,
} from "./gateway.js";

function cap(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "test-model",
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
    latencyClass: "fast",
    throughputHint: "test",
    preferredUseCases: ["Test"],
    knownLimitations: [],
    ...overrides,
  };
}

describe("INFILLING_ALIGNMENTS", () => {
  it("enumerates the three alignment postures", () => {
    expect(INFILLING_ALIGNMENTS).toEqual(["base", "instruct", "edit-tuned"]);
  });

  it("stays in lockstep with the InfillingAlignment type", () => {
    // Exhaustive switch: a future member added to the type without updating the const is a compile
    // error here, not a silent drift.
    for (const alignment of INFILLING_ALIGNMENTS) {
      const label: string = ((value: InfillingAlignment): string => {
        switch (value) {
          case "base":
            return "base";
          case "instruct":
            return "instruct";
          case "edit-tuned":
            return "edit-tuned";
        }
      })(alignment);
      expect(label).toBe(alignment);
    }
  });
});

describe("modelSupportsInfilling", () => {
  it("requires both chat kind and the suffix-aware flag", () => {
    expect(modelSupportsInfilling(cap({ supportsInfilling: true }))).toBe(true);
    expect(modelSupportsInfilling(cap({ supportsInfilling: false }))).toBe(false);
    expect(modelSupportsInfilling(cap({}))).toBe(false);
    expect(modelSupportsInfilling(cap({ kind: "embedding", supportsInfilling: true }))).toBe(false);
  });
});

describe("isAlignedInfillingModel", () => {
  it("accepts only instruct or edit-tuned infilling models", () => {
    expect(
      isAlignedInfillingModel(cap({ supportsInfilling: true, infillingAlignment: "instruct" })),
    ).toBe(true);
    expect(
      isAlignedInfillingModel(cap({ supportsInfilling: true, infillingAlignment: "edit-tuned" })),
    ).toBe(true);
  });

  it("rejects base and undeclared alignments (injection guardrail, fail-closed)", () => {
    expect(
      isAlignedInfillingModel(cap({ supportsInfilling: true, infillingAlignment: "base" })),
    ).toBe(false);
    expect(isAlignedInfillingModel(cap({ supportsInfilling: true }))).toBe(false);
  });

  it("rejects an aligned label without the suffix-aware capability", () => {
    expect(isAlignedInfillingModel(cap({ infillingAlignment: "instruct" }))).toBe(false);
  });
});

describe("isAsYouTypeCompletionModel", () => {
  it("requires an aligned infilling model AND a fast latency class", () => {
    const aligned = { supportsInfilling: true, infillingAlignment: "instruct" } as const;
    expect(isAsYouTypeCompletionModel(cap({ ...aligned, latencyClass: "fast" }))).toBe(true);
    for (const latencyClass of ["standard", "slow"] satisfies LatencyClass[]) {
      expect(isAsYouTypeCompletionModel(cap({ ...aligned, latencyClass }))).toBe(false);
    }
  });
});

describe("CONVERSATION_CAPABILITY_CONTRACT_VERSION", () => {
  it("is not bumped by the additive-optional #1210 fields", () => {
    // supportsInfilling / infillingAlignment are optional additive fields; like the Epic #761
    // determinism flags they must NOT bump the structural contract version.
    expect(CONVERSATION_CAPABILITY_CONTRACT_VERSION).toBe(2);
  });
});

describe("CompletionModelSelection serialisability (AC3)", () => {
  it("round-trips a model-backed result through JSON without loss (content-free)", () => {
    const selection: CompletionModelSelection = {
      mode: "as-you-type",
      modelId: "fast-instruct",
      latencyClass: "fast",
    };
    expect(JSON.parse(JSON.stringify(selection))).toEqual(selection);
  });

  it("round-trips a deterministic degradation result through JSON", () => {
    const selection: CompletionModelSelection = {
      mode: "deterministic",
      degradeReason: "only-base-infilling-model",
    };
    expect(JSON.parse(JSON.stringify(selection))).toEqual(selection);
  });
});
