import { describe, expect, it } from "vitest";
import { createDefaultProviderRuntimeRegistry } from "./provider-runtime.js";
import type {
  GatewayOpenAiCompatibleProviderConfig,
  OpenAiCodexLocalSessionRuntimeProviderConfig,
  OpenAiCodexLocalSessionProviderConfig,
  ProviderAdapter,
} from "./types.js";

function gatewayProvider(
  overrides: Partial<GatewayOpenAiCompatibleProviderConfig> = {},
): GatewayOpenAiCompatibleProviderConfig {
  return {
    modelId: "example-chat-model",
    providerId: "gateway-primary",
    providerType: "gateway-openai-compatible",
    validationState: "configured",
    baseUrl: "https://provider.example/v1",
    apiKey: "sk-config-secret-key-1234567890ab",
    apiKeyHeaderName: "authorization",
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function localSessionProvider(
  overrides: Partial<OpenAiCodexLocalSessionProviderConfig> = {},
): OpenAiCodexLocalSessionProviderConfig {
  return {
    modelId: "codex-chat",
    providerId: "codex-local",
    providerType: "openai-codex-local-session",
    validationState: "runtime-only",
    runtimeHandle: { kind: "codex-local-session" },
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

describe("createDefaultProviderRuntimeRegistry", () => {
  it("registers both supported provider types in deterministic order", () => {
    const registry = createDefaultProviderRuntimeRegistry();
    expect(registry.registrations.map((registration) => registration.providerType)).toEqual([
      "gateway-openai-compatible",
      "openai-codex-local-session",
    ]);
  });

  it("resolves a gateway-openai-compatible provider through the productive runtime path", () => {
    const registry = createDefaultProviderRuntimeRegistry();
    const override: ProviderAdapter = {
      call: () =>
        Promise.reject(new Error("not invoked in this unit test")),
    };
    const resolved = registry.resolve("example-chat-model", gatewayProvider(), {
      adapterOverride: override,
      requestId: "fixed-id",
      costClass: "medium",
      now: () => 0,
    });
    expect(resolved.provider).toMatchObject({
      providerId: "gateway-primary",
      providerType: "gateway-openai-compatible",
      modelId: "example-chat-model",
    });
    expect(resolved.adapter).toBe(override);
  });

  it("resolves a local-session provider through the injected runtime bridge", () => {
    const runtimeProvider: OpenAiCodexLocalSessionRuntimeProviderConfig = {
      providerId: "codex-local",
      providerType: "openai-codex-local-session",
      validationState: "runtime-only",
      modelId: "codex-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-local-session-secret-1234567890",
      apiKeyHeaderName: "authorization",
      timeoutMs: 30_000,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    };
    const override: ProviderAdapter = {
      call: () =>
        Promise.reject(new Error("not invoked in this unit test")),
    };
    const registry = createDefaultProviderRuntimeRegistry({
      localSessionResolver: () => runtimeProvider,
    });
    const resolved = registry.resolve("codex-chat", localSessionProvider(), {
      adapterOverride: override,
      requestId: "fixed-id",
      costClass: "medium",
      now: () => 0,
    });
    expect(resolved.provider).toEqual(runtimeProvider);
    expect(resolved.adapter).toBe(override);
  });
});
