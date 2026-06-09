import { describe, expect, it } from "vitest";
import {
  validateProviderSelection,
  validateSafeGatewayConfig,
  validateSafeProviderConfig,
  type SafeGatewayConfig,
  type SafeGatewayOpenAiCompatibleProviderConfig,
  type SafeProviderConfig,
  type SafeOpenAiCodexLocalSessionProviderConfig,
} from "./provider-contract.js";

function gatewayProvider(): SafeGatewayOpenAiCompatibleProviderConfig {
  return {
    providerId: "gateway-example-chat-model",
    providerType: "gateway-openai-compatible",
    modelId: "example-chat-model",
    validationState: "configured",
    credentialHeaderName: "authorization",
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
  };
}

function localSessionProvider(): SafeOpenAiCodexLocalSessionProviderConfig {
  return {
    providerId: "codex-local-example-chat-model",
    providerType: "openai-codex-local-session",
    modelId: "example-chat-model",
    validationState: "runtime-only",
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
  };
}

function safeGatewayConfig(): SafeGatewayConfig {
  return {
    providers: [gatewayProvider(), localSessionProvider()],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

describe("validateProviderSelection", () => {
  it("accepts a non-empty providerId and modelId", () => {
    expect(
      validateProviderSelection({
        providerId: "gateway-example-chat-model",
        modelId: "example-chat-model",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects an empty providerId", () => {
    expect(
      validateProviderSelection({
        providerId: "",
        modelId: "example-chat-model",
      }),
    ).toEqual({
      ok: false,
      reason: "providerSelection.providerId must be a non-empty string",
    });
  });
});

describe("validateSafeProviderConfig", () => {
  it("accepts a gateway-openai-compatible safe provider config", () => {
    expect(validateSafeProviderConfig(gatewayProvider())).toEqual({ ok: true });
  });

  it("accepts an openai-codex-local-session safe provider config without fake credential fields", () => {
    expect(validateSafeProviderConfig(localSessionProvider())).toEqual({ ok: true });
  });

  it("rejects a gateway provider missing a credential header name", () => {
    expect(
      validateSafeProviderConfig({
        ...gatewayProvider(),
        credentialHeaderName: "",
      }),
    ).toEqual({
      ok: false,
      reason:
        "safeProviderConfig.credentialHeaderName must be a non-empty string for gateway-openai-compatible providers",
    });
  });

  it("rejects a local-session provider that claims configured validation state", () => {
    expect(
      validateSafeProviderConfig(
        {
          ...localSessionProvider(),
          validationState: "configured",
        } as unknown as SafeProviderConfig,
      ),
    ).toEqual({
      ok: false,
      reason:
        "safeProviderConfig.validationState must be 'runtime-only' for openai-codex-local-session providers",
    });
  });
});

describe("validateSafeGatewayConfig", () => {
  it("accepts a mixed provider safe gateway config", () => {
    expect(validateSafeGatewayConfig(safeGatewayConfig())).toEqual({ ok: true });
  });

  it("rejects a bad provider entry with an indexed error", () => {
    const result = validateSafeGatewayConfig({
      ...safeGatewayConfig(),
      providers: [
        gatewayProvider(),
        {
          ...localSessionProvider(),
          modelId: "",
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      reason:
        "safeGatewayConfig.providers[1]: safeProviderConfig.modelId must be a non-empty string",
    });
  });
});
