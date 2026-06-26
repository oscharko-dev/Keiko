// Voice capability resolution tests (Issue #493, Epic #491, ADR-0058). Exercises the five
// deployment profiles named by the issue deliverables — no-voice, STT-only, full voice, denied
// (policy-disabled), and unreachable — plus the acceptance criteria: AC1 (false when no voice
// model), AC2 (dictation when only STT), AC3 (full conversation only with realtime OR both speech
// in+out), and AC4/AC5 (the resolution is content-free: no base URL, credential, or model id).

import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import {
  resolveVoiceCapabilityFromCapabilities,
  type VoiceResolutionOptions,
} from "./capabilities.js";
import {
  resolveVoiceCapability,
  selectRealtimeVoiceModel,
  selectSpeechOutputModel,
  selectSpeechToTextModel,
  selectVoicePersonaVoice,
} from "./model-selection.js";
import type { GatewayConfig, VoicePersonaVoice } from "./types.js";

// A voice capability with the named sub-capabilities. Defaults to a development Azure Foundry STT
// deployment shaped like the existing `keiko-stt` (AC6).
function voiceCap(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "keiko-stt",
    kind: "voice",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    voiceProviderLocality: "azure-foundry",
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured voice endpoint",
    preferredUseCases: ["Dictation"],
    knownLimitations: [],
    ...overrides,
  };
}

function chatCap(): ModelCapability {
  return {
    id: "example-chat",
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
    throughputHint: "chat",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
  };
}

function resolve(
  capabilities: readonly ModelCapability[],
  options?: VoiceResolutionOptions,
): ReturnType<typeof resolveVoiceCapabilityFromCapabilities> {
  return resolveVoiceCapabilityFromCapabilities(capabilities, options);
}

describe("resolveVoiceCapabilityFromCapabilities — no-voice profile (AC1)", () => {
  it("reports unavailable with the no-voice-provider reason when no capabilities are configured", () => {
    const result = resolve([]);
    expect(result.available).toBe(false);
    expect(result.profile).toBe("none");
    expect(result.reason).toBe("no-voice-provider");
    expect(result.capabilities).toEqual({
      speechToText: false,
      speechOutput: false,
      realtimeVoice: false,
    });
    expect(result.transport).toEqual({ websocketControl: false, webrtcMedia: false });
  });

  it("ignores non-voice capabilities (a chat-only deployment has no voice)", () => {
    const result = resolve([chatCap()]);
    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-voice-provider");
  });
});

describe("resolveVoiceCapabilityFromCapabilities — STT-only profile (AC2)", () => {
  it("reports dictation (speech-to-text) when only STT is configured", () => {
    const result = resolve([voiceCap({ supportsSpeechInput: true })]);
    expect(result.available).toBe(true);
    expect(result.profile).toBe("speech-to-text");
    expect(result.capabilities).toEqual({
      speechToText: true,
      speechOutput: false,
      realtimeVoice: false,
    });
    expect(result.providerLocality).toBe("azure-foundry");
  });

  it("does NOT advertise full conversation for STT-only (AC3)", () => {
    const result = resolve([voiceCap({ supportsSpeechInput: true })]);
    expect(result.profile).not.toBe("full-realtime");
    expect(result.transport.webrtcMedia).toBe(false);
    // The control plane role is active for any non-none profile (ADR-0058 D3).
    expect(result.transport.websocketControl).toBe(true);
  });
});

describe("resolveVoiceCapabilityFromCapabilities — speech-output-only profile", () => {
  it("reports speech-output when only TTS is configured", () => {
    const result = resolve([voiceCap({ id: "tts", supportsSpeechOutput: true })]);
    expect(result.available).toBe(true);
    expect(result.profile).toBe("speech-output");
    expect(result.transport.webrtcMedia).toBe(false);
  });
});

describe("resolveVoiceCapabilityFromCapabilities — full voice profile (AC3)", () => {
  it("reports full-realtime when the provider advertises realtime speech", () => {
    const result = resolve([voiceCap({ supportsRealtimeVoice: true })]);
    expect(result.available).toBe(true);
    expect(result.profile).toBe("full-realtime");
    expect(result.transport).toEqual({ websocketControl: true, webrtcMedia: true });
  });

  it("reports full-realtime when BOTH speech input and speech output are available", () => {
    const result = resolve([
      voiceCap({ id: "stt", supportsSpeechInput: true }),
      voiceCap({ id: "tts", supportsSpeechOutput: true }),
    ]);
    expect(result.profile).toBe("full-realtime");
    expect(result.capabilities).toEqual({
      speechToText: true,
      speechOutput: true,
      realtimeVoice: false,
    });
  });

  it("does NOT report full-realtime for speech input alone (the AC3 guard)", () => {
    expect(resolve([voiceCap({ supportsSpeechInput: true })]).profile).toBe("speech-to-text");
  });
});

describe("resolveVoiceCapabilityFromCapabilities — denied profile (policy kill-switch)", () => {
  it("reports unavailable with policy-disabled when voice is disabled, even with a provider", () => {
    const result = resolve([voiceCap({ supportsRealtimeVoice: true })], { policyDisabled: true });
    expect(result.available).toBe(false);
    expect(result.profile).toBe("none");
    expect(result.reason).toBe("policy-disabled");
  });
});

describe("resolveVoiceCapabilityFromCapabilities — unreachable profile", () => {
  it("reports provider-unreachable when the only voice provider is unreachable", () => {
    const result = resolve([voiceCap({ id: "keiko-stt", supportsSpeechInput: true })], {
      unreachableProviderIds: new Set(["keiko-stt"]),
    });
    expect(result.available).toBe(false);
    expect(result.profile).toBe("none");
    expect(result.reason).toBe("provider-unreachable");
  });

  it("falls back to the reachable provider when one of several is unreachable", () => {
    const result = resolve(
      [
        voiceCap({ id: "keiko-stt", supportsSpeechInput: true }),
        voiceCap({ id: "down-realtime", supportsRealtimeVoice: true }),
      ],
      { unreachableProviderIds: new Set(["down-realtime"]) },
    );
    expect(result.available).toBe(true);
    expect(result.profile).toBe("speech-to-text");
  });
});

describe("resolveVoiceCapabilityFromCapabilities — provider locality (ADR-0058 D7)", () => {
  it("reports the locality when every elected provider agrees", () => {
    const result = resolve([
      voiceCap({ id: "a", supportsSpeechInput: true, voiceProviderLocality: "customer-hosted" }),
      voiceCap({ id: "b", supportsSpeechOutput: true, voiceProviderLocality: "customer-hosted" }),
    ]);
    expect(result.providerLocality).toBe("customer-hosted");
  });

  it("omits the locality when elected providers disagree (mixed deployment)", () => {
    const result = resolve([
      voiceCap({ id: "a", supportsSpeechInput: true, voiceProviderLocality: "azure-foundry" }),
      voiceCap({ id: "b", supportsSpeechOutput: true, voiceProviderLocality: "customer-hosted" }),
    ]);
    expect(result.providerLocality).toBeUndefined();
  });
});

describe("resolveVoiceCapabilityFromCapabilities — content-free (AC4/AC5)", () => {
  it("returns only enum literals and booleans — no base URL, credential, or model id", () => {
    const result = resolve([voiceCap({ supportsRealtimeVoice: true })]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("keiko-stt");
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("apiKey");
    // Round-trips losslessly across the host/server boundary.
    expect(JSON.parse(serialized)).toEqual(result);
  });
});

describe("resolveVoiceCapability — GatewayConfig binder", () => {
  // Minimal GatewayConfig: only the fields the resolver reads (providers + capabilities).
  function configWith(capabilities: readonly ModelCapability[]): GatewayConfig {
    return {
      providers: capabilities.map((capability) => ({
        modelId: capability.id,
        baseUrl: "https://example.test",
        apiKey: "test-key",
        apiKeyHeaderName: "authorization",
        timeoutMs: 30_000,
        maxRetries: 3,
        retryBaseDelayMs: 500,
      })),
      circuitBreaker: {
        failureThreshold: 5,
        cooldownMs: 30_000,
        halfOpenProbes: 2,
      },
      capabilities,
    };
  }

  it("binds to a configured keiko-stt provider and reports dictation (AC6)", () => {
    const config = configWith([voiceCap({ supportsSpeechInput: true })]);
    const result = resolveVoiceCapability(config);
    expect(result.available).toBe(true);
    expect(result.profile).toBe("speech-to-text");
    expect(result.providerLocality).toBe("azure-foundry");
  });

  it("never elects a voice capability that names no configured provider (fail-closed)", () => {
    // Capability present but NO matching provider → not listed → no voice.
    const config: GatewayConfig = {
      ...configWith([]),
      capabilities: [voiceCap({ supportsRealtimeVoice: true })],
    };
    const result = resolveVoiceCapability(config);
    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-voice-provider");
  });

  it("honors the policy kill-switch through the binder", () => {
    const config = configWith([voiceCap({ supportsSpeechInput: true })]);
    expect(resolveVoiceCapability(config, { policyDisabled: true }).reason).toBe("policy-disabled");
  });
});

describe("selectSpeechToTextModel (Issue #494)", () => {
  function configWith(capabilities: readonly ModelCapability[]): GatewayConfig {
    return {
      providers: capabilities.map((capability) => ({
        modelId: capability.id,
        baseUrl: "https://example.test",
        apiKey: "test-key",
        timeoutMs: 30_000,
        maxRetries: 3,
        retryBaseDelayMs: 500,
      })),
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      capabilities,
    };
  }

  it("returns undefined for a no-voice (chat-only) deployment (AC1)", () => {
    expect(selectSpeechToTextModel(configWith([chatCap()]))).toBeUndefined();
  });

  it("returns undefined when no provider is configured", () => {
    expect(selectSpeechToTextModel(configWith([]))).toBeUndefined();
  });

  it("selects the configured keiko-stt speech-input provider (AC6)", () => {
    expect(selectSpeechToTextModel(configWith([voiceCap({ supportsSpeechInput: true })]))).toBe(
      "keiko-stt",
    );
  });

  it("ignores a voice provider that advertises only speech output (not dictation)", () => {
    const config = configWith([
      voiceCap({ id: "tts-only", supportsSpeechOutput: true, supportsSpeechInput: undefined }),
    ]);
    expect(selectSpeechToTextModel(config)).toBeUndefined();
  });

  it("prefers the cheapest configured speech-to-text provider", () => {
    const config = configWith([
      voiceCap({ id: "stt-expensive", supportsSpeechInput: true, costClass: "high" }),
      voiceCap({ id: "stt-cheap", supportsSpeechInput: true, costClass: "low" }),
    ]);
    expect(selectSpeechToTextModel(config)).toBe("stt-cheap");
  });

  it("ranks all three cost classes (low < medium < high)", () => {
    const config = configWith([
      voiceCap({ id: "stt-high", supportsSpeechInput: true, costClass: "high" }),
      voiceCap({ id: "stt-medium", supportsSpeechInput: true, costClass: "medium" }),
      voiceCap({ id: "stt-low", supportsSpeechInput: true, costClass: "low" }),
    ]);
    expect(selectSpeechToTextModel(config)).toBe("stt-low");
  });

  it("never elects a speech-input capability that names no configured provider (fail-closed)", () => {
    const config: GatewayConfig = {
      ...configWith([]),
      capabilities: [voiceCap({ supportsSpeechInput: true })],
    };
    expect(selectSpeechToTextModel(config)).toBeUndefined();
  });
});

describe("selectRealtimeVoiceModel (Issue #497)", () => {
  function configWith(capabilities: readonly ModelCapability[]): GatewayConfig {
    return {
      providers: capabilities.map((capability) => ({
        modelId: capability.id,
        baseUrl: "https://example.test",
        apiKey: "test-key",
        timeoutMs: 30_000,
        maxRetries: 3,
        retryBaseDelayMs: 500,
      })),
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      capabilities,
    };
  }

  it("returns undefined for a no-voice (chat-only) deployment (AC1/AC3)", () => {
    expect(selectRealtimeVoiceModel(configWith([chatCap()]))).toBeUndefined();
  });

  it("returns undefined when no provider is configured", () => {
    expect(selectRealtimeVoiceModel(configWith([]))).toBeUndefined();
  });

  it("returns undefined for an STT-only deployment (full realtime is not advertised) (AC3)", () => {
    const config = configWith([voiceCap({ supportsSpeechInput: true })]);
    expect(selectRealtimeVoiceModel(config)).toBeUndefined();
  });

  it("selects the configured realtime-voice provider", () => {
    expect(
      selectRealtimeVoiceModel(
        configWith([voiceCap({ id: "keiko-realtime", supportsRealtimeVoice: true })]),
      ),
    ).toBe("keiko-realtime");
  });

  it("prefers the cheapest configured realtime-voice provider", () => {
    const config = configWith([
      voiceCap({ id: "rt-expensive", supportsRealtimeVoice: true, costClass: "high" }),
      voiceCap({ id: "rt-cheap", supportsRealtimeVoice: true, costClass: "low" }),
    ]);
    expect(selectRealtimeVoiceModel(config)).toBe("rt-cheap");
  });

  it("never elects a realtime capability that names no configured provider (fail-closed)", () => {
    const config: GatewayConfig = {
      ...configWith([]),
      capabilities: [voiceCap({ supportsRealtimeVoice: true })],
    };
    expect(selectRealtimeVoiceModel(config)).toBeUndefined();
  });
});

// ─── Issue #1557 (Epic #1556, ADR-0088) ────────────────────────────────────────

function configFor(capabilities: readonly ModelCapability[]): GatewayConfig {
  return {
    providers: capabilities.map((capability) => ({
      modelId: capability.id,
      baseUrl: "https://example.test",
      apiKey: "test-key",
      timeoutMs: 30_000,
      maxRetries: 3,
      retryBaseDelayMs: 500,
    })),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities,
  };
}

interface VoiceProviderEntry {
  readonly capability: ModelCapability;
  readonly voiceProfiles?: readonly VoicePersonaVoice[] | undefined;
}

// A GatewayConfig whose providers carry the credential-tier persona → voice-id mapping (ADR-0088 D2).
function configWithVoiceProfiles(entries: readonly VoiceProviderEntry[]): GatewayConfig {
  return {
    providers: entries.map((entry) => ({
      modelId: entry.capability.id,
      baseUrl: "https://example.test",
      apiKey: "test-key",
      timeoutMs: 30_000,
      maxRetries: 3,
      retryBaseDelayMs: 500,
      ...(entry.voiceProfiles === undefined ? {} : { voiceProfiles: entry.voiceProfiles }),
    })),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: entries.map((entry) => entry.capability),
  };
}

describe("resolveVoiceCapabilityFromCapabilities — available voice personas (Issue #1557, AC3)", () => {
  it("reports no personas for a no-voice deployment", () => {
    expect(resolve([]).availableVoicePersonas).toEqual([]);
  });

  it("reports no personas for an STT-only deployment (personas are output voices)", () => {
    expect(resolve([voiceCap({ supportsSpeechInput: true })]).availableVoicePersonas).toEqual([]);
  });

  it("reports a speech-output provider's personas, sorted in canonical order", () => {
    const result = resolve([
      voiceCap({
        id: "keiko-tts",
        supportsSpeechOutput: true,
        supportedVoicePersonas: ["neutral", "male"],
      }),
    ]);
    expect(result.availableVoicePersonas).toEqual(["male", "neutral"]);
  });

  it("unions personas across reachable speech-output and realtime providers, deduped + sorted", () => {
    const result = resolve([
      voiceCap({ id: "keiko-tts", supportsSpeechOutput: true, supportedVoicePersonas: ["female"] }),
      voiceCap({
        id: "keiko-realtime",
        supportsRealtimeVoice: true,
        supportedVoicePersonas: ["male", "female"],
      }),
    ]);
    expect(result.availableVoicePersonas).toEqual(["male", "female"]);
  });

  it("excludes personas advertised only by an unreachable provider", () => {
    const result = resolve(
      [voiceCap({ id: "keiko-tts", supportsSpeechOutput: true, supportedVoicePersonas: ["male"] })],
      { unreachableProviderIds: new Set(["keiko-tts"]) },
    );
    expect(result.available).toBe(false);
    expect(result.availableVoicePersonas).toEqual([]);
  });

  it("ignores personas mistakenly attached to an STT-only provider (output-voice invariant)", () => {
    const result = resolve([
      voiceCap({ supportsSpeechInput: true, supportedVoicePersonas: ["male", "female"] }),
    ]);
    expect(result.availableVoicePersonas).toEqual([]);
  });
});

describe("selectSpeechOutputModel (Issue #1557, ADR-0088 D6)", () => {
  it("returns undefined for a no-voice (chat-only) deployment", () => {
    expect(selectSpeechOutputModel(configFor([chatCap()]))).toBeUndefined();
  });

  it("returns undefined when no provider is configured", () => {
    expect(selectSpeechOutputModel(configFor([]))).toBeUndefined();
  });

  it("returns undefined for an STT-only deployment (no speech output advertised)", () => {
    expect(
      selectSpeechOutputModel(configFor([voiceCap({ supportsSpeechInput: true })])),
    ).toBeUndefined();
  });

  it("selects the configured speech-output provider", () => {
    expect(
      selectSpeechOutputModel(
        configFor([voiceCap({ id: "keiko-tts", supportsSpeechOutput: true })]),
      ),
    ).toBe("keiko-tts");
  });

  it("prefers the cheapest configured speech-output provider", () => {
    const config = configFor([
      voiceCap({ id: "tts-high", supportsSpeechOutput: true, costClass: "high" }),
      voiceCap({ id: "tts-low", supportsSpeechOutput: true, costClass: "low" }),
    ]);
    expect(selectSpeechOutputModel(config)).toBe("tts-low");
  });

  it("never elects a speech-output capability that names no configured provider (fail-closed)", () => {
    const config: GatewayConfig = {
      ...configFor([]),
      capabilities: [voiceCap({ id: "keiko-tts", supportsSpeechOutput: true })],
    };
    expect(selectSpeechOutputModel(config)).toBeUndefined();
  });
});

describe("selectVoicePersonaVoice (Issue #1557, ADR-0088 D2/D6)", () => {
  it("returns undefined for a no-voice deployment", () => {
    expect(selectVoicePersonaVoice(configWithVoiceProfiles([]), "male")).toBeUndefined();
  });

  it("maps a persona to the provider voice id on a speech-output provider", () => {
    const config = configWithVoiceProfiles([
      {
        capability: voiceCap({ id: "keiko-tts", supportsSpeechOutput: true }),
        voiceProfiles: [
          { persona: "male", voiceId: "azure-male-1" },
          { persona: "female", voiceId: "azure-female-1" },
        ],
      },
    ]);
    expect(selectVoicePersonaVoice(config, "male")).toEqual({
      modelId: "keiko-tts",
      voiceId: "azure-male-1",
    });
    expect(selectVoicePersonaVoice(config, "female")).toEqual({
      modelId: "keiko-tts",
      voiceId: "azure-female-1",
    });
  });

  it("maps a persona on a realtime provider", () => {
    const config = configWithVoiceProfiles([
      {
        capability: voiceCap({ id: "keiko-realtime", supportsRealtimeVoice: true }),
        voiceProfiles: [{ persona: "neutral", voiceId: "rt-neutral" }],
      },
    ]);
    expect(selectVoicePersonaVoice(config, "neutral")).toEqual({
      modelId: "keiko-realtime",
      voiceId: "rt-neutral",
    });
  });

  it("returns undefined when the persona is not mapped by any provider", () => {
    const config = configWithVoiceProfiles([
      {
        capability: voiceCap({ id: "keiko-tts", supportsSpeechOutput: true }),
        voiceProfiles: [{ persona: "male", voiceId: "azure-male-1" }],
      },
    ]);
    expect(selectVoicePersonaVoice(config, "neutral")).toBeUndefined();
  });

  it("ignores a mapping on a provider that cannot render output personas (STT-only) — fail-closed", () => {
    const config = configWithVoiceProfiles([
      {
        capability: voiceCap({ id: "keiko-stt", supportsSpeechInput: true }),
        voiceProfiles: [{ persona: "male", voiceId: "x" }],
      },
    ]);
    expect(selectVoicePersonaVoice(config, "male")).toBeUndefined();
  });

  it("prefers the cheapest provider when several map the persona", () => {
    const config = configWithVoiceProfiles([
      {
        capability: voiceCap({ id: "tts-high", supportsSpeechOutput: true, costClass: "high" }),
        voiceProfiles: [{ persona: "male", voiceId: "high-male" }],
      },
      {
        capability: voiceCap({ id: "tts-low", supportsSpeechOutput: true, costClass: "low" }),
        voiceProfiles: [{ persona: "male", voiceId: "low-male" }],
      },
    ]);
    expect(selectVoicePersonaVoice(config, "male")).toEqual({
      modelId: "tts-low",
      voiceId: "low-male",
    });
  });
});
