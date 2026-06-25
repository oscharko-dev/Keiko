// Gateway contract tests (Issue #1210, ADR-0042 D5): the infilling/FIM capability predicates that
// are the single source of truth for "does a model satisfy the editor completion requirement?", the
// alignment enum, the additive-only contract version, and the content-free serialisability of the
// completion-model selection result (AC3).

import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CAPABILITY_CONTRACT_VERSION,
  explainConversationIneligibility,
  INFILLING_ALIGNMENTS,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  isConversationEligibleModel,
  isVoiceCapability,
  modelSupportsInfilling,
  modelSupportsRealtimeVoice,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  VOICE_PROVIDER_LOCALITIES,
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
  it("is 3 after the structural #493 voice ModelKind addition", () => {
    // #143 set it to 2 (image/document/workflow flags). #493 added the "voice" ModelKind — a
    // STRUCTURAL change (a new literal discriminant member) that bumps the version to 3. Additive
    // OPTIONAL flags (Epic #761 determinism, #1210 infilling, and the #493 voice sub-capability
    // flags) never bump it; only the new kind did.
    expect(CONVERSATION_CAPABILITY_CONTRACT_VERSION).toBe(3);
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

// ─── Voice capability (Issue #493, ADR-0058 D2/D5/D7) ──────────────────────────

const voiceCap = (overrides: Partial<ModelCapability> = {}): ModelCapability =>
  cap({
    id: "voice-model",
    kind: "voice",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    workflowEligible: false,
    voiceProviderLocality: "azure-foundry",
    ...overrides,
  });

describe("VOICE_PROVIDER_LOCALITIES", () => {
  it("enumerates the three provider localities", () => {
    expect(VOICE_PROVIDER_LOCALITIES).toEqual(["azure-foundry", "customer-hosted", "local-only"]);
  });
});

describe("voice capability predicates", () => {
  it("isVoiceCapability is true only for the voice kind", () => {
    expect(isVoiceCapability(voiceCap({ supportsSpeechInput: true }))).toBe(true);
    expect(isVoiceCapability(cap({ kind: "chat" }))).toBe(false);
    expect(isVoiceCapability(cap({ kind: "embedding" }))).toBe(false);
  });

  it("modelSupportsSpeechInput requires kind voice AND the flag (fail-closed)", () => {
    expect(modelSupportsSpeechInput(voiceCap({ supportsSpeechInput: true }))).toBe(true);
    expect(modelSupportsSpeechInput(voiceCap({ supportsSpeechInput: false }))).toBe(false);
    expect(modelSupportsSpeechInput(voiceCap())).toBe(false);
    // A chat model can never advertise voice input even if the flag leaks in.
    expect(modelSupportsSpeechInput(cap({ kind: "chat", supportsSpeechInput: true }))).toBe(false);
  });

  it("modelSupportsSpeechOutput requires kind voice AND the flag", () => {
    expect(modelSupportsSpeechOutput(voiceCap({ supportsSpeechOutput: true }))).toBe(true);
    expect(modelSupportsSpeechOutput(voiceCap({ supportsSpeechOutput: false }))).toBe(false);
    expect(modelSupportsSpeechOutput(cap({ kind: "chat", supportsSpeechOutput: true }))).toBe(
      false,
    );
  });

  it("modelSupportsRealtimeVoice requires kind voice AND the flag", () => {
    expect(modelSupportsRealtimeVoice(voiceCap({ supportsRealtimeVoice: true }))).toBe(true);
    expect(modelSupportsRealtimeVoice(voiceCap({ supportsRealtimeVoice: false }))).toBe(false);
    expect(modelSupportsRealtimeVoice(cap({ kind: "chat", supportsRealtimeVoice: true }))).toBe(
      false,
    );
  });
});

describe("explainConversationIneligibility for voice", () => {
  it("classifies a voice model as voice-only (never conversation-eligible)", () => {
    const model = voiceCap({ supportsSpeechInput: true });
    expect(isConversationEligibleModel(model)).toBe(false);
    expect(explainConversationIneligibility(model)).toBe("voice-only");
  });

  it("still returns undefined for a chat model", () => {
    expect(explainConversationIneligibility(cap({ kind: "chat" }))).toBeUndefined();
  });
});
