// Activity-log coverage for the Gateway orchestrator: fail-closed routing refusals, buffered and
// streaming call outcomes, and the silent buffered-fallback degradation of a non-streaming
// adapter. Every case injects an adapter and a Clock — no network, no timers, no global state.

import { describe, expect, it } from "vitest";
import { TransportError } from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway } from "./gateway.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import type {
  Clock,
  GatewayConfig,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";

interface Recorder {
  readonly sink: ModelGatewayLogSink;
  readonly events: ModelGatewayLogEvent[];
}

function recorder(): Recorder {
  const events: ModelGatewayLogEvent[] = [];
  return {
    events,
    sink: {
      write(event: ModelGatewayLogEvent): void {
        events.push(event);
      },
    },
  };
}

function ops(events: readonly ModelGatewayLogEvent[]): readonly string[] {
  return events.map((event) => event.op);
}

function eventFor(events: readonly ModelGatewayLogEvent[], op: string): ModelGatewayLogEvent {
  const found = events.find((event) => event.op === op);
  if (found === undefined) {
    throw new Error(`expected an event with op '${op}', saw: ${ops(events).join(", ")}`);
  }
  return found;
}

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://provider.example/v1",
    apiKey: ["sk-", "config-secret-key-1234567890ab"].join(""),
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function config(providers: readonly ModelProviderConfig[]): GatewayConfig {
  return {
    providers: [...providers],
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

const REQUEST = {
  modelId: "example-chat-model",
  messages: [{ role: "user" as const, content: "hello" }],
};

function gatewayWith(adapter: ProviderAdapter, log: Recorder): Gateway {
  const gateway = new Gateway(config([provider()]), { adapter, clock: stubClock(), log: log.sink });
  // Construction itself now writes one `gateway.config.resolved` line (its own dedicated describe
  // block below asserts that line directly, on an ungated `new Gateway(...)`). Every other test in
  // this file wires a recorder through this helper to observe what a CALL does, so the
  // construction-time line is cleared here rather than left for each call-scoped assertion to
  // filter out.
  log.events.length = 0;
  return gateway;
}

async function drainStream(stream: AsyncGenerator<GatewayStreamChunk>): Promise<number> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks.length;
}

// The ONE-TIME configuration snapshot, written by the constructor itself — before any call has
// happened, and never repeated for a Gateway instance that goes on to serve many calls.
describe("Gateway construction — activity log", () => {
  it("logs a config-resolved line naming every provider's safe fields, once", () => {
    const log = recorder();
    const providers = [
      provider({
        modelId: "chat-a",
        baseUrl: "https://provider-a.example/v1",
        timeoutMs: 5000,
        maxRetries: 2,
        retryBaseDelayMs: 250,
      }),
      provider({
        modelId: "chat-b",
        baseUrl: "https://provider-b.example:8443/deploy/v2",
        timeoutMs: 9000,
        maxRetries: 0,
        retryBaseDelayMs: 100,
      }),
    ];
    new Gateway(config(providers), { clock: stubClock(), log: log.sink });
    expect(ops(log.events)).toEqual(["gateway.config.resolved"]);
    const resolved = eventFor(log.events, "gateway.config.resolved");
    expect(resolved.level).toBe("info");
    expect(resolved.category).toBe("gateway");
    expect(resolved.extra?.providers).toEqual([
      {
        modelId: "chat-a",
        endpointHost: "provider-a.example",
        timeoutMs: 5000,
        maxRetries: 2,
        retryBaseDelayMs: 250,
      },
      {
        modelId: "chat-b",
        endpointHost: "provider-b.example",
        timeoutMs: 9000,
        maxRetries: 0,
        retryBaseDelayMs: 100,
      },
    ]);
  });

  // AUDIT-SEC-002-adjacent: a misconfigured provider entry can carry a bare token as URL userinfo
  // or a deployment id in the path. `endpointHost` must survive that — reducing to the bare
  // hostname, never the baseUrl the operator actually typed.
  it("never lets a provider's baseUrl, embedded credentials, or path reach the config-resolved line", () => {
    const log = recorder();
    const leaky = provider({
      modelId: "chat-leaky",
      baseUrl: "https://sk-embedded-secret-9876543210@leaky.example/deploy/v1/secret-path",
    });
    new Gateway(config([leaky]), { clock: stubClock(), log: log.sink });
    const resolved = eventFor(log.events, "gateway.config.resolved");
    expect(resolved.extra?.providers).toMatchObject([
      { modelId: "chat-leaky", endpointHost: "leaky.example" },
    ]);
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain("sk-embedded-secret-9876543210");
    expect(serialized).not.toContain("secret-path");
    expect(serialized).not.toContain(leaky.baseUrl);
  });

  it("never reads or logs a provider's apiKey", () => {
    const log = recorder();
    new Gateway(config([provider({ apiKey: "sk-do-not-log-me-1234567890ab" })]), {
      clock: stubClock(),
      log: log.sink,
    });
    const resolved = eventFor(log.events, "gateway.config.resolved");
    expect(JSON.stringify(resolved)).not.toContain("sk-do-not-log-me-1234567890ab");
  });
});

describe("Gateway routing — activity log", () => {
  it("names the reason for each of the three fail-closed routing refusals", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = { call: () => Promise.resolve(okResponse("m")) };
    const gateway = new Gateway(config([provider()]), {
      adapter,
      clock: stubClock(),
      log: log.sink,
    });
    await expect(gateway.chat({ ...REQUEST, modelId: "not-configured" })).rejects.toThrow();
    const rejected = eventFor(log.events, "gateway.route.rejected");
    expect(rejected.level).toBe("warn");
    expect(rejected.category).toBe("gateway");
    expect(rejected.extra).toMatchObject({
      modelId: "not-configured",
      reason: "no-provider-configured",
    });
  });

  it("distinguishes a wrong-kind model from an unknown one", async () => {
    const log = recorder();
    // A CONFIGURED provider whose id resolves to an embedding capability: routing must refuse it
    // on the chat path, and the line must say it was the kind — not a missing configuration.
    const gateway = new Gateway(config([provider({ modelId: "text-embedding-3-small" })]), {
      adapter: { call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("m")) },
      clock: stubClock(),
      log: log.sink,
    });
    await expect(gateway.chat({ ...REQUEST, modelId: "text-embedding-3-small" })).rejects.toThrow();
    expect(eventFor(log.events, "gateway.route.rejected").extra).toMatchObject({
      modelId: "text-embedding-3-small",
      reason: "wrong-model-kind",
      kind: "embedding",
    });
  });
});

describe("Gateway.chat — activity log", () => {
  // THE ATTEMPT LINE. A provider that accepts the request and then goes quiet produces neither a
  // completion nor a failure, so without a line written BEFORE the adapter is invoked the gateway
  // is silent for exactly the window an operator is trying to diagnose. `timeoutMs`/`maxRetries`
  // ride along because together they bound how long that silence can legitimately last.
  it("writes an attempt line before invoking the adapter, with the deadline it runs under", async () => {
    const log = recorder();
    let opsAtCall: readonly string[] = ["<adapter never invoked>"];
    const gateway = gatewayWith(
      {
        call: (): Promise<NormalizedResponse> => {
          opsAtCall = ops(log.events);
          return Promise.resolve(okResponse("example-chat-model"));
        },
      },
      log,
    );
    const response = await gateway.chat({ ...REQUEST, reasoningEffort: "high" });
    expect(opsAtCall).toEqual(["gateway.chat.started"]);
    const started = eventFor(log.events, "gateway.chat.started");
    expect(started.level).toBe("info");
    expect(started.correlationId).toBe(response.usage.requestId);
    expect(started.extra).toMatchObject({
      modelId: "example-chat-model",
      endpoint: "https://provider.example",
      timeoutMs: 30_000,
      maxRetries: 0,
      reasoningEffort: "high",
      streaming: false,
    });
  });

  // The failure the whole effort exists for: the attempt is on record even though no outcome
  // ever arrives. Hermetic — the wedged call is released before the case ends.
  it("leaves the attempt line readable while a call that never returns is in flight", async () => {
    const log = recorder();
    let entered: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let answer: (response: NormalizedResponse) => void = () => undefined;
    const gateway = gatewayWith(
      {
        call: (): Promise<NormalizedResponse> =>
          new Promise<NormalizedResponse>((resolve) => {
            answer = resolve;
            entered();
          }),
      },
      log,
    );
    const pending = gateway.chat(REQUEST);
    await inFlight;
    expect(ops(log.events)).toEqual(["gateway.chat.started"]);
    answer(okResponse("example-chat-model"));
    await expect(pending).resolves.toMatchObject({ content: "answer" });
  });

  it("writes an attempt line for the streaming path too, labelled as streaming", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "done", response: await Promise.resolve(okResponse("example-chat-model")) };
      },
    };
    await drainStream(
      gatewayWith(adapter, log).chatStream({ ...REQUEST, reasoningEffort: "medium" }),
    );
    const started = eventFor(log.events, "gateway.stream.started");
    expect(started.level).toBe("info");
    expect(started.extra).toMatchObject({
      modelId: "example-chat-model",
      reasoningEffort: "medium",
      streaming: true,
    });
    expect(ops(log.events)).not.toContain("gateway.chat.started");
  });

  it("skips the attempt line for a sink that declines info, without touching the call", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const gateway = new Gateway(config([provider()]), {
      adapter: {
        call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("example-chat-model")),
      },
      clock: stubClock(),
      log: {
        write: (event): void => {
          events.push(event);
        },
        enabled: (level): boolean => level === "warn" || level === "error",
      },
    });
    await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });
    expect(ops(events)).not.toContain("gateway.chat.started");
  });

  it("writes one completed line carrying the request id as the correlation id", async () => {
    const log = recorder();
    const gateway = gatewayWith(
      { call: () => Promise.resolve(okResponse("example-chat-model")) },
      log,
    );
    const response = await gateway.chat(REQUEST);
    const completed = eventFor(log.events, "gateway.chat.completed");
    expect(completed.level).toBe("info");
    expect(completed.correlationId).toBe(response.usage.requestId);
    expect(completed.extra).toMatchObject({
      modelId: "example-chat-model",
      finishReason: "stop",
      toolCallCount: 0,
      promptTokens: 1,
      completionTokens: 1,
      streaming: false,
    });
    expect(typeof completed.durationMs).toBe("number");
  });

  it("writes a failed line with the error KIND and no message text", async () => {
    const log = recorder();
    const gateway = gatewayWith(
      { call: () => Promise.reject(new TransportError("upstream said sk-leak-me")) },
      log,
    );
    await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(TransportError);
    const failed = eventFor(log.events, "gateway.chat.failed");
    expect(failed.level).toBe("warn");
    expect(failed.errorKind).toBe("GATEWAY_TRANSPORT");
    expect(JSON.stringify(failed)).not.toContain("sk-leak-me");
    expect(ops(log.events)).not.toContain("gateway.chat.completed");
  });

  it("stays silent — and behaviourally identical — when no sink is wired", async () => {
    const gateway = new Gateway(config([provider()]), {
      adapter: {
        call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("example-chat-model")),
      },
      clock: stubClock(),
    });
    await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });
  });
});

describe("Gateway.chatStream — activity log", () => {
  it("names the buffered fallback taken by an adapter with no streaming variant", async () => {
    const log = recorder();
    const gateway = gatewayWith(
      { call: () => Promise.resolve(okResponse("example-chat-model")) },
      log,
    );
    await drainStream(gateway.chatStream(REQUEST));
    const fallback = eventFor(log.events, "gateway.stream.buffered-fallback");
    expect(fallback.level).toBe("warn");
    expect(fallback.extra).toMatchObject({
      modelId: "example-chat-model",
      reason: "adapter-has-no-stream",
    });
    const streamCompleted = eventFor(log.events, "gateway.stream.completed");
    expect(streamCompleted.extra).toMatchObject({
      chunkCount: 2,
      promptTokens: 1,
      completionTokens: 1,
    });
    // The synthesised fallback delta carries the WHOLE answer, so the caller's first (and only)
    // content arrives on it — the timing is captured, not silently skipped.
    expect(typeof streamCompleted.extra?.firstTokenMs).toBe("number");
  });

  it("writes no fallback line when the adapter streams natively", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "a" };
        yield { type: "done", response: await Promise.resolve(okResponse("example-chat-model")) };
      },
    };
    await drainStream(gatewayWith(adapter, log).chatStream(REQUEST));
    expect(ops(log.events)).not.toContain("gateway.stream.buffered-fallback");
    const streamCompleted = eventFor(log.events, "gateway.stream.completed");
    expect(streamCompleted.extra).toMatchObject({
      chunkCount: 2,
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(typeof streamCompleted.extra?.firstTokenMs).toBe("number");
  });

  it("skips a leading empty delta and times firstTokenMs off the first real one", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        // A role-only / empty delta is not "the caller saw content" — it must not be mistaken
        // for the first token.
        yield { type: "delta", token: "" };
        yield { type: "delta", token: "a" };
        yield { type: "done", response: await Promise.resolve(okResponse("example-chat-model")) };
      },
    };
    await drainStream(gatewayWith(adapter, log).chatStream(REQUEST));
    const streamCompleted = eventFor(log.events, "gateway.stream.completed");
    expect(streamCompleted.extra).toMatchObject({ chunkCount: 3 });
    expect(typeof streamCompleted.extra?.firstTokenMs).toBe("number");
  });

  it("records how far a mid-stream failure got before it broke", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "a" };
        await Promise.resolve();
        throw new TransportError("stream reset");
      },
    };
    await expect(drainStream(gatewayWith(adapter, log).chatStream(REQUEST))).rejects.toBeInstanceOf(
      TransportError,
    );
    const failed = eventFor(log.events, "gateway.stream.failed");
    expect(failed.errorKind).toBe("GATEWAY_TRANSPORT");
    expect(failed.extra).toMatchObject({ chunkCount: 1, afterFirstChunk: true, streaming: true });
    expect(ops(log.events)).not.toContain("gateway.stream.completed");
  });

  // A consumer that stops iterating closes the generator through `return()`, which runs NEITHER
  // outcome branch: before the abandoned line, `gateway.stream.started` was left with nothing
  // after it — byte for byte the shape of a provider that accepted the connection and went quiet,
  // which is the one thing this log exists to make distinguishable.
  it("writes an outcome when the consumer walks away mid-stream", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "a" };
        yield { type: "delta", token: "b" };
        yield { type: "done", response: await Promise.resolve(okResponse("example-chat-model")) };
      },
    };
    for await (const chunk of gatewayWith(adapter, log).chatStream(REQUEST)) {
      expect(chunk.type).toBe("delta");
      break;
    }
    const abandoned = eventFor(log.events, "gateway.stream.abandoned");
    expect(abandoned.extra).toMatchObject({
      modelId: "example-chat-model",
      chunkCount: 1,
      streaming: true,
      reason: "consumer-stopped-iterating",
    });
    expect(typeof abandoned.durationMs).toBe("number");
    // Exactly one outcome per started stream: the abandoned line replaces the other two, and
    // appears once rather than once per remaining chunk.
    expect(ops(log.events).filter((op) => op === "gateway.stream.abandoned")).toHaveLength(1);
    expect(ops(log.events)).not.toContain("gateway.stream.completed");
    expect(ops(log.events)).not.toContain("gateway.stream.failed");
  });

  it("writes no abandoned line when the stream is drained to the end", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "done", response: await Promise.resolve(okResponse("example-chat-model")) };
      },
    };
    await drainStream(gatewayWith(adapter, log).chatStream(REQUEST));
    expect(ops(log.events)).not.toContain("gateway.stream.abandoned");
    const streamCompleted = eventFor(log.events, "gateway.stream.completed");
    // Usage still rides on the terminal chunk even with zero prior deltas — but no delta ever
    // arrived, so there is no first-token moment to report.
    expect(streamCompleted.extra).toMatchObject({
      chunkCount: 1,
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(streamCompleted.extra).not.toHaveProperty("firstTokenMs");
  });

  it("omits promptTokens/completionTokens when the provider never supplied a usage chunk", async () => {
    const log = recorder();
    const zeroUsage = {
      ...okResponse("example-chat-model"),
      usage: {
        requestId: "x",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 1,
        costClass: "low" as const,
      },
    };
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "a" };
        yield { type: "done", response: await Promise.resolve(zeroUsage) };
      },
    };
    await drainStream(gatewayWith(adapter, log).chatStream(REQUEST));
    const streamCompleted = eventFor(log.events, "gateway.stream.completed");
    // A zero/zero pair is the accumulator's untouched initial value, not a provider-reported
    // fact — printing it would claim "this call cost nothing", which nobody measured.
    expect(streamCompleted.extra).not.toHaveProperty("promptTokens");
    expect(streamCompleted.extra).not.toHaveProperty("completionTokens");
    expect(typeof streamCompleted.extra?.firstTokenMs).toBe("number");
  });

  it("writes no abandoned line when the stream fails mid-flight", async () => {
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "a" };
        await Promise.resolve();
        throw new TransportError("stream reset");
      },
    };
    await expect(drainStream(gatewayWith(adapter, log).chatStream(REQUEST))).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(ops(log.events)).not.toContain("gateway.stream.abandoned");
  });
});

// CORRELATION. The gateway mints a request id per call, which identifies the call inside this
// process and nowhere else. An operator diagnosing a frozen run greps for the id of the RUN, so
// when the caller supplies one it is the id the lines are tagged with — and the request id rides
// along in `extra` so the two id spaces stay joinable in one file.
describe("Gateway — caller correlation", () => {
  it("tags a buffered call's lines with the caller's id and keeps the request id joinable", async () => {
    const log = recorder();
    const gateway = gatewayWith(
      {
        call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("example-chat-model")),
      },
      log,
    );
    const response = await gateway.chat({ ...REQUEST, logContext: { correlationId: "run-77" } });
    for (const op of ["gateway.chat.started", "gateway.chat.completed"]) {
      const event = eventFor(log.events, op);
      expect(event.correlationId).toBe("run-77");
      expect(event.extra).toMatchObject({ requestId: response.usage.requestId });
    }
    expect(response.usage.requestId).not.toBe("run-77");
  });

  it("tags a failed call and a streaming call the same way", async () => {
    const failing = recorder();
    const failingGateway = gatewayWith(
      { call: (): Promise<NormalizedResponse> => Promise.reject(new TransportError("down")) },
      failing,
    );
    await expect(
      failingGateway.chat({ ...REQUEST, logContext: { correlationId: "run-78" } }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(eventFor(failing.events, "gateway.chat.failed").correlationId).toBe("run-78");

    const streaming = recorder();
    const streamingGateway = gatewayWith(
      {
        call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("example-chat-model")),
      },
      streaming,
    );
    await drainStream(
      streamingGateway.chatStream({ ...REQUEST, logContext: { correlationId: "run-79" } }),
    );
    // The buffered-fallback degradation is emitted from the deepest frame of the stream path; it
    // must be attributable too.
    for (const op of [
      "gateway.stream.started",
      "gateway.stream.buffered-fallback",
      "gateway.stream.completed",
    ]) {
      expect(eventFor(streaming.events, op).correlationId).toBe("run-79");
    }
  });

  // A routing refusal happens BEFORE the call has a request id of its own, so the caller's id is
  // the only thing that can attribute it — and "rejected" is exactly the outcome an operator has
  // to separate from "started and hung".
  it("tags a fail-closed routing refusal, which has no request id of its own", async () => {
    const log = recorder();
    const gateway = gatewayWith(
      { call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("m")) },
      log,
    );
    await expect(
      gateway.chat({
        ...REQUEST,
        modelId: "not-configured",
        logContext: { correlationId: "run-80" },
      }),
    ).rejects.toThrow();
    const rejected = eventFor(log.events, "gateway.route.rejected");
    expect(rejected.correlationId).toBe("run-80");
    expect(rejected.extra).not.toHaveProperty("requestId");
  });

  // No caller id keeps the previous behaviour exactly: the request id IS the correlation id, and
  // no redundant copy of it appears in `extra`.
  it("falls back to the request id, without duplicating it into extra", async () => {
    const log = recorder();
    const gateway = gatewayWith(
      {
        call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("example-chat-model")),
      },
      log,
    );
    const response = await gateway.chat(REQUEST);
    const started = eventFor(log.events, "gateway.chat.started");
    expect(started.correlationId).toBe(response.usage.requestId);
    expect(started.extra).not.toHaveProperty("requestId");
  });

  // The retry lane runs under the same id: a call that is being retried is one of the shapes a
  // "frozen" run actually has, and it must not read as unrelated traffic.
  it("carries the id into the retry lane", async () => {
    const log = recorder();
    let attempts = 0;
    const gateway = new Gateway(config([provider({ maxRetries: 1 })]), {
      adapter: {
        call: (): Promise<NormalizedResponse> => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new TransportError("first attempt down"))
            : Promise.resolve(okResponse("example-chat-model"));
        },
      },
      clock: stubClock(),
      log: log.sink,
    });
    await gateway.chat({ ...REQUEST, logContext: { correlationId: "run-81" } });
    expect(ops(log.events)).toContain("gateway.retry.scheduled");
    expect(eventFor(log.events, "gateway.retry.scheduled").correlationId).toBe("run-81");
  });
});
