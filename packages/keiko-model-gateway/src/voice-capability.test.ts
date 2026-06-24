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
import { resolveVoiceCapability } from "./model-selection.js";
import type { GatewayConfig } from "./types.js";

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
