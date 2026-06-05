import { describe, expect, it } from "vitest";
import { Gateway } from "./gateway.js";
import {
  CircuitOpenError,
  TransportError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  Clock,
  GatewayConfig,
  GatewayRequest,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://provider.example/v1",
    apiKey: "sk-config-secret-key-1234567890ab",
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

function stubClock(): Clock {
  let current = 0;
  return {
    now: (): number => (current += 1),
    sleep: (): Promise<void> => Promise.resolve(),
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
  it("returns a response with a UUID v4 request id and exact deterministic latency", async () => {
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
      clock: stubClock(),
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
        clock: stubClock(),
      },
    );
    const result = await gateway.chat({ modelId, messages: [{ role: "user", content: "q" }] });
    expect(result.modelId).toBe(modelId);
    expect(result.usage.costClass).toBe("medium");
  });

  it("throws UnknownModelError when the model is not configured", async () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse("x"))),
      clock: stubClock(),
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
        clock: stubClock(),
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
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() =>
        Promise.reject(new TransportError("upstream sk-config-secret-key-1234567890ab failed")),
      ),
      clock: stubClock(),
    });
    try {
      await gateway.chat(REQUEST);
      expect.unreachable("should throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-config-secret-key-1234567890ab");
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
      clock: stubClock(),
    });
    const result = await gateway.chat(REQUEST);
    expect(result.content).toBe("answer");
    expect(calls).toBe(2);
  });

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
    const gateway = new Gateway(config([provider({ timeoutMs: 1000, retryBaseDelayMs: 100 })]), {
      adapter: fakeAdapter((_request, cfg) => {
        calls += 1;
        seenTimeouts.push(cfg.timeoutMs);
        current += calls === 1 ? 700 : 0;
        return calls === 1
          ? Promise.reject(new TransportError("transient"))
          : Promise.resolve(okResponse("example-chat-model"));
      }),
      clock,
    });
    await gateway.chat(REQUEST);
    expect(seenTimeouts).toEqual([1000, 200]);
  });

  it("opens the circuit after repeated failures and then blocks without calling the adapter", async () => {
    let calls = 0;
    const gateway = new Gateway(config([provider({ maxRetries: 0 })]), {
      adapter: fakeAdapter(() => {
        calls += 1;
        return Promise.reject(new TransportError("down"));
      }),
      clock: stubClock(),
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(TransportError);
    }
    const callsBeforeOpen = calls;
    await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(callsBeforeOpen);
  });
});

describe("Gateway.circuitStatus", () => {
  it("reports closed before any failures", () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse("x"))),
      clock: stubClock(),
    });
    expect(gateway.circuitStatus("example-chat-model").state).toBe("closed");
  });

  it("reports closed for an unconfigured model id", () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse("x"))),
      clock: stubClock(),
    });
    expect(gateway.circuitStatus("nope").state).toBe("closed");
  });
});
