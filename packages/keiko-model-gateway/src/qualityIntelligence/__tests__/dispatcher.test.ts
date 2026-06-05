import { describe, expect, it } from "vitest";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-contracts";
import { createBudget } from "../budget.js";
import { dispatchQualityIntelligenceRequest } from "../dispatcher.js";
import { createInMemoryReplayCache } from "../replayCache.js";
import { QualityIntelligenceSafeErrorException } from "../safeError.js";
import { getQualityIntelligenceTaskProfile } from "../taskProfiles.js";
import type { ModelProviderConfig, ProviderAdapter } from "../../types.js";

function chatCapability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "fake-chat",
    kind: "chat",
    contextWindow: 32_000,
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
    preferredUseCases: [],
    knownLimitations: [],
    ...overrides,
  };
}

function providerConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "fake-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test-secret-NEVER-LEAK",
    timeoutMs: 5_000,
    maxRetries: 1,
    retryBaseDelayMs: 50,
    ...overrides,
  };
}

function normalisedResponse(content: string): NormalizedResponse {
  return {
    modelId: "fake-chat",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "test-req",
      promptTokens: 10,
      completionTokens: 20,
      latencyMs: 5,
      costClass: "medium",
    },
  };
}

interface MockCall {
  readonly request: GatewayRequest;
  readonly config: ModelProviderConfig;
}

interface MockModelPort extends ProviderAdapter {
  readonly calls: readonly MockCall[];
}

type Behaviour =
  | { kind: "respond"; content: string }
  | { kind: "throw"; error: Error }
  | { kind: "respect-signal"; sleepMs: number };

function createMockModelPort(behaviour: Behaviour): MockModelPort {
  const calls: MockCall[] = [];
  const adapter: ProviderAdapter = {
    call: async (request, config) => {
      calls.push({ request, config });
      if (behaviour.kind === "respond") {
        return await Promise.resolve(normalisedResponse(behaviour.content));
      }
      if (behaviour.kind === "throw") {
        return await Promise.reject(behaviour.error);
      }
      // Sleep until either the signal aborts or the sleep elapses.
      return await new Promise<NormalizedResponse>((resolve, reject) => {
        const signal = request.cancellationSignal;
        const timer = setTimeout(() => {
          resolve(normalisedResponse("late"));
        }, behaviour.sleepMs);
        if (signal !== undefined) {
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted by signal"));
            },
            { once: true },
          );
        }
      });
    },
  };
  return Object.assign(adapter, { calls });
}

describe("dispatchQualityIntelligenceRequest", () => {
  it("happy path: returns response, advances budget, stores cache on second call", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const port = createMockModelPort({ kind: "respond", content: "hello" });
    const cache = createInMemoryReplayCache<NormalizedResponse>(16);
    const budget = createBudget(10_000);
    const args = {
      profile,
      instruction: "judge",
      evidence: [{ kind: "atom-ref" as const, value: "x" }],
      model: chatCapability(),
      providerConfig: providerConfig(),
      port,
      cache,
      budget,
    };
    const first = await dispatchQualityIntelligenceRequest(args);
    expect(first.response.content).toBe("hello");
    expect(first.cacheHit).toBe(false);
    expect(first.budget.consumed).toBe(profile.tokenBudgetHint);
    expect(port.calls).toHaveLength(1);

    const second = await dispatchQualityIntelligenceRequest(args);
    expect(second.cacheHit).toBe(true);
    expect(port.calls).toHaveLength(1);
  });

  it("does not cache non-cacheable profiles (qi:self-check)", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:self-check");
    const port = createMockModelPort({ kind: "respond", content: "ok" });
    const cache = createInMemoryReplayCache<NormalizedResponse>(16);
    const args = {
      profile,
      instruction: "check",
      evidence: [],
      model: chatCapability(),
      providerConfig: providerConfig(),
      port,
      cache,
      budget: createBudget(10_000),
    };
    const r1 = await dispatchQualityIntelligenceRequest(args);
    const r2 = await dispatchQualityIntelligenceRequest(args);
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(false);
    expect(port.calls).toHaveLength(2);
  });

  it("capability mismatch surfaces as qi/capability-mismatch and never calls the port", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const port = createMockModelPort({ kind: "respond", content: "never" });
    let caught: unknown;
    try {
      await dispatchQualityIntelligenceRequest({
        profile,
        instruction: "x",
        evidence: [],
        model: chatCapability({ structuredOutput: false }),
        providerConfig: providerConfig(),
        port,
        cache: createInMemoryReplayCache<NormalizedResponse>(4),
        budget: createBudget(10_000),
      });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/capability-mismatch");
    }
    expect(port.calls).toHaveLength(0);
  });

  it("budget exhausted surfaces as qi/budget-exhausted and never calls the port", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const port = createMockModelPort({ kind: "respond", content: "never" });
    let caught: unknown;
    try {
      await dispatchQualityIntelligenceRequest({
        profile,
        instruction: "x",
        evidence: [],
        model: chatCapability(),
        providerConfig: providerConfig(),
        port,
        cache: createInMemoryReplayCache<NormalizedResponse>(4),
        budget: createBudget(0),
      });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/budget-exhausted");
    }
    expect(port.calls).toHaveLength(0);
  });

  it("provider error is normalised to qi/provider-error and never leaks the cause", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const port = createMockModelPort({
      kind: "throw",
      error: new Error("DOWNSTREAM Bearer sk-leaked endpoint=https://prod.test/v1"),
    });
    let caught: unknown;
    try {
      await dispatchQualityIntelligenceRequest({
        profile,
        instruction: "x",
        evidence: [],
        model: chatCapability(),
        providerConfig: providerConfig(),
        port,
        cache: createInMemoryReplayCache<NormalizedResponse>(4),
        budget: createBudget(10_000),
      });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/provider-error");
      expect(caught.message).not.toContain("Bearer");
      expect(caught.message).not.toContain("sk-leaked");
      expect(caught.message).not.toContain("endpoint=");
    }
  });

  it("timeout surfaces as qi/timeout when the profile timeout elapses first", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:self-check");
    // Force a very short effective timeout by using a custom profile-like object.
    const tinyTimeoutProfile = { ...profile, timeoutMsHint: 10 } as const;
    const port = createMockModelPort({ kind: "respect-signal", sleepMs: 500 });
    let caught: unknown;
    try {
      await dispatchQualityIntelligenceRequest({
        profile: tinyTimeoutProfile,
        instruction: "x",
        evidence: [],
        model: chatCapability(),
        providerConfig: providerConfig(),
        port,
        cache: createInMemoryReplayCache<NormalizedResponse>(4),
        budget: createBudget(10_000),
      });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/timeout");
    }
  });

  it("external abort surfaces as qi/cancelled", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const port = createMockModelPort({ kind: "respect-signal", sleepMs: 500 });
    const ctrl = new AbortController();
    setTimeout(() => {
      ctrl.abort();
    }, 10);
    let caught: unknown;
    try {
      await dispatchQualityIntelligenceRequest({
        profile,
        instruction: "x",
        evidence: [],
        model: chatCapability(),
        providerConfig: providerConfig(),
        port,
        cache: createInMemoryReplayCache<NormalizedResponse>(4),
        budget: createBudget(10_000),
        signal: ctrl.signal,
      });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/cancelled");
    }
  });

  it("forwards the assembled GatewayRequest to the port (system + user, no provider SDK)", async () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const port = createMockModelPort({ kind: "respond", content: "ok" });
    await dispatchQualityIntelligenceRequest({
      profile,
      instruction: "judge",
      evidence: [{ kind: "atom-ref" as const, value: "ev-1" }],
      model: chatCapability(),
      providerConfig: providerConfig(),
      port,
      cache: createInMemoryReplayCache<NormalizedResponse>(4),
      budget: createBudget(10_000),
    });
    expect(port.calls).toHaveLength(1);
    const sent = port.calls[0];
    expect(sent?.request.modelId).toBe("fake-chat");
    expect(sent?.request.messages.length).toBe(2);
    expect(sent?.request.messages[0]?.role).toBe("system");
    expect(sent?.request.messages[1]?.role).toBe("user");
    expect(sent?.request.cancellationSignal).toBeDefined();
  });
});
