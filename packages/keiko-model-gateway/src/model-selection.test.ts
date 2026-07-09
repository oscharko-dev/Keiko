import { describe, expect, it } from "vitest";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { COST_RANK, isConversationEligibleModel } from "./capabilities.js";
import {
  assertConfiguredModel,
  findConfiguredCapability,
  resolveCodingSafeSidecarGatewayProfile,
  selectConfiguredModel,
} from "./model-selection.js";
import type { GatewayConfig, ModelCapability, ModelProviderConfig } from "./types.js";

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
  capabilities: readonly ModelCapability[] = [],
): GatewayConfig {
  return {
    providers: modelIds.map(provider),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    ...(capabilities.length === 0 ? {} : { capabilities }),
  };
}

function codingSidecarCapability(
  modelId: string,
  overrides: Partial<ModelCapability> = {},
): ModelCapability {
  return {
    id: modelId,
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
    throughputHint: "coding-sidecar",
    preferredUseCases: ["Coding"],
    knownLimitations: [],
    ...overrides,
  };
}

function sidecarConfig(
  providers: readonly ModelProviderConfig[],
  capabilities: readonly ModelCapability[],
): GatewayConfig {
  return {
    providers,
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities,
  };
}

describe("selectConfiguredModel", () => {
  it("selects the cheapest configured chat model matching tool and structured-output needs", () => {
    const selected = selectConfiguredModel(
      config(
        ["example-chat-model", "example-chat-model-fast"],
        [
          {
            id: "example-chat-model",
            kind: "chat",
            contextWindow: 0,
            maxOutputTokens: 0,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "high",
            latencyClass: "standard",
            throughputHint: "test",
            preferredUseCases: ["Test"],
            knownLimitations: [],
          },
          {
            id: "example-chat-model-fast",
            kind: "chat",
            contextWindow: 0,
            maxOutputTokens: 0,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "medium",
            latencyClass: "fast",
            throughputHint: "test",
            preferredUseCases: ["Test"],
            knownLimitations: [],
          },
        ],
      ),
      { kind: "chat", toolCalling: true, structuredOutput: true },
    );
    expect(selected).toBe("example-chat-model-fast");
  });

  it("skips configured models that do not satisfy structured-output requirements", () => {
    const selected = selectConfiguredModel(
      config(
        ["example-chat-model-unstructured"],
        [
          {
            id: "example-chat-model-unstructured",
            kind: "chat",
            contextWindow: 0,
            maxOutputTokens: 0,
            toolCalling: true,
            structuredOutput: false,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "low",
            latencyClass: "fast",
            throughputHint: "test",
            preferredUseCases: ["Test"],
            knownLimitations: [],
          },
        ],
      ),
      {
        kind: "chat",
        toolCalling: true,
        structuredOutput: true,
      },
    );
    expect(selected).toBeUndefined();
  });

  it("selects a configured runtime-declared capability", () => {
    const selected = selectConfiguredModel(
      config(
        ["example-private-chat"],
        [
          {
            id: "example-private-chat",
            kind: "chat",
            contextWindow: 64_000,
            maxOutputTokens: 4_096,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "local endpoint",
            preferredUseCases: ["Local coding workflow"],
            knownLimitations: [],
          },
        ],
      ),
      { kind: "chat", toolCalling: true, structuredOutput: true },
    );
    expect(selected).toBe("example-private-chat");
  });
});

// Issue #810: multimodal (image-input) selection through the config-aware selector.
describe("selectConfiguredModel — supportsImageInput (multimodal) routing", () => {
  function chatCap(id: string, supportsImageInput: boolean): ModelCapability {
    return {
      id,
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput,
      supportsDocumentInput: false,
      workflowEligible: true,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "test",
      preferredUseCases: ["Test"],
      knownLimitations: [],
    };
  }

  it("selects the configured vision model by capability when supportsImageInput is requested", () => {
    const selected = selectConfiguredModel(
      config(
        ["example-text-chat", "llama-4-maverick-vision"],
        [chatCap("example-text-chat", false), chatCap("llama-4-maverick-vision", true)],
      ),
      { kind: "chat", supportsImageInput: true },
    );
    expect(selected).toBe("llama-4-maverick-vision");
  });

  it("returns undefined when no configured model advertises image input", () => {
    const selected = selectConfiguredModel(
      config(["example-text-chat"], [chatCap("example-text-chat", false)]),
      { kind: "chat", supportsImageInput: true },
    );
    expect(selected).toBeUndefined();
  });

  // Mutation guard: a default-derived chat model (supportsImageInput === false) must NOT be
  // selected for an image-input query — no silent text fallback masquerading as vision.
  it("excludes a default-derived chat model (no explicit capability) from an image-input query", () => {
    const selected = selectConfiguredModel(config(["gpt-oss-120b"]), {
      kind: "chat",
      supportsImageInput: true,
    });
    expect(selected).toBeUndefined();
  });
});

describe("assertConfiguredModel", () => {
  it("rejects explicit model ids that are not configured as providers", () => {
    expect(() => {
      assertConfiguredModel(config(["example-chat-model"]), "example-chat-model-general");
    }).toThrow(ConfigInvalidError);
  });
});

// Issue #144 / Epic #142: embedding-name heuristic in the config-load derivation fallback.
// These tests exercise the single derivation point (findConfiguredCapability line 44).
describe("findConfiguredCapability — embedding-id heuristic (no explicit capability)", () => {
  it("derives kind:'embedding' for 'text-embedding-3-large' with no explicit capability", () => {
    const cap = findConfiguredCapability(
      config(["text-embedding-3-large"]),
      "text-embedding-3-large",
    );
    expect(cap?.kind).toBe("embedding");
  });

  it("derives kind:'embedding' for 'text-embedding-ada-002' with no explicit capability", () => {
    const cap = findConfiguredCapability(
      config(["text-embedding-ada-002"]),
      "text-embedding-ada-002",
    );
    expect(cap?.kind).toBe("embedding");
  });

  it("derives kind:'embedding' for 'acme-embed' with no explicit capability", () => {
    const cap = findConfiguredCapability(config(["acme-embed"]), "acme-embed");
    expect(cap?.kind).toBe("embedding");
  });

  it("derives kind:'embedding' for 'nomic-embed-text' with no explicit capability", () => {
    const cap = findConfiguredCapability(config(["nomic-embed-text"]), "nomic-embed-text");
    expect(cap?.kind).toBe("embedding");
  });

  it("marks derived embedding capability as NOT conversation-eligible (AC #143/#144)", () => {
    const cap = findConfiguredCapability(
      config(["text-embedding-3-large"]),
      "text-embedding-3-large",
    );
    expect(cap).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(isConversationEligibleModel(cap!)).toBe(false);
  });

  it("marks derived embedding capability as not workflowEligible", () => {
    const cap = findConfiguredCapability(
      config(["text-embedding-3-large"]),
      "text-embedding-3-large",
    );
    expect(cap?.workflowEligible).toBe(false);
  });

  // Regression guard: unknown chat-looking ids must STILL get kind:'chat'.
  it("derives kind:'chat' for 'gpt-oss-120b' with no explicit capability", () => {
    const cap = findConfiguredCapability(config(["gpt-oss-120b"]), "gpt-oss-120b");
    expect(cap?.kind).toBe("chat");
  });

  it("derives kind:'chat' for 'mistral-large-3' with no explicit capability", () => {
    const cap = findConfiguredCapability(config(["mistral-large-3"]), "mistral-large-3");
    expect(cap?.kind).toBe("chat");
  });

  it("derives kind:'chat' for 'llama-4-maverick-vision' with no explicit capability", () => {
    const cap = findConfiguredCapability(
      config(["llama-4-maverick-vision"]),
      "llama-4-maverick-vision",
    );
    expect(cap?.kind).toBe("chat");
  });

  // Explicit capability ALWAYS wins — even when the id looks like an embedding.
  it("respects an explicit kind:'chat' capability for an embedding-looking id", () => {
    const explicitChatCap: ModelCapability = {
      id: "text-embedding-3-large",
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
      throughputHint: "explicit override",
      preferredUseCases: ["Chat"],
      knownLimitations: [],
    };
    const cap = findConfiguredCapability(
      config(["text-embedding-3-large"], [explicitChatCap]),
      "text-embedding-3-large",
    );
    expect(cap?.kind).toBe("chat");
  });
});

// Issue #144: embedding-derived model must not be selectable via a chat query.
describe("selectConfiguredModel — embedding ids are excluded from chat selection", () => {
  it("returns undefined when only an embedding-id model is configured and a chat query is issued", () => {
    const selected = selectConfiguredModel(config(["text-embedding-3-large"]), {
      kind: "chat",
      toolCalling: true,
      structuredOutput: true,
    });
    expect(selected).toBeUndefined();
  });
});

// Issue #762 hardening: each matches() conjunct must be individually decisive, and the cheapest
// tie-break must be deterministic. Without these, mutants that drop the toolCalling/minContextWindow
// guard or flip the cost comparison (`<`→`<=`) survive the suite — the QI selector relies on all of
// them being correct.
describe("selectConfiguredModel — conjunct guards & deterministic tie-break (#762)", () => {
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

  it("excludes a model that lacks tool calling when toolCalling is required (guard is decisive)", () => {
    const selected = selectConfiguredModel(
      config(["no-tools"], [chatCap("no-tools", { toolCalling: false })]),
      { kind: "chat", toolCalling: true },
    );
    expect(selected).toBeUndefined();
  });

  it("excludes a model below the requested minimum context window", () => {
    const selected = selectConfiguredModel(
      config(["small-ctx"], [chatCap("small-ctx", { contextWindow: 32_000 })]),
      { kind: "chat", minContextWindow: 64_000 },
    );
    expect(selected).toBeUndefined();
  });

  it("selects a model that meets the requested minimum context window", () => {
    const selected = selectConfiguredModel(
      config(["big-ctx"], [chatCap("big-ctx", { contextWindow: 128_000 })]),
      { kind: "chat", minContextWindow: 64_000 },
    );
    expect(selected).toBe("big-ctx");
  });

  it("breaks an equal-cost tie deterministically in favour of the first-configured model", () => {
    const selected = selectConfiguredModel(
      config(
        ["tie-first", "tie-second"],
        [chatCap("tie-first", { costClass: "low" }), chatCap("tie-second", { costClass: "low" })],
      ),
      { kind: "chat" },
    );
    expect(selected).toBe("tie-first");
  });
});

describe("COST_RANK single source of truth (GEN-DUP-EXACT-002)", () => {
  it("ranks cost classes strictly ascending low < medium < high", () => {
    // model-selection.ts no longer keeps its own COST_RANK copy; it imports this canonical one from
    // capabilities.ts. Pinning the ordering guards the cheapest-first selection contract.
    expect(COST_RANK.low).toBeLessThan(COST_RANK.medium);
    expect(COST_RANK.medium).toBeLessThan(COST_RANK.high);
  });
});

describe("resolveCodingSafeSidecarGatewayProfile", () => {
  it("selects a configured coding-capable model and omits provider endpoint and credential details", () => {
    const configValue = sidecarConfig(
      [
        {
          modelId: "azure-coding-model",
          baseUrl: "https://azure.example/openai",
          apiKey: "azure-secret",
          apiKeyHeaderName: "api-key",
          endpointStyle: "azure-openai-deployment",
          apiVersion: "2024-06-01",
          timeoutMs: 30_000,
          maxRetries: 3,
          retryBaseDelayMs: 500,
        },
      ],
      [codingSidecarCapability("azure-coding-model")],
    );

    const result = resolveCodingSafeSidecarGatewayProfile(configValue);

    expect(result).toMatchObject({
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "azure-coding-model",
      localEndpointPath: "/api/coding-sidecar/gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
    });
    expect(JSON.stringify(result)).not.toContain("baseUrl");
    expect(JSON.stringify(result)).not.toContain("apiKey");
    expect(JSON.stringify(result)).not.toContain("api-key");
  });

  it("fails closed when a chat tool-calling workflow-eligible model is not coding-capable", () => {
    const configValue = sidecarConfig(
      [
        {
          modelId: "chat-only-sidecar",
          baseUrl: "https://provider.example/openai",
          apiKey: "chat-only-secret",
          timeoutMs: 30_000,
          maxRetries: 3,
          retryBaseDelayMs: 500,
        },
      ],
      [
        codingSidecarCapability("chat-only-sidecar", {
          preferredUseCases: ["Chat"],
        }),
      ],
    );

    expect(resolveCodingSafeSidecarGatewayProfile(configValue)).toEqual({
      status: "unavailable",
      reason: "non-coding-capable",
    });
  });

  it.each([
    {
      label: "deployment policy disabled",
      result: resolveCodingSafeSidecarGatewayProfile(sidecarConfig([], []), {
        deploymentPolicyDisabled: true,
      }),
      reason: "deployment-policy-disabled" as const,
    },
    {
      label: "subscription source",
      result: resolveCodingSafeSidecarGatewayProfile(sidecarConfig([], []), {
        modelSource: "chatgpt-codex-subscription-profile",
      }),
      reason: "subscription-source" as const,
    },
  ])("fails closed for $label", ({ result, reason }) => {
    expect(result).toEqual({ status: "unavailable", reason });
  });

  it.each([
    {
      label: "non-chat capability",
      config: sidecarConfig(
        [
          {
            modelId: "text-model",
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            timeoutMs: 30_000,
            maxRetries: 3,
            retryBaseDelayMs: 500,
          },
        ],
        [
          {
            ...codingSidecarCapability("text-model"),
            kind: "embedding",
          },
        ],
      ),
      reason: "non-chat" as const,
    },
    {
      label: "tool-calling disabled",
      config: sidecarConfig(
        [
          {
            modelId: "no-tools",
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            timeoutMs: 30_000,
            maxRetries: 3,
            retryBaseDelayMs: 500,
          },
        ],
        [codingSidecarCapability("no-tools", { toolCalling: false })],
      ),
      reason: "no-tool-calling" as const,
    },
    {
      label: "workflow disabled",
      config: sidecarConfig(
        [
          {
            modelId: "no-workflow",
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            timeoutMs: 30_000,
            maxRetries: 3,
            retryBaseDelayMs: 500,
          },
        ],
        [codingSidecarCapability("no-workflow", { workflowEligible: false })],
      ),
      reason: "non-workflow-eligible" as const,
    },
    {
      label: "missing credentials",
      config: sidecarConfig(
        [
          {
            modelId: "missing-credentials",
            baseUrl: " ",
            apiKey: "",
            timeoutMs: 30_000,
            maxRetries: 3,
            retryBaseDelayMs: 500,
          },
        ],
        [codingSidecarCapability("missing-credentials")],
      ),
      reason: "missing-credentials" as const,
    },
  ])("fails closed for $label", ({ config: configValue, reason }) => {
    expect(resolveCodingSafeSidecarGatewayProfile(configValue)).toEqual({
      status: "unavailable",
      reason,
    });
  });
});
