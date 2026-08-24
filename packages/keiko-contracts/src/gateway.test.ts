// Gateway contract tests (Issue #1210, ADR-0042 D5): the infilling/FIM capability predicates that
// are the single source of truth for "does a model satisfy the editor completion requirement?", the
// alignment enum, the additive-only contract version, and the content-free serialisability of the
// completion-model selection result (AC3).

import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CAPABILITY_CONTRACT_VERSION,
  conversationDefaultRank,
  electConversationDefault,
  describeVoiceProviderAvailability,
  explainConversationIneligibility,
  preferredConversationModelOrder,
  INFILLING_ALIGNMENTS,
  isCompleteRealtimeVoiceCapability,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  isConfiguredVoiceProvider,
  isConversationEligibleModel,
  isCodingWorkbenchModel,
  isVoiceCapability,
  listVoicePersonas,
  modelSupportsInfilling,
  modelSupportsRealtimeVoice,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  selectRealtimeVoiceCapability,
  selectSpeechInputCapability,
  selectSpeechOutputCapability,
  VOICE_PERSONAS,
  VOICE_PROVIDER_LOCALITIES,
  DECLARED_MODEL_MODES,
  boundedUnsupportedReason,
  isChatCompatibleDeclaredMode,
  modelKindForDeclaredMode,
} from "./gateway.js";
import type {
  CompletionModelSelection,
  InfillingAlignment,
  LatencyClass,
  ModelCapability,
  VoiceCapabilityResolution,
  VoicePersona,
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

describe("isCodingWorkbenchModel", () => {
  it.each(["Coding", "Code review", "Local coding workflow", "Software development"])(
    "accepts the explicit coding use case %s",
    (useCase) => {
      expect(isCodingWorkbenchModel(cap({ preferredUseCases: [useCase] }))).toBe(true);
    },
  );

  it.each(["Non-coding", "Coding disabled", "Coding-adjacent", "Chat"])(
    "rejects the unrelated or negative use case %s",
    (useCase) => {
      expect(isCodingWorkbenchModel(cap({ preferredUseCases: [useCase] }))).toBe(false);
    },
  );

  it("requires chat, tool calling, and workflow eligibility together", () => {
    const coding = { preferredUseCases: ["Coding"] } as const;
    expect(isCodingWorkbenchModel(cap({ ...coding, kind: "embedding" }))).toBe(false);
    expect(isCodingWorkbenchModel(cap({ ...coding, toolCalling: false }))).toBe(false);
    expect(isCodingWorkbenchModel(cap({ ...coding, workflowEligible: false }))).toBe(false);
  });
});

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

// ─── Voice capability (Issue #493, ADR-0100 D2/D5/D7) ──────────────────────────

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

describe("canonical voice role election", () => {
  it("selects the cheapest eligible capability for every voice role", () => {
    const capabilities = [
      voiceCap({ id: "all-high", costClass: "high", supportsSpeechInput: true }),
      voiceCap({ id: "stt-low", costClass: "low", supportsSpeechInput: true }),
      voiceCap({ id: "tts-high", costClass: "high", supportsSpeechOutput: true }),
      voiceCap({ id: "tts-low", costClass: "low", supportsSpeechOutput: true }),
      voiceCap({
        id: "realtime-high",
        costClass: "high",
        supportsRealtimeVoice: true,
        realtimeTranscriptionModel: "transcription-high",
      }),
      voiceCap({
        id: "realtime-low",
        costClass: "low",
        supportsRealtimeVoice: true,
        realtimeTranscriptionModel: "transcription-low",
      }),
    ];

    expect(selectSpeechInputCapability(capabilities)?.id).toBe("stt-low");
    expect(selectSpeechOutputCapability(capabilities)?.id).toBe("tts-low");
    expect(selectRealtimeVoiceCapability(capabilities)?.id).toBe("realtime-low");
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace-only", " \t\n "],
  ] as const)(
    "does not elect a Realtime capability with a %s transcription model",
    (_, model): void => {
      const incomplete = voiceCap({
        supportsRealtimeVoice: true,
        realtimeTranscriptionModel: model,
      });

      expect(isCompleteRealtimeVoiceCapability(incomplete)).toBe(false);
      expect(selectRealtimeVoiceCapability([incomplete])).toBeUndefined();
    },
  );
});

describe("voice capability compatibility", () => {
  it("retains the optional realtimeToolCalling field without granting canonical Chat authority", () => {
    const resolution: VoiceCapabilityResolution = {
      available: true,
      profile: "full-realtime",
      capabilities: {
        speechToText: true,
        speechOutput: false,
        realtimeVoice: true,
        realtimeToolCalling: false,
      },
      transport: { websocketControl: true, webrtcMedia: true },
      availableVoicePersonas: [],
    };

    expect(resolution.capabilities.realtimeToolCalling).toBe(false);
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

// ─── Product voice personas (Issue #1557, Epic #1556, ADR-0094 D1/D2/D3) ───────

describe("VOICE_PERSONAS", () => {
  it("enumerates the three product personas in canonical order", () => {
    expect(VOICE_PERSONAS).toEqual(["male", "female", "neutral"]);
  });

  it("stays in lockstep with the VoicePersona type (exhaustive)", () => {
    for (const persona of VOICE_PERSONAS) {
      const label: string = ((value: VoicePersona): string => {
        switch (value) {
          case "male":
            return "male";
          case "female":
            return "female";
          case "neutral":
            return "neutral";
        }
      })(persona);
      expect(label).toBe(persona);
    }
  });
});

describe("listVoicePersonas", () => {
  it("returns the advertised personas in canonical order, deduped", () => {
    expect(
      listVoicePersonas(voiceCap({ supportedVoicePersonas: ["neutral", "male", "male"] })),
    ).toEqual(["male", "neutral"]);
  });

  it("returns [] for a voice capability with no personas", () => {
    expect(listVoicePersonas(voiceCap({ supportsSpeechInput: true }))).toEqual([]);
    expect(listVoicePersonas(voiceCap({ supportedVoicePersonas: [] }))).toEqual([]);
  });

  it("returns [] for a non-voice capability even if the field leaks in (fail-closed)", () => {
    expect(listVoicePersonas(cap({ kind: "chat", supportedVoicePersonas: ["male"] }))).toEqual([]);
  });
});

describe("isConfiguredVoiceProvider", () => {
  it("is true for a voice provider advertising any sub-capability", () => {
    expect(isConfiguredVoiceProvider(voiceCap({ supportsSpeechInput: true }))).toBe(true);
    expect(isConfiguredVoiceProvider(voiceCap({ supportsSpeechOutput: true }))).toBe(true);
    expect(isConfiguredVoiceProvider(voiceCap({ supportsRealtimeVoice: true }))).toBe(true);
  });

  it("is false for a voice capability advertising no sub-capability (fail-closed)", () => {
    expect(isConfiguredVoiceProvider(voiceCap())).toBe(false);
  });

  it("is false for non-voice kinds", () => {
    expect(isConfiguredVoiceProvider(cap({ kind: "chat" }))).toBe(false);
    expect(isConfiguredVoiceProvider(cap({ kind: "embedding" }))).toBe(false);
    expect(isConfiguredVoiceProvider(cap({ kind: "ocr-vision" }))).toBe(false);
  });
});

describe("describeVoiceProviderAvailability", () => {
  it("describes a full-realtime provider with personas and locality, content-free", () => {
    const descriptor = describeVoiceProviderAvailability(
      voiceCap({
        supportsRealtimeVoice: true,
        supportsSpeechOutput: true,
        supportsSpeechInput: true,
        supportedVoicePersonas: ["neutral", "male"],
        voiceProviderLocality: "customer-hosted",
      }),
    );
    expect(descriptor).toEqual({
      available: true,
      speechToText: true,
      speechOutput: true,
      realtimeVoice: true,
      personas: ["male", "neutral"],
      providerLocality: "customer-hosted",
    });
    // Content-free: round-trips through JSON without loss, carries no voice id.
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  });

  it("describes an STT-only provider as available with no personas", () => {
    const descriptor = describeVoiceProviderAvailability(voiceCap({ supportsSpeechInput: true }));
    expect(descriptor).toEqual({
      available: true,
      speechToText: true,
      speechOutput: false,
      realtimeVoice: false,
      personas: [],
      providerLocality: "azure-foundry",
    });
  });

  it("omits providerLocality when none is declared", () => {
    const descriptor = describeVoiceProviderAvailability(
      cap({ kind: "voice", supportsSpeechOutput: true, voiceProviderLocality: undefined }),
    );
    expect(descriptor.available).toBe(true);
    expect(Object.hasOwn(descriptor, "providerLocality")).toBe(false);
  });

  it("describes a non-voice capability as unavailable", () => {
    const descriptor = describeVoiceProviderAvailability(cap({ kind: "chat" }));
    expect(descriptor).toEqual({
      available: false,
      speechToText: false,
      speechOutput: false,
      realtimeVoice: false,
      personas: [],
    });
  });
});

// Customer field incident (0.3.11): a mode-less OCR model FIRST in the configured list captured
// the "first eligible model wins" default for every new chat. The rank is the shared preference
// the UI picker and the server default selection both consult.
describe("conversationDefaultRank", () => {
  it("ranks a declared chat-compatible mode first, even on a special-purpose id", () => {
    expect(conversationDefaultRank(cap({ id: "qwen-chat", chatModeDeclared: true }))).toBe(0);
    // Declared mode is the gateway's affirmative statement; it beats the id heuristic.
    expect(conversationDefaultRank(cap({ id: "dotsocr", chatModeDeclared: true }))).toBe(0);
  });

  it("ranks a mode-less ordinary id in the middle tier", () => {
    expect(conversationDefaultRank(cap({ id: "qwen-chat" }))).toBe(1);
    expect(conversationDefaultRank(cap({ id: "llama-3-70b-instruct" }))).toBe(1);
    // "ocr" embedded mid-token is not a suffix: no down-rank for lookalike names.
    expect(conversationDefaultRank(cap({ id: "procreate-chat" }))).toBe(1);
  });

  it("ranks mode-less special-purpose ids last — the dotsocr field shape", () => {
    expect(conversationDefaultRank(cap({ id: "dotsocr" }))).toBe(2);
    expect(conversationDefaultRank(cap({ id: "dots.ocr" }))).toBe(2);
    expect(conversationDefaultRank(cap({ id: "my-ocr-model" }))).toBe(2);
    expect(conversationDefaultRank(cap({ id: "whisper-large-v3" }))).toBe(2);
    expect(conversationDefaultRank(cap({ id: "bge-reranker-v2" }))).toBe(2);
    // The documented marker set includes plain "speech" engines (review finding: the marker
    // was documented but missing from the token set).
    expect(conversationDefaultRank(cap({ id: "speech-to-text-general" }))).toBe(2);
  });

  it("treats an explicit chatModeDeclared: false like an absent signal", () => {
    expect(conversationDefaultRank(cap({ id: "qwen-chat", chatModeDeclared: false }))).toBe(1);
    expect(conversationDefaultRank(cap({ id: "dotsocr", chatModeDeclared: false }))).toBe(2);
  });
});

describe("electConversationDefault", () => {
  const observed = (m: ModelCapability): boolean | undefined => m.conversationReady;

  it("lets a verified probe break ties only WITHIN the best rank tier", () => {
    const models = [
      cap({ id: "dotsocr", conversationReady: true }),
      { ...cap({ id: "qwen-chat", chatModeDeclared: true }), conversationReady: undefined },
    ];
    // The warm special-purpose model is VERIFIED, the declared chat model is unprobed — the
    // tier must win, or a single warm probe re-opens the default-capture the rank prevents.
    expect(electConversationDefault(models, observed)?.id).toBe("qwen-chat");
  });

  it("prefers the verified model within the same tier", () => {
    const models = [
      { ...cap({ id: "mistral-small" }), conversationReady: undefined },
      cap({ id: "llama-3-70b-instruct", conversationReady: true }),
    ];
    expect(electConversationDefault(models, observed)?.id).toBe("llama-3-70b-instruct");
  });

  it("falls through an exhausted tier: observed-unready declared models yield to a verified fallback", () => {
    // The walk journey: the declared chat model failed its probe (observed false) while the
    // special-purpose model verified warm — chat must still work, so the verified fallback
    // wins over an admission already known to fail.
    const models = [
      cap({ id: "dotsocr", conversationReady: true }),
      cap({ id: "qwen-chat", chatModeDeclared: true, conversationReady: false }),
    ];
    expect(electConversationDefault(models, observed)?.id).toBe("dotsocr");
  });

  it("returns the best-ranked head when everything is observed-unready, undefined when empty", () => {
    const models = [
      cap({ id: "dotsocr", conversationReady: false }),
      cap({ id: "qwen-chat", chatModeDeclared: true, conversationReady: false }),
    ];
    expect(electConversationDefault(models, observed)?.id).toBe("qwen-chat");
    expect(electConversationDefault([], observed)).toBeUndefined();
  });
});

describe("preferredConversationModelOrder", () => {
  it("orders declared-mode models first and special-purpose ids last, keeping config order in ties", () => {
    const models = [
      cap({ id: "dotsocr" }),
      cap({ id: "qwen-chat", chatModeDeclared: true }),
      cap({ id: "mistral-small" }),
      cap({ id: "llama-3-70b-instruct" }),
    ];
    expect(preferredConversationModelOrder(models).map((model) => model.id)).toEqual([
      "qwen-chat",
      "mistral-small",
      "llama-3-70b-instruct",
      "dotsocr",
    ]);
  });

  it("is a preference, never an eligibility gate: a lone special-purpose model stays first", () => {
    const models = [cap({ id: "dotsocr" })];
    expect(preferredConversationModelOrder(models).map((model) => model.id)).toEqual(["dotsocr"]);
  });

  it("does not mutate its input", () => {
    const models = [cap({ id: "dotsocr" }), cap({ id: "qwen-chat", chatModeDeclared: true })];
    const snapshot = models.map((model) => model.id);
    void preferredConversationModelOrder(models);
    expect(models.map((model) => model.id)).toEqual(snapshot);
  });
});

describe("modelKindForDeclaredMode", () => {
  // A gateway's declared mode is the ONLY affirmative statement it makes about what a model IS.
  // Keiko is model-agnostic: customers host arbitrary models, so a name may express a preference
  // but never a role. Field incident: a "rerank" model named bge-reranker-v2-m3 was bound to every
  // Knowledge Pod as its embedding model because the id contained "bge".
  it("maps every chat-compatible mode onto chat", () => {
    for (const mode of ["chat", "completion", "responses"]) {
      expect(modelKindForDeclaredMode(mode)).toBe("chat");
      expect(isChatCompatibleDeclaredMode(mode)).toBe(true);
    }
  });

  it("maps the embedding mode onto embedding, and nothing else does", () => {
    expect(modelKindForDeclaredMode("embedding")).toBe("embedding");
    expect(isChatCompatibleDeclaredMode("embedding")).toBe(false);
  });

  it("refuses to give a role to modes discovery cannot configure", () => {
    for (const mode of [
      "rerank",
      "image_generation",
      "audio_transcription",
      "audio_speech",
      "moderation",
    ]) {
      expect(modelKindForDeclaredMode(mode)).toBe("unsupported");
    }
  });

  it("treats an UNRECOGNISED declaration as unsupported, never as chat", () => {
    // Guessing from the id here is exactly what the table exists to prevent: the gateway said the
    // model is something specific, and Keiko does not know that something.
    expect(modelKindForDeclaredMode("realtime")).toBe("unsupported");
    expect(modelKindForDeclaredMode("vendor-private-mode")).toBe("unsupported");
    expect(modelKindForDeclaredMode("")).toBe("unsupported");
  });

  it("normalises casing and surrounding whitespace", () => {
    expect(modelKindForDeclaredMode("  EMBEDDING ")).toBe("embedding");
    expect(modelKindForDeclaredMode("Chat")).toBe("chat");
  });

  it("does not resolve inherited object properties as modes", () => {
    expect(modelKindForDeclaredMode("constructor")).toBe("unsupported");
    expect(modelKindForDeclaredMode("toString")).toBe("unsupported");
  });

  it("exports exactly the vocabulary the role table defines", () => {
    // Exact content, not membership: a membership loop passes for ANY list, so it could not catch
    // a mode present in the union and the role table but missing from the exported array — which
    // would silently degrade a KNOWN mode to "unrecognised-mode" in boundedUnsupportedReason.
    expect([...DECLARED_MODEL_MODES]).toEqual([
      "chat",
      "completion",
      "responses",
      "embedding",
      "rerank",
      "image_generation",
      "audio_transcription",
      "audio_speech",
      "moderation",
    ]);
  });

  it("bounds every reason to the closed vocabulary", () => {
    for (const mode of DECLARED_MODEL_MODES) {
      expect(boundedUnsupportedReason(mode)).toBe(mode);
    }
    expect(boundedUnsupportedReason("vendor-private-mode")).toBe("unrecognised-mode");
    expect(boundedUnsupportedReason("  REALTIME ")).toBe("unrecognised-mode");
  });
});
