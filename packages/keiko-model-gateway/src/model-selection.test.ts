import { describe, expect, it } from "vitest";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { isConversationEligibleModel } from "./capabilities.js";
import {
  assertConfiguredModel,
  findConfiguredCapability,
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

function localSessionProvider(modelId: string): ModelProviderConfig {
  return {
    providerType: "openai-codex-local-session",
    modelId,
    credentialResolver: { kind: "codex-cli" },
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

describe("findConfiguredCapability", () => {
  it("derives a local-session-aware default capability for Codex-backed configured models", () => {
    const capability = findConfiguredCapability(
      {
        providers: [localSessionProvider("gpt-5.4")],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
      "gpt-5.4",
    );
    expect(capability).toMatchObject({
      id: "gpt-5.4",
      toolCalling: false,
      structuredOutput: true,
      workflowEligible: true,
      streaming: false,
    });
    expect(isConversationEligibleModel(capability!)).toBe(true);
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
