import { describe, expect, it } from "vitest";
import { ConfigInvalidError } from "../../src/gateway/errors.js";
import { assertConfiguredModel, selectConfiguredModel } from "../../src/gateway/model-selection.js";
import type {
  GatewayConfig,
  ModelCapability,
  ModelProviderConfig,
} from "../../src/gateway/types.js";

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
      config(["gpt-oss-120b", "Mistral-Small-3.1-24B-Instruct-2503"]),
      { kind: "chat", toolCalling: true, structuredOutput: true },
    );
    expect(selected).toBe("Mistral-Small-3.1-24B-Instruct-2503");
  });

  it("skips configured models that do not satisfy structured-output requirements", () => {
    const selected = selectConfiguredModel(config(["Qwen2.5-Coder-7B-Instruct"]), {
      kind: "chat",
      toolCalling: true,
      structuredOutput: true,
    });
    expect(selected).toBeUndefined();
  });

  it("selects a configured customer-declared capability that is absent from the static registry", () => {
    const selected = selectConfiguredModel(
      config(
        ["customer-internal-chat"],
        [
          {
            id: "customer-internal-chat",
            kind: "chat",
            contextWindow: 64_000,
            maxOutputTokens: 4_096,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "internal endpoint",
            preferredUseCases: ["Customer coding workflow"],
            knownLimitations: [],
          },
        ],
      ),
      { kind: "chat", toolCalling: true, structuredOutput: true },
    );
    expect(selected).toBe("customer-internal-chat");
  });
});

describe("assertConfiguredModel", () => {
  it("rejects explicit model ids that are not configured as providers", () => {
    expect(() => {
      assertConfiguredModel(config(["gpt-oss-120b"]), "gemma-4-31b-it");
    }).toThrow(ConfigInvalidError);
  });
});
