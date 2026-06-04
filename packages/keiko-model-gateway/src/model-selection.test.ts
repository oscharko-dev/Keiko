import { describe, expect, it } from "vitest";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { assertConfiguredModel, selectConfiguredModel } from "./model-selection.js";
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

describe("assertConfiguredModel", () => {
  it("rejects explicit model ids that are not configured as providers", () => {
    expect(() => {
      assertConfiguredModel(config(["example-chat-model"]), "example-chat-model-general");
    }).toThrow(ConfigInvalidError);
  });
});
