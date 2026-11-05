import { describe, expect, it } from "vitest";
import { reasoningContinuationRouteDigest } from "./provider-identity.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";

function provider(modelId: string, required = false): ModelProviderConfig {
  return {
    modelId,
    baseUrl: "https://provider.example/v1",
    apiKey: "fixture-key",
    timeoutMs: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    ...(required ? { reasoningContinuation: "required-with-tools" as const } : {}),
  };
}

function config(providers: readonly ModelProviderConfig[]): GatewayConfig {
  return {
    providers,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

describe("native reasoning route provenance", () => {
  it("leaves default providers and existing session bindings unchanged", () => {
    expect(reasoningContinuationRouteDigest(config([provider("chat")]), "chat")).toBeUndefined();
  });

  it("binds primary and required agent routes without including secrets or catalog order", () => {
    const primary = provider("chat");
    const thinking = provider("thinking", true);
    const digest = reasoningContinuationRouteDigest(config([primary, thinking]), "chat");
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(reasoningContinuationRouteDigest(config([thinking, primary]), "chat")).toBe(digest);
    expect(
      reasoningContinuationRouteDigest(
        config([primary, { ...thinking, apiKey: "rotated" }]),
        "chat",
      ),
    ).toBe(digest);
    expect(reasoningContinuationRouteDigest(config([primary, thinking]), "thinking")).not.toBe(
      digest,
    );
    expect(
      reasoningContinuationRouteDigest(
        config([primary, { ...thinking, baseUrl: "https://changed.example/v1" }]),
        "chat",
      ),
    ).not.toBe(digest);
    expect(
      reasoningContinuationRouteDigest(
        config([{ ...primary, modelId: "other" }, thinking]),
        "other",
      ),
    ).not.toBe(digest);
  });

  it("does not invalidate native history when an unrelated non-thinking route changes", () => {
    const primary = provider("chat", true);
    expect(reasoningContinuationRouteDigest(config([primary, provider("embedding")]), "chat")).toBe(
      reasoningContinuationRouteDigest(config([provider("new-embedding"), primary]), "chat"),
    );
  });
});
