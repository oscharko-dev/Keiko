import { describe, expect, it } from "vitest";
import {
  assertReasoningPolicyOwner,
  reasoningContinuationRouteDigest,
  toolCallingConfigurationFingerprint,
} from "./provider-identity.js";
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

describe("shared and native provider identity convergence", () => {
  it.each([
    { reasoningHistory: "required-with-tools" as const },
    { reasoningHistory: "current-turn" as const },
    { reasoningHistoryField: "reasoning" as const },
    { reasoningHistoryField: "reasoning_content" as const },
  ])("binds shared policy %j and refuses its use with native state", (shared) => {
    const plain = provider("chat");
    expect(toolCallingConfigurationFingerprint({ ...plain, ...shared })).not.toBe(
      toolCallingConfigurationFingerprint(plain),
    );
    expect(() => {
      assertReasoningPolicyOwner({ ...provider("chat", true), ...shared });
    }).toThrow(/cannot be combined/u);
    expect(() => {
      assertReasoningPolicyOwner({ ...plain, ...shared });
    }).not.toThrow();
  });

  it("invalidates the native primary-route binding when its shared policy changes", () => {
    const primary = provider("chat");
    const agent = provider("agent", true);
    const original = reasoningContinuationRouteDigest(config([primary, agent]), "chat");
    expect(
      reasoningContinuationRouteDigest(
        config([{ ...primary, reasoningHistory: "current-turn" }, agent]),
        "chat",
      ),
    ).not.toBe(original);
  });
});

it("distinguishes native session ownership from shared reasoning history", () => {
  const base = provider("chat");
  expect(
    toolCallingConfigurationFingerprint({ ...base, reasoningContinuation: "required-with-tools" }),
  ).not.toBe(
    toolCallingConfigurationFingerprint({ ...base, reasoningHistory: "required-with-tools" }),
  );
});
