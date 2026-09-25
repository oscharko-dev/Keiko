import { describe, expect, it } from "vitest";
import { Gateway } from "./gateway.js";
import { ResponseRedactionError } from "./openai-adapter.js";
import { createScriptedGatewayClock } from "./replay.js";
import {
  GATEWAY_BUFFERED_BUDGET_FLOOR_MS,
  GATEWAY_SILENCE_FLOOR_MS,
  providerRequestBudgetMs,
  providerRetryConfig,
} from "./resilience.js";
import {
  CancelledError,
  CircuitOpenError,
  ERROR_CODES,
  GatewayEgressError,
  MalformedToolCallError,
  ProviderEmptyAnswerError,
  ProviderError,
  ProviderOutputExhaustedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  Clock,
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";
import { GatewayToolCatalogError } from "./toolCatalogBridge.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://provider.example/v1",
    apiKey: ["sk-", "config-secret-key-1234567890ab"].join(""),
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function config(providers: ModelProviderConfig[]): GatewayConfig {
  return {
    providers,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

function okResponse(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "answer",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

function fakeAdapter(impl: ProviderAdapter["call"]): ProviderAdapter {
  return { call: impl };
}

const REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "q" }],
};

describe("Gateway.chat", () => {
  // #3591 / PR #3602 review: the buffered-answer floor now applies to every whole-body
  // Gateway.chat() attempt (this fakeAdapter has no `callStream`), not just "coding-workbench"
  // ones (raising the Workbench provider floor to the silence floor makes that
  // special case fully redundant here — it is dominated by the larger buffered floor every attempt
  // already gets; the Workbench pre-floor still matters for chatStream(), see the "uses the
  // Workbench latency floor only for marked streaming calls" test below). A configured value
  // already at or above the buffered floor passes through unmodified either way.
  it("floors every whole-body Gateway.chat() attempt to the buffered-answer floor, letting an already-generous configured value through unmodified", async () => {
    const timeouts: number[] = [];
    const gateway = new Gateway(config([provider({ maxRetries: 0 })]), {
      clock: createScriptedGatewayClock(),
      adapter: fakeAdapter((_request, cfg) => {
        timeouts.push(cfg.timeoutMs);
        return Promise.resolve(okResponse(cfg.modelId));
      }),
    });
    await gateway.chat(REQUEST);
    await gateway.chat({ ...REQUEST, latencyProfile: "coding-workbench" });
    const aboveFloor = GATEWAY_BUFFERED_BUDGET_FLOOR_MS + 200_000;
    const longConfigured = new Gateway(
      config([provider({ timeoutMs: aboveFloor, maxRetries: 0 })]),
      {
        clock: createScriptedGatewayClock(),
        adapter: fakeAdapter((_request, cfg) => {
          timeouts.push(cfg.timeoutMs);
          return Promise.resolve(okResponse(cfg.modelId));
        }),
      },
    );
    await longConfigured.chat({ ...REQUEST, latencyProfile: "coding-workbench" });
    expect(timeouts).toStrictEqual([
      GATEWAY_BUFFERED_BUDGET_FLOOR_MS,
      GATEWAY_BUFFERED_BUDGET_FLOOR_MS,
      aboveFloor,
    ]);
  });

  it("returns a response with a UUID v4 request id and exact deterministic latency", async () => {
    // Bespoke on purpose: this pins an exact now()-call-count sequence
    // (createScriptedGatewayClock's now() never advances merely by being read, so it cannot
    // reproduce this without also faking a sleep-driven advance the adapter never performs here).
    // now() sequence: 1000 (start), 1042 (end). Math.max(1, 1042-1000) = 42.
    const sequence = [1000, 1042];
    let callIndex = 0;
    const deterministicClock: Clock = {
      now: (): number => sequence[callIndex++] ?? 1042,
      sleep: (): Promise<void> => Promise.resolve(),
    };
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse("example-chat-model"))),
      clock: deterministicClock,
    });
    const result = await gateway.chat(REQUEST);
    expect(result.usage.requestId).toMatch(UUID_V4);
    expect(result.usage.latencyMs).toBe(42);
  });

  it("stamps usage.costClass from the runtime default for an undeclared model", async () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter((_req, cfg) => Promise.resolve(okResponse(cfg.modelId))),
      clock: createScriptedGatewayClock(),
    });
    const result = await gateway.chat(REQUEST);
    expect(result.usage.costClass).toBe("medium");
  });

  it("routes runtime-declared chat capabilities", async () => {
    const modelId = "example-private-chat";
    const gateway = new Gateway(
      {
        ...config([provider({ modelId })]),
        capabilities: [
          {
            id: modelId,
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
      },
      {
        adapter: fakeAdapter((_req, cfg) => Promise.resolve(okResponse(cfg.modelId))),
        clock: createScriptedGatewayClock(),
      },
    );
    const result = await gateway.chat({ modelId, messages: [{ role: "user", content: "q" }] });
    expect(result.modelId).toBe(modelId);
    expect(result.usage.costClass).toBe("medium");
  });

  it("throws UnknownModelError when the model is not configured", async () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse("x"))),
      clock: createScriptedGatewayClock(),
    });
    await expect(gateway.chat({ modelId: "not-configured", messages: [] })).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });

  it("throws UnknownModelError with a kind hint for an embedding model on the chat path", async () => {
    const embed = provider({ modelId: "example-embedding-model" });
    const gateway = new Gateway(
      {
        ...config([embed]),
        capabilities: [
          {
            id: "example-embedding-model",
            kind: "embedding",
            contextWindow: 0,
            maxOutputTokens: 0,
            toolCalling: false,
            structuredOutput: false,
            streaming: false,
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
      },
      {
        adapter: fakeAdapter(() => Promise.resolve(okResponse("x"))),
        clock: createScriptedGatewayClock(),
      },
    );
    try {
      await gateway.chat({ modelId: "example-embedding-model", messages: [] });
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelError);
      expect((error as Error).message).toContain("embedding");
    }
  });

  it("never leaks the configured apiKey in a thrown error", async () => {
    const upstreamKey = ["sk-", "config-secret-key-1234567890ab"].join("");
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() =>
        Promise.reject(new TransportError(`upstream ${upstreamKey} failed`)),
      ),
      clock: createScriptedGatewayClock(),
    });
    try {
      await gateway.chat(REQUEST);
      expect.unreachable("should throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(upstreamKey);
    }
  });

  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => {
        calls += 1;
        return calls < 2
          ? Promise.reject(new TransportError("boom"))
          : Promise.resolve(okResponse("example-chat-model"));
      }),
      clock: createScriptedGatewayClock(),
    });
    const result = await gateway.chat(REQUEST);
    expect(result.content).toBe("answer");
    expect(calls).toBe(2);
  });

  it("does not retry hard outbound egress failures", async () => {
    let calls = 0;
    const gateway = new Gateway(config([provider({ maxRetries: 3 })]), {
      adapter: fakeAdapter(() => {
        calls += 1;
        return Promise.reject(
          new GatewayEgressError(ERROR_CODES.PROXY_BLOCKED_BY_POLICY, "proxy blocked egress"),
        );
      }),
      clock: createScriptedGatewayClock(),
    });
    await expect(gateway.chat(REQUEST)).rejects.toMatchObject({
      code: ERROR_CODES.PROXY_BLOCKED_BY_POLICY,
    });
    expect(calls).toBe(1);
  });

  it("does not count a ResponseRedactionError as a breaker fault — consecutiveFailures stays 0 and state stays closed (review finding, PR #3394)", async () => {
    // RED reasoning: recordProviderFailure previously excluded only CancelledError and
    // ConfigInvalidError, so a ResponseRedactionError — thrown by openai-adapter.ts's redaction
    // depth guard when a response body nests pathologically deep, never the provider's fault —
    // still incremented consecutiveFailures and could eventually trip the breaker for an
    // otherwise healthy model.
    let calls = 0;
    const gateway = new Gateway(config([provider({ maxRetries: 3 })]), {
      adapter: fakeAdapter(() => {
        calls += 1;
        return Promise.reject(
          new ResponseRedactionError(
            "gateway response payload exceeds the maximum redaction depth",
          ),
        );
      }),
      clock: createScriptedGatewayClock(),
    });
    await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(ResponseRedactionError);
    // Not retryable, so exactly one adapter call regardless of the configured maxRetries.
    expect(calls).toBe(1);
    expect(gateway.circuitStatus("example-chat-model").consecutiveFailures).toBe(0);
    expect(gateway.circuitStatus("example-chat-model").state).toBe("closed");
  });

  // Run 23 (2026-09-11): the provider's `timeoutMs` bounded the WHOLE call, so an attempt that
  // hung to its timeout left no budget, and the retry ADR-0003 promises a `TimeoutError` could
  // never start. Each attempt now runs under its own `timeoutMs`, inside the derived budget.
  it("retries an attempt that hung to its timeout with a fresh per-attempt timeout", async () => {
    const seenTimeouts: number[] = [];
    // Bespoke on purpose: the adapter mock below advances `current` directly (simulating the
    // provider call's own latency), which createScriptedGatewayClock has no external handle to do
    // — its internal clock only advances through its own sleep().
    let current = 0;
    const clock: Clock = {
      now: (): number => current,
      sleep: (ms): Promise<void> => {
        current += ms;
        return Promise.resolve();
      },
    };
    let calls = 0;
    const providerConfig = provider({ timeoutMs: 1000, retryBaseDelayMs: 100 });
    const gateway = new Gateway(config([providerConfig]), {
      adapter: fakeAdapter((_request, cfg) => {
        calls += 1;
        seenTimeouts.push(cfg.timeoutMs);
        if (calls === 1) {
          current += cfg.timeoutMs; // the provider never answered; the attempt's timeout fired
          return Promise.reject(new TimeoutError("provider did not answer"));
        }
        return Promise.resolve(okResponse("example-chat-model"));
      }),
      clock,
      random: (): number => 1,
    });
    await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });
    // The configured 1000ms is well below the silence floor (#3591), so both attempts run under
    // the SAME floored timeout — still a fresh one on retry, not a shrunk one.
    const effectiveAttemptTimeoutMs = providerRetryConfig(providerConfig).attemptTimeoutMs;
    expect(seenTimeouts).toEqual([effectiveAttemptTimeoutMs, effectiveAttemptTimeoutMs]);
  });

  // The invariant this pin has always guarded, restated on the budget the gateway now derives
  // (`providerRequestBudgetMs`) instead of the per-attempt `timeoutMs` it used to reuse: a retry
  // attempt runs under the REMAINING end-to-end budget, never a fresh one that outlives it. The
  // budget holds a full attempt and the longest cool-down for every retry, so only an attempt that
  // overran its own timeout leaves less than that; the retry after it is clipped to what is left.
  it("passes the remaining end-to-end timeout budget to retry attempts", async () => {
    const seenTimeouts: number[] = [];
    let current = 0;
    const clock: Clock = {
      now: (): number => current,
      sleep: (ms): Promise<void> => {
        current += ms;
        return Promise.resolve();
      },
    };
    let calls = 0;
    // #3591 / PR #3602 review: timeoutMs stays above the buffered-answer floor so it is not itself
    // floored. The overrun is derived from the budget itself — enough to leave LESS of the budget
    // than a fresh attempt timeout — rather than a hand-picked literal: a hardcoded overrun already
    // stopped proving this once before, when the floor it needed to clear rose out from under it
    // (previously the silence floor, now the larger buffered floor). Deriving it keeps the test
    // correct across any future floor change.
    const route = provider({ timeoutMs: 650_000, maxRetries: 1, retryBaseDelayMs: 100 });
    // providerRetryConfig always sets attemptTimeoutMs; the interface merely allows a caller-built
    // RetryConfig to omit it.
    const attemptTimeoutMs = providerRetryConfig(route).attemptTimeoutMs ?? 0;
    const budgetMs = providerRequestBudgetMs(route);
    const overrunMs = budgetMs - attemptTimeoutMs + 50_000;
    const gateway = new Gateway(config([route]), {
      adapter: fakeAdapter((_request, cfg) => {
        calls += 1;
        seenTimeouts.push(cfg.timeoutMs);
        current += calls === 1 ? overrunMs : 0; // an adapter that overran its own timeout
        return calls === 1
          ? Promise.reject(new RateLimitError("slow down", 100))
          : Promise.resolve(okResponse("example-chat-model"));
      }),
      clock,
      random: (): number => 1,
    });
    await gateway.chat(REQUEST);
    // `overrunMs` in the first attempt and the 100 ms Retry-After leave the rest of the budget.
    expect(seenTimeouts).toEqual([attemptTimeoutMs, budgetMs - overrunMs - 100]);
  });

  it("opens the circuit after repeated failures and then blocks without calling the adapter", async () => {
    let calls = 0;
    const gateway = new Gateway(config([provider({ maxRetries: 0 })]), {
      adapter: fakeAdapter(() => {
        calls += 1;
        return Promise.reject(new TransportError("down"));
      }),
      clock: createScriptedGatewayClock(),
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(TransportError);
    }
    const callsBeforeOpen = calls;
    await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(callsBeforeOpen);
  });
});

async function collectStream(
  iterable: AsyncIterable<GatewayStreamChunk>,
): Promise<GatewayStreamChunk[]> {
  const out: GatewayStreamChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function streamingAdapter(tokens: readonly string[]): ProviderAdapter {
  return {
    call: () => Promise.resolve(okResponse("example-chat-model")),
    callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      for (const token of tokens) yield { type: "delta", token };
      yield {
        type: "done",
        response: {
          ...okResponse("example-chat-model"),
          content: tokens.join(""),
          usage: {
            requestId: "adapter-local",
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: 0,
            costClass: "low",
          },
        },
      };
    },
  };
}

describe("Gateway.chatStream", () => {
  it("uses the Workbench latency floor only for marked streaming calls", async () => {
    const timeouts: number[] = [];
    const adapter: ProviderAdapter = {
      call: (_request, cfg) => Promise.resolve(okResponse(cfg.modelId)),
      callStream: async function* (_request, cfg): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        timeouts.push(cfg.timeoutMs);
        yield { type: "done", response: okResponse(cfg.modelId) };
      },
    };
    const gateway = new Gateway(config([provider({ maxRetries: 0 })]), { adapter });
    await collectStream(gateway.chatStream(REQUEST));
    await collectStream(gateway.chatStream({ ...REQUEST, latencyProfile: "coding-workbench" }));
    expect(timeouts).toStrictEqual([30_000, GATEWAY_SILENCE_FLOOR_MS]);
  });

  // RED reasoning (review finding on PR #3602): chatStream()'s buffered fallback for a
  // non-streaming adapter used to call adapter.call() with the route's raw `provider.timeoutMs`
  // unbounded by any floor, while the started line already claimed the (unrelated, unapplied)
  // silence floor. A healthy 45 s answer through a 30 s-configured provider was aborted at 30 s.
  // The fallback must apply the SAME buffered-answer floor a whole-body Gateway.chat() attempt
  // gets, because it degrades to the identical whole-body, unobservable read.
  it("floors the buffered fallback's adapter.call() deadline to the buffered-answer floor", async () => {
    const timeouts: number[] = [];
    const adapter: ProviderAdapter = {
      // No callStream: forces chatStream() to degrade to its buffered fallback.
      call: (_request, cfg) => {
        timeouts.push(cfg.timeoutMs);
        return Promise.resolve(okResponse(cfg.modelId));
      },
    };
    const gateway = new Gateway(config([provider({ timeoutMs: 30_000, maxRetries: 0 })]), {
      adapter,
    });
    await collectStream(gateway.chatStream(REQUEST));
    expect(timeouts).toStrictEqual([GATEWAY_BUFFERED_BUDGET_FLOOR_MS]);
  });

  it("yields ordered deltas then a done chunk enriched with a UUID requestId and costClass", async () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: streamingAdapter(["Hel", "lo"]),
      clock: createScriptedGatewayClock(),
    });
    const chunks = await collectStream(gateway.chatStream(REQUEST));
    expect(chunks.slice(0, 2)).toEqual([
      { type: "delta", token: "Hel" },
      { type: "delta", token: "lo" },
    ]);
    const done = chunks[2];
    if (done?.type !== "done") throw new Error("expected a done chunk");
    expect(done.response.content).toBe("Hello");
    expect(done.response.usage.requestId).toMatch(UUID_V4);
    expect(done.response.usage.requestId).not.toBe("adapter-local");
    expect(done.response.usage.costClass).toBe("medium");
    expect(done.response.usage.latencyMs).toBeGreaterThanOrEqual(1);
  });

  it("falls back to a single delta+done synthesised from call() when callStream is absent", async () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() =>
        Promise.resolve({ ...okResponse("example-chat-model"), content: "buffered" }),
      ),
      clock: createScriptedGatewayClock(),
    });
    const chunks = await collectStream(gateway.chatStream(REQUEST));
    expect(chunks[0]).toEqual({ type: "delta", token: "buffered" });
    const done = chunks[1];
    if (done?.type !== "done") throw new Error("expected a done chunk");
    expect(done.response.content).toBe("buffered");
    expect(done.response.usage.requestId).toMatch(UUID_V4);
    expect(chunks).toHaveLength(2);
  });

  it("records a circuit failure and rethrows when the stream throws", async () => {
    const failing: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        yield { type: "delta", token: "x" };
        throw new TransportError("mid-stream");
      },
    };
    const gateway = new Gateway(config([provider({ maxRetries: 0 })]), {
      adapter: failing,
      clock: createScriptedGatewayClock(),
    });
    await expect(collectStream(gateway.chatStream(REQUEST))).rejects.toBeInstanceOf(TransportError);
    expect(gateway.circuitStatus("example-chat-model").consecutiveFailures).toBe(1);
  });

  it("does not count a CancelledError as a breaker fault — consecutiveFailures stays 0 and state stays closed", async () => {
    // RED reasoning: before the fix both catch blocks called recordFailure() unconditionally,
    // so a cancel mid-stream incremented consecutiveFailures and could eventually trip the breaker.
    const cancelling: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        yield { type: "delta", token: "x" };
        throw new CancelledError("client cancelled");
      },
    };
    const gateway = new Gateway(config([provider({ maxRetries: 0 })]), {
      adapter: cancelling,
      clock: createScriptedGatewayClock(),
    });
    await expect(collectStream(gateway.chatStream(REQUEST))).rejects.toBeInstanceOf(CancelledError);
    expect(gateway.circuitStatus("example-chat-model").consecutiveFailures).toBe(0);
    expect(gateway.circuitStatus("example-chat-model").state).toBe("closed");
  });

  // #3591: a gateway that has not yet answered within its (generous) silence/budget floor is
  // slow, not broken — five consecutive timeouts across five SEPARATE calls must never open the
  // breaker and lock out every other caller of that model. Contrasted below with five genuine
  // provider 5xx failures, which still open it exactly as before.
  // Flipped by review finding on PR #3602: excluding every TimeoutError from NON_PROVIDER_FAULTS
  // disabled the breaker's own outage guard — an upstream that never responds would cost every
  // caller a full (multi-minute, with the #3591 floors) attempt and the breaker would never open
  // for it. With the new floors this generous, a TimeoutError means minutes of genuine silence, an
  // outage-class signal — so it counts as a provider failure again, exactly as it did before this
  // PR (and exactly like a provider 5xx failure).
  it("opens the breaker after five consecutive TimeoutErrors, just like five provider 5xx failures", async () => {
    const breakerConfig = { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 } as const;
    const timeoutGateway = new Gateway(
      { providers: [provider({ maxRetries: 0 })], circuitBreaker: breakerConfig },
      {
        adapter: fakeAdapter(() => Promise.reject(new TimeoutError("provider did not answer"))),
        clock: createScriptedGatewayClock(),
      },
    );
    for (let i = 0; i < 5; i += 1) {
      await expect(timeoutGateway.chat(REQUEST)).rejects.toBeInstanceOf(TimeoutError);
    }
    expect(timeoutGateway.circuitStatus("example-chat-model").consecutiveFailures).toBe(5);
    expect(timeoutGateway.circuitStatus("example-chat-model").state).toBe("open");

    const failingGateway = new Gateway(
      { providers: [provider({ maxRetries: 0 })], circuitBreaker: breakerConfig },
      {
        adapter: fakeAdapter(() => Promise.reject(new ProviderError("upstream failure", 503))),
        clock: createScriptedGatewayClock(),
      },
    );
    for (let i = 0; i < 5; i += 1) {
      await expect(failingGateway.chat(REQUEST)).rejects.toBeInstanceOf(ProviderError);
    }
    expect(failingGateway.circuitStatus("example-chat-model").state).toBe("open");
  });

  // #3591: an HTTP 200 answer that spent its whole output budget on reasoning (finish_reason
  // "length", no content) is a caller-fixable budget problem, not evidence the provider is
  // failing — it must not count toward opening the breaker either.
  // #3610: an HTTP 200 answer with neither content nor a tool call is the same kind of fault — the
  // provider answered — so it must not count toward opening the breaker either.
  it.each([
    ["ProviderOutputExhaustedError", ProviderOutputExhaustedError],
    ["ProviderEmptyAnswerError", ProviderEmptyAnswerError],
  ] as const)(
    "does not count a %s as a breaker fault — consecutiveFailures stays 0 and state stays closed",
    async (_label, faultClass) => {
      let calls = 0;
      const gateway = new Gateway(config([provider({ maxRetries: 3 })]), {
        adapter: fakeAdapter(() => {
          calls += 1;
          return Promise.reject(new faultClass("example-chat-model"));
        }),
        clock: createScriptedGatewayClock(),
      });
      await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(faultClass);
      // Not retryable, so exactly one adapter call regardless of the configured maxRetries.
      expect(calls).toBe(1);
      expect(gateway.circuitStatus("example-chat-model").consecutiveFailures).toBe(0);
      expect(gateway.circuitStatus("example-chat-model").state).toBe("closed");
    },
  );

  // RED reasoning (review finding on PR #3602): before the fix, a half-open probe that ended in a
  // non-provider fault hit neither CircuitBreaker.recordSuccess nor recordFailure, so the probe
  // slot it claimed was never released. With halfOpenProbes: 1, that stuck the breaker half-open
  // forever — every later call rejected with CircuitOpenError although the provider itself was
  // never actually tested (the request was cancelled / hit its own output-budget problem, not a
  // provider failure).
  it.each([
    ["CancelledError", (): CancelledError => new CancelledError("client cancelled the request")],
    [
      "ProviderOutputExhaustedError",
      (): ProviderOutputExhaustedError => new ProviderOutputExhaustedError("example-chat-model"),
    ],
    [
      "ProviderEmptyAnswerError",
      (): ProviderEmptyAnswerError => new ProviderEmptyAnswerError("example-chat-model"),
    ],
    [
      "MalformedToolCallError",
      (): MalformedToolCallError => new MalformedToolCallError("tool call has non-JSON arguments"),
    ],
  ])(
    "keeps admitting calls after a half-open probe ends in a %s",
    async (_label, buildProbeFault) => {
      let current = 0;
      const clock: Clock = {
        now: (): number => current,
        sleep: (ms): Promise<void> => {
          current += ms;
          return Promise.resolve();
        },
      };
      const breakerConfig = { failureThreshold: 1, cooldownMs: 1_000, halfOpenProbes: 1 } as const;
      let phase: "opening" | "probe" | "recovered" = "opening";
      const gateway = new Gateway(
        { providers: [provider({ maxRetries: 0 })], circuitBreaker: breakerConfig },
        {
          adapter: fakeAdapter(() => {
            if (phase === "opening") return Promise.reject(new TransportError("down"));
            if (phase === "probe") return Promise.reject(buildProbeFault());
            return Promise.resolve(okResponse("example-chat-model"));
          }),
          clock,
        },
      );
      // One provider failure opens the breaker (failureThreshold: 1).
      await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(TransportError);
      expect(gateway.circuitStatus("example-chat-model").state).toBe("open");

      // Cooldown elapses; the next call is admitted as the single half-open probe and ends in the
      // non-provider fault under test.
      current += breakerConfig.cooldownMs;
      phase = "probe";
      await expect(gateway.chat(REQUEST)).rejects.toThrow(buildProbeFault().message);
      expect(gateway.circuitStatus("example-chat-model").state).toBe("half-open");

      // The freed slot admits the next call — a stuck breaker would reject this with
      // CircuitOpenError instead of reaching the adapter.
      phase = "recovered";
      await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });
    },
  );

  // A lab run of the 1.1.8 candidate behind a LiteLLM hosted_vllm route: the model's changeset tool
  // calls did not match the tool schema five times in a row, the breaker opened, and every later
  // call of the healthy model failed on CircuitOpenError until the run itself failed. A malformed
  // tool call is the model's answer: it may be retried, but it never counts as a provider fault.
  it.each([
    [
      "an unparseable tool call",
      (): Error => new MalformedToolCallError("tool call has non-JSON arguments"),
    ],
    [
      "a retryable schema rejection",
      (): Error => new GatewayToolCatalogError("invalid-arguments", undefined, true),
    ],
  ])("does not count %s as a breaker fault, however often it recurs", async (_label, fault) => {
    const breakerConfig = { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 } as const;
    let calls = 0;
    const gateway = new Gateway(
      { providers: [provider({ maxRetries: 2 })], circuitBreaker: breakerConfig },
      {
        adapter: fakeAdapter(() => {
          calls += 1;
          return Promise.reject(fault());
        }),
        clock: createScriptedGatewayClock(),
      },
    );
    for (let i = 0; i < 6; i += 1) {
      await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(MalformedToolCallError);
    }
    expect(calls).toBeGreaterThanOrEqual(6);
    expect(gateway.circuitStatus("example-chat-model").consecutiveFailures).toBe(0);
    expect(gateway.circuitStatus("example-chat-model").state).toBe("closed");
  });

  it("throws UnknownModelError for an unconfigured model without touching the breaker", async () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: streamingAdapter(["x"]),
      clock: createScriptedGatewayClock(),
    });
    await expect(
      collectStream(gateway.chatStream({ modelId: "nope", messages: [] })),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });
});

describe("Gateway.circuitStatus", () => {
  it("reports closed before any failures", () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse("x"))),
      clock: createScriptedGatewayClock(),
    });
    expect(gateway.circuitStatus("example-chat-model").state).toBe("closed");
  });

  it("reports closed for an unconfigured model id", () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse("x"))),
      clock: createScriptedGatewayClock(),
    });
    expect(gateway.circuitStatus("nope").state).toBe("closed");
  });
});

// Regression pin (audit KEIKO-0167): the per-provider circuitBreaker override, when present on a
// ModelProviderConfig, is what breakerFor uses to construct that provider's CircuitBreaker — not
// the top-level GatewayConfig.circuitBreaker. Providers WITHOUT an override continue to use the
// shared top-level policy. This drives the observable behaviour by running the same "N failures
// then open" scenario against two providers in one Gateway: one with failureThreshold=1 (opens
// after the very first fault) and one with the top-level failureThreshold=3.
describe("Gateway per-provider circuitBreaker override (KEIKO-0167)", () => {
  const flakyProvider = provider({
    modelId: "flaky-provider",
    maxRetries: 0,
    circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000, halfOpenProbes: 1 },
  });
  const strictProvider = provider({
    modelId: "strict-provider",
    maxRetries: 0,
    // No per-provider circuitBreaker => falls through to config.circuitBreaker (failureThreshold=3).
  });

  it("opens the flaky provider after ONE failure while the strict provider stays closed", async () => {
    const gateway = new Gateway(config([flakyProvider, strictProvider]), {
      adapter: fakeAdapter(() => Promise.reject(new TransportError("down"))),
      clock: createScriptedGatewayClock(),
    });

    await expect(gateway.chat({ ...REQUEST, modelId: "flaky-provider" })).rejects.toBeInstanceOf(
      TransportError,
    );
    // Override says failureThreshold=1, so the flaky breaker is now OPEN after that single fault.
    await expect(gateway.chat({ ...REQUEST, modelId: "flaky-provider" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );

    // The sibling without an override still uses the top-level failureThreshold=3, so ONE fault
    // leaves it closed.
    await expect(gateway.chat({ ...REQUEST, modelId: "strict-provider" })).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(gateway.circuitStatus("strict-provider").state).toBe("closed");
  });
});
