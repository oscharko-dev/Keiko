import { describe, expect, it } from "vitest";
import { Gateway } from "./gateway.js";
import { createDefaultProviderRegistry, StaticProviderRegistry } from "./provider-registry.js";
import {
  CircuitOpenError,
  ConfigInvalidError,
  TransportError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  Clock,
  GatewayConfig,
  GatewayOpenAiCompatibleProviderConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
  ProviderAdapterFactoryContext,
  ProviderRegistry,
} from "./types.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function provider(
  overrides: Partial<GatewayOpenAiCompatibleProviderConfig> = {},
): GatewayOpenAiCompatibleProviderConfig {
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

function registryFor(adapter: ProviderAdapter): ProviderRegistry {
  return new StaticProviderRegistry({
    adapters: new Map([
      ["gateway-openai-compatible", () => adapter],
      ["openai-codex-local-session", () => adapter],
    ]),
  });
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
      providerRegistry: registryFor(
        fakeAdapter(() => Promise.resolve(okResponse("example-chat-model"))),
      ),
      clock: deterministicClock,
    });
    const result = await gateway.chat(REQUEST);
    expect(result.usage.requestId).toMatch(UUID_V4);
    expect(result.usage.latencyMs).toBe(42);
  });

  it("stamps usage.costClass from the runtime default for an undeclared model", async () => {
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registryFor(
        fakeAdapter((_req, cfg) => Promise.resolve(okResponse(cfg.modelId))),
      ),
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
        providerRegistry: registryFor(
          fakeAdapter((_req, cfg) => Promise.resolve(okResponse(cfg.modelId))),
        ),
        clock: stubClock(),
      },
    );
    const result = await gateway.chat({ modelId, messages: [{ role: "user", content: "q" }] });
    expect(result.modelId).toBe(modelId);
    expect(result.usage.costClass).toBe("medium");
  });

  it("throws UnknownModelError when the model is not configured", async () => {
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registryFor(fakeAdapter(() => Promise.resolve(okResponse("x")))),
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
        providerRegistry: registryFor(fakeAdapter(() => Promise.resolve(okResponse("x")))),
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
    const upstreamKey = ["sk-", "config-secret-key-1234567890ab"].join("");
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registryFor(
        fakeAdapter(() => Promise.reject(new TransportError(`upstream ${upstreamKey} failed`))),
      ),
      clock: stubClock(),
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
      providerRegistry: registryFor(
        fakeAdapter(() => {
          calls += 1;
          return calls < 2
            ? Promise.reject(new TransportError("boom"))
            : Promise.resolve(okResponse("example-chat-model"));
        }),
      ),
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
      providerRegistry: registryFor(
        fakeAdapter((_request, cfg) => {
          calls += 1;
          seenTimeouts.push(cfg.timeoutMs);
          current += calls === 1 ? 700 : 0;
          return calls === 1
            ? Promise.reject(new TransportError("transient"))
            : Promise.resolve(okResponse("example-chat-model"));
        }),
      ),
      clock,
    });
    await gateway.chat(REQUEST);
    expect(seenTimeouts).toEqual([1000, 200]);
  });

  it("opens the circuit after repeated failures and then blocks without calling the adapter", async () => {
    let calls = 0;
    const gateway = new Gateway(config([provider({ maxRetries: 0 })]), {
      providerRegistry: registryFor(
        fakeAdapter(() => {
          calls += 1;
          return Promise.reject(new TransportError("down"));
        }),
      ),
      clock: stubClock(),
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(TransportError);
    }
    const callsBeforeOpen = calls;
    await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(callsBeforeOpen);
  });

  it("uses the provider registry as the only productive dispatch path", async () => {
    let resolves = 0;
    const registry: ProviderRegistry = {
      resolve: () => {
        resolves += 1;
        return fakeAdapter((_req, cfg) => Promise.resolve(okResponse(cfg.modelId)));
      },
    };
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registry,
      clock: stubClock(),
    });
    const result = await gateway.chat(REQUEST);
    expect(result.modelId).toBe("example-chat-model");
    expect(resolves).toBe(1);
  });

  it("passes request metadata and injected fetch through the provider registry context", async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("should not be called"));
    let seenContext: ProviderAdapterFactoryContext | undefined;
    const registry: ProviderRegistry = {
      resolve: (_config, context) => {
        seenContext = context;
        return fakeAdapter((_req, cfg) => Promise.resolve(okResponse(cfg.modelId)));
      },
    };
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registry,
      fetchImpl,
      clock: stubClock(),
    });
    await gateway.chat(REQUEST);
    expect(seenContext?.requestId).toMatch(UUID_V4);
    expect(seenContext?.costClass).toBe("medium");
    expect(typeof seenContext?.now).toBe("function");
    expect(seenContext?.fetchImpl).toBe(fetchImpl);
  });

  it("routes a configured local-session provider through the default provider registry", async () => {
    const gateway = new Gateway(
      config([
        {
          providerType: "openai-codex-local-session",
          modelId: "gpt-5-codex",
          credentialResolver: { kind: "codex-cli" },
          timeoutMs: 30_000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ]),
      {
        providerRegistry: createDefaultProviderRegistry({
          codexCliCommandRunner: async (input) => {
            if (input.command === "version") {
              return {
                stdout: "codex-cli 0.138.0-alpha.7",
                stderr: "",
                exitCode: 0,
                terminatedBySignal: null,
              };
            }
            if (input.command === "doctor-json") {
              return {
                stdout: JSON.stringify({
                  overallStatus: "ok",
                  checks: {
                    "auth.credentials": { status: "ok" },
                    "network.websocket_reachability": { status: "ok" },
                  },
                }),
                stderr: "",
                exitCode: 0,
                terminatedBySignal: null,
              };
            }
            if (input.command === "exec-json") {
              return {
                stdout: [
                  JSON.stringify({ type: "turn.started" }),
                  JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_1", type: "agent_message", text: "local answer" },
                  }),
                  JSON.stringify({
                    type: "turn.completed",
                    usage: { input_tokens: 8, output_tokens: 3 },
                  }),
                ].join("\n"),
                stderr: "",
                exitCode: 0,
                terminatedBySignal: null,
              };
            }
            throw new Error(`unexpected command ${input.command}`);
          },
        }),
        clock: stubClock(),
      },
    );
    const result = await gateway.chat({ modelId: "gpt-5-codex", messages: REQUEST.messages });
    expect(result.modelId).toBe("gpt-5-codex");
    expect(result.content).toBe("local answer");
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
  it("yields ordered deltas then a done chunk enriched with a UUID requestId and costClass", async () => {
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registryFor(streamingAdapter(["Hel", "lo"])),
      clock: stubClock(),
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
      providerRegistry: registryFor(
        fakeAdapter(() => Promise.resolve({ ...okResponse("example-chat-model"), content: "buffered" })),
      ),
      clock: stubClock(),
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
      providerRegistry: registryFor(failing),
      clock: stubClock(),
    });
    await expect(collectStream(gateway.chatStream(REQUEST))).rejects.toBeInstanceOf(TransportError);
    expect(gateway.circuitStatus("example-chat-model").consecutiveFailures).toBe(1);
  });

  it("throws UnknownModelError for an unconfigured model without touching the breaker", async () => {
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registryFor(streamingAdapter(["x"])),
      clock: stubClock(),
    });
    await expect(
      collectStream(gateway.chatStream({ modelId: "nope", messages: [] })),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });
});

describe("Gateway.circuitStatus", () => {
  it("reports closed before any failures", () => {
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registryFor(fakeAdapter(() => Promise.resolve(okResponse("x")))),
      clock: stubClock(),
    });
    expect(gateway.circuitStatus("example-chat-model").state).toBe("closed");
  });

  it("reports closed for an unconfigured model id", () => {
    const gateway = new Gateway(config([provider()]), {
      providerRegistry: registryFor(fakeAdapter(() => Promise.resolve(okResponse("x")))),
      clock: stubClock(),
    });
    expect(gateway.circuitStatus("nope").state).toBe("closed");
  });
});
