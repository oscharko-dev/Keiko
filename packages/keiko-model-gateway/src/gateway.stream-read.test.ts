// A buffered call to a route whose provider streams reads each attempt's answer over the stream
// (ADR-0003, coding run 30): the attempt's `timeoutMs` bounds the provider's silence and what is
// left of the call's budget bounds the read, so a long live generation is not cut off at
// `timeoutMs` and generated a second time.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitOpenError,
  ConfigInvalidError,
  ProviderEmptyAnswerError,
  TimeoutError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { MAX_TIMER_DELAY_MS } from "./config.js";
import { Gateway, type GatewaySpendReservation } from "./gateway.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import { createScriptedGatewayClock } from "./replay.js";
import { GATEWAY_SILENCE_FLOOR_MS, providerRequestBudgetMs } from "./resilience.js";
import type {
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
  StreamReadBounds,
} from "./types.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture",
  timeoutMs: 30_000,
  maxRetries: 2,
  retryBaseDelayMs: 1,
};

// The silence bound one PROVIDER attempt actually runs under when it reads over the provider's own
// stream (#3591, PR #3602 review): PROVIDER's configured 30 s sits below the silence floor, so the
// exported floor itself is the bound — pinned to the constant, never to a copy of gateway.ts's
// private formula (a fixture that restated it would keep passing if that formula drifted). It is
// NOT `providerRetryConfig(...).attemptTimeoutMs`: that value floors to the LARGER buffered-answer
// floor (it bounds a whole-body attempt, not a streamed read's silence).
const EFFECTIVE_SILENCE_MS = GATEWAY_SILENCE_FLOOR_MS;
if (PROVIDER.timeoutMs >= EFFECTIVE_SILENCE_MS) {
  throw new Error("fixture PROVIDER.timeoutMs must stay below the silence floor for these pins");
}

function capability(streaming: boolean): ModelCapability {
  return {
    id: "example-chat-model",
    kind: "chat",
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "fixture",
    preferredUseCases: [],
    knownLimitations: [],
  };
}

function config(streaming: boolean): GatewayConfig {
  return {
    capabilities: [capability(streaming)],
    providers: [PROVIDER],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

const REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "q" }],
};

const ANSWER: NormalizedResponse = {
  modelId: "example-chat-model",
  content: "answer",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: { requestId: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
};

interface StreamingFake {
  readonly adapter: ProviderAdapter;
  readonly call: ReturnType<typeof vi.fn>;
  readonly bounds: (StreamReadBounds | undefined)[];
}

function streamingFake(failures: readonly Error[] = []): StreamingFake {
  const bounds: (StreamReadBounds | undefined)[] = [];
  const call = vi.fn(() => Promise.resolve(ANSWER));
  const pending = [...failures];
  return {
    call,
    bounds,
    adapter: {
      call,
      callStream: async function* (
        _request: GatewayRequest,
        _config: ModelProviderConfig,
        read?: StreamReadBounds,
      ): AsyncGenerator<GatewayStreamChunk> {
        bounds.push(read);
        await Promise.resolve();
        const failure = pending.shift();
        if (failure !== undefined) throw failure;
        yield { type: "delta", token: "answer" };
        yield { type: "done", response: ANSWER };
      },
    },
  };
}

function recorder(): {
  readonly events: ModelGatewayLogEvent[];
  readonly write: (event: ModelGatewayLogEvent) => void;
} {
  const events: ModelGatewayLogEvent[] = [];
  return {
    events,
    write: (event: ModelGatewayLogEvent): void => {
      events.push(event);
    },
  };
}

describe("Gateway.chat reads over the provider's stream (provider stalls, coding run 30)", () => {
  it("reads a streaming route's answer over the stream, bounded by silence and the budget", async () => {
    const fake = streamingFake();
    const log = recorder();
    const gateway = new Gateway(config(true), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock(),
      log,
    });

    const answer = await gateway.chat(REQUEST);

    expect(answer.content).toBe("answer");
    expect(fake.call).not.toHaveBeenCalled();
    expect(fake.bounds).toEqual([
      { silenceMs: EFFECTIVE_SILENCE_MS, budgetMs: providerRequestBudgetMs(PROVIDER) },
    ]);
    expect(log.events.find((event) => event.op === "gateway.chat.started")).toMatchObject({
      extra: { streaming: false, upstreamStreaming: true },
    });
  });

  it("retries a stalled read, bounded by what is left of the budget", async () => {
    const fake = streamingFake([new TimeoutError("the provider fell silent")]);
    const gateway = new Gateway(config(true), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock(),
    });

    await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });

    expect(fake.bounds).toHaveLength(2);
    const [first, retry] = fake.bounds;
    expect(retry?.silenceMs).toBe(EFFECTIVE_SILENCE_MS);
    expect(retry?.budgetMs).toBeLessThan(first?.budgetMs ?? 0);
    expect(retry?.budgetMs).toBeGreaterThanOrEqual(EFFECTIVE_SILENCE_MS);
  });

  // PR #3602 review: the silence floor must never grant a retry more than what is left of the
  // call's budget, or the call could overrun the `requestBudgetMs` its own lines report. The
  // scripted clock spends most of the budget in the backoff before the retry.
  it("clips a retry's silence bound to what is left of the budget", async () => {
    const fake = streamingFake([new TimeoutError("the provider fell silent")]);
    const budgetMs = providerRequestBudgetMs(PROVIDER);
    const leftMs = EFFECTIVE_SILENCE_MS - 60_000;
    const gateway = new Gateway(config(true), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock({ sleepMs: [budgetMs - leftMs] }),
    });

    await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });

    const [, retry] = fake.bounds;
    expect(retry?.budgetMs).toBeLessThan(EFFECTIVE_SILENCE_MS);
    expect(retry?.silenceMs).toBe(retry?.budgetMs);
  });

  it("reads a whole body when the route does not stream", async () => {
    const fake = streamingFake();
    const log = recorder();
    const gateway = new Gateway(config(false), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock(),
      log,
    });

    await gateway.chat(REQUEST);

    expect(fake.call).toHaveBeenCalledOnce();
    expect(fake.bounds).toEqual([]);
    expect(log.events.find((event) => event.op === "gateway.chat.started")).toMatchObject({
      extra: { upstreamStreaming: false },
    });
  });

  it("reads a whole body when the adapter cannot read a stream", async () => {
    const call = vi.fn(() => Promise.resolve(ANSWER));
    const gateway = new Gateway(config(true), {
      adapter: { call },
      clock: createScriptedGatewayClock(),
    });

    await gateway.chat(REQUEST);

    expect(call).toHaveBeenCalledOnce();
  });

  // Config validation holds each term of the budget to the timer ceiling, never their sum: a read
  // bounded past it would end the moment it starts (PR #3452 review).
  it("bounds the read inside what a timer can hold when the budget would pass it", async () => {
    const fake = streamingFake();
    const log = recorder();
    const longest: ModelProviderConfig = {
      ...PROVIDER,
      timeoutMs: MAX_TIMER_DELAY_MS,
      maxRetries: 1,
    };
    const gateway = new Gateway(
      { ...config(true), providers: [longest] },
      { adapter: fake.adapter, clock: createScriptedGatewayClock(), log },
    );

    await gateway.chat(REQUEST);

    expect(fake.bounds).toEqual([{ silenceMs: MAX_TIMER_DELAY_MS, budgetMs: MAX_TIMER_DELAY_MS }]);
    expect(log.events.find((event) => event.op === "gateway.chat.started")).toMatchObject({
      extra: { requestBudgetMs: MAX_TIMER_DELAY_MS, upstreamStreaming: true },
    });
  });
});

// A real provider stream, written frame by frame: the SSE lines a provider sends and the one provider
// every real-adapter test below reads from.
const encoder = new TextEncoder();
const sseLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const deltaLine = (content: string): string =>
  sseLine({ choices: [{ index: 0, delta: { content } }] });
const finishLine = (reason: string): string =>
  sseLine({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const DONE_LINE = "data: [DONE]\n\n";

const STREAM_PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture",
  timeoutMs: 30_000, // far below the silence floor — proves the FLOORED bound is what applies
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

function streamGatewayConfig(): GatewayConfig {
  return {
    capabilities: [capability(true)],
    providers: [STREAM_PROVIDER],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

// #3591: `Gateway.chatStream()` used to call `adapter.callStream(request, provider)` with NO
// bounds at all, so a real `OpenAiAdapter` fell back to its own flat `STREAM_IDLE_TIMEOUT_MS`
// (60s) for silence and the adapter-level `config.timeoutMs` for the whole read — never the
// silence/budget floors every other interactive gateway surface gets. These tests drive a REAL
// `OpenAiAdapter` (not a fake) through `Gateway.chatStream()`, so the actual bound-enforcement
// code (openai-adapter.ts's `requestDeadline`/`timedAbort`) is exercised end to end, proving the
// floors are in force at the gateway boundary and not merely documented there.
describe("Gateway.chatStream bounds a real provider stream by the floors (#3591)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  interface DrivenStream {
    readonly response: Response;
    readonly push: (line: string) => void;
    readonly end: () => void;
  }

  // A provider stream the test drives by hand: it stays open and silent until pushed to,
  // mirroring openai-adapter.stream-read.test.ts's identical helper.
  function drivenStream(): DrivenStream {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(started): void {
        controller = started;
      },
    });
    return {
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      push: (line): void => {
        controller?.enqueue(encoder.encode(line));
      },
      end: (): void => {
        controller?.close();
      },
    };
  }

  async function drainDone(
    stream: AsyncIterable<GatewayStreamChunk>,
  ): Promise<GatewayStreamChunk & { type: "done" }> {
    let done: (GatewayStreamChunk & { type: "done" }) | undefined;
    for await (const chunk of stream) {
      if (chunk.type === "done") done = chunk;
    }
    if (done === undefined) throw new Error("the stream ended without a done chunk");
    return done;
  }

  it("completes a stream whose first byte arrives after the configured timeoutMs but before the silence floor", async () => {
    vi.useFakeTimers();
    const provider = drivenStream();
    const adapter = new OpenAiAdapter({
      fetchImpl: (): Promise<Response> => Promise.resolve(provider.response),
      requestId: "fixed-id",
      costClass: "low",
    });
    const gateway = new Gateway(streamGatewayConfig(), { adapter });
    const reading = drainDone(gateway.chatStream(REQUEST));

    // Longer than the configured 30s timeoutMs, comfortably inside the 300s silence floor: the
    // OLD (unbounded) behaviour and a naive re-use of `config.timeoutMs` would both have already
    // aborted the read by this point.
    await vi.advanceTimersByTimeAsync(120_000);
    provider.push(deltaLine("answer"));
    provider.push(finishLine("stop"));
    provider.push(DONE_LINE);
    provider.end();

    const done = await reading;
    expect(done.response.content).toBe("answer");
  });

  it("fails as a TimeoutError once the stream stalls past the silence floor, reported body-free", async () => {
    vi.useFakeTimers();
    const events: ModelGatewayLogEvent[] = [];
    const log: ModelGatewayLogSink = { write: (event): void => void events.push(event) };
    const provider = drivenStream();
    const adapter = new OpenAiAdapter({
      fetchImpl: (): Promise<Response> => Promise.resolve(provider.response),
      requestId: "fixed-id",
      costClass: "low",
      log,
    });
    const gateway = new Gateway(streamGatewayConfig(), { adapter, log });
    const reading = drainDone(gateway.chatStream(REQUEST));
    const assertion = expect(reading).rejects.toBeInstanceOf(TimeoutError);

    // The stream never sends a byte: once the (floored) silence bound elapses, the read must end.
    await vi.advanceTimersByTimeAsync(GATEWAY_SILENCE_FLOOR_MS + 1);
    await assertion;

    const streamed = events.find((event) => event.op === "chat.response.streamed");
    // Body-free: the failure line names the outcome and the silence bound it ran under — never
    // provider content (there was none) and never a raw error message.
    expect(streamed).toMatchObject({
      extra: { outcome: "stalled", silenceMs: GATEWAY_SILENCE_FLOOR_MS },
    });
    const failed = events.find((event) => event.op === "gateway.stream.failed");
    expect(failed?.errorKind).toBe("timeout");
  });
});

// #3610: gpt-oss behind LiteLLM ended coding turns with reasoning only — a completed stream (a finish
// reason and [DONE]) that carries neither content nor a tool call. Before this fix that answer was a
// plain ProviderError(200): the Workbench showed it as a broken stream, and it counted toward the
// breaker, so three such answers in a row locked every caller of the model out behind
// CircuitOpenError although the provider had answered each time.
describe("a completed but empty model answer (#3610)", () => {
  function reasoningOnlyAnswer(): Response {
    const frames = [
      sseLine({ choices: [{ index: 0, delta: { content: "", reasoning: "thinking" } }] }),
      finishLine("stop"),
      DONE_LINE,
    ].join("");
    return new Response(encoder.encode(frames), {
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("is reported as an empty answer and never opens the breaker", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const log: ModelGatewayLogSink = { write: (event): void => void events.push(event) };
    let calls = 0;
    const adapter = new OpenAiAdapter({
      fetchImpl: (): Promise<Response> => {
        calls += 1;
        return Promise.resolve(reasoningOnlyAnswer());
      },
      requestId: "fixed-id",
      costClass: "low",
      log,
    });
    const gateway = new Gateway(streamGatewayConfig(), {
      adapter,
      clock: createScriptedGatewayClock(),
      log,
    });

    // One more answer than the breaker's failureThreshold of 3: every call reaches the provider.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const failure = await gateway.chat(REQUEST).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
      expect(failure).toMatchObject({ code: "GATEWAY_PROVIDER_ERROR", httpStatus: 200 });
    }
    expect(calls).toBe(4);
    expect(gateway.circuitStatus("example-chat-model")).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
    // The read that settled on the empty answer is a failed read, body-free.
    expect(events.find((event) => event.op === "chat.response.streamed")).toMatchObject({
      extra: { outcome: "failed", outputExhausted: false },
    });
  });
});

// Exercise the OpenAI-compatible wire used by LiteLLM, without an Azure endpoint.
describe("stream startup resilience", () => {
  it("retries a temporary proxy rejection before delivering any answer", async () => {
    let calls = 0;
    const log = recorder();
    const gateway = new Gateway(config(true), {
      clock: createScriptedGatewayClock(),
      log,
      fetchImpl: (): Promise<Response> => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? new Response(JSON.stringify({ error: { message: "temporarily overloaded" } }), {
                status: 503,
              })
            : new Response(
                encoder.encode(deltaLine("one answer") + finishLine("stop") + DONE_LINE),
                {
                  headers: { "content-type": "text/event-stream" },
                },
              ),
        );
      },
    });
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of gateway.chatStream(REQUEST)) chunks.push(chunk);
    expect(calls).toBe(2);
    expect(chunks.filter((chunk) => chunk.type === "delta")).toEqual([
      { type: "delta", token: "one answer" },
    ]);
    expect(log.events.some((event) => event.op === "gateway.retry.scheduled")).toBe(true);
  });

  it.each([429, 503])("waits for HTTP%d proxy recovery and delivers one answer", async (status) => {
    const clock = createScriptedGatewayClock();
    const recoveryAt = clock.now() + 120_000;
    const calls: number[] = [];
    const log = recorder();
    const gateway = new Gateway(config(true), {
      clock,
      log,
      fetchImpl: (): Promise<Response> => {
        calls.push(clock.now());
        return Promise.resolve(
          clock.now() < recoveryAt
            ? new Response("{}", { status, headers: { "retry-after": "120" } })
            : new Response(
                encoder.encode(deltaLine("recovered once") + finishLine("stop") + DONE_LINE),
                {
                  headers: { "content-type": "text/event-stream" },
                },
              ),
        );
      },
    });
    const received: string[] = [];
    for await (const chunk of gateway.chatStream(REQUEST)) {
      if (chunk.type === "delta") received.push(chunk.token);
    }
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(recoveryAt);
    expect(received).toEqual(["recovered once"]);
    expect(log.events.find((event) => event.op === "gateway.retry.scheduled")?.extra).toMatchObject(
      {
        httpStatus: status,
        delayMs: 120_000,
        retryAfterMs: 120_000,
      },
    );
    expect(JSON.stringify(log.events)).not.toContain("recovered once");
  });

  it("recovers from a silent first connection within the shared stream budget", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reservations: ReturnType<typeof vi.fn>[] = [];
    const gateway = new Gateway(config(true), {
      spendBudget: {
        reserve: (): GatewaySpendReservation => {
          const settle = vi.fn();
          reservations.push(settle);
          return { settle };
        },
      },
      fetchImpl: (): Promise<Response> => {
        calls += 1;
        return Promise.resolve(
          new Response(
            calls === 1
              ? new ReadableStream<Uint8Array>()
              : encoder.encode(deltaLine("recovered") + finishLine("stop") + DONE_LINE),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
        );
      },
    });
    const chunks: GatewayStreamChunk[] = [];
    const reading = (async (): Promise<void> => {
      for await (const chunk of gateway.chatStream(REQUEST)) chunks.push(chunk);
    })();
    try {
      await vi.advanceTimersByTimeAsync(GATEWAY_SILENCE_FLOOR_MS + 10);
      await reading;
      expect(calls).toBe(2);
      expect(chunks.filter((chunk) => chunk.type === "delta")).toEqual([
        { type: "delta", token: "recovered" },
      ]);
      expect(reservations).toHaveLength(2);
      for (const settle of reservations) expect(settle).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a rejected credential", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 401 })));
    const gateway = new Gateway(config(true), { fetchImpl, clock: createScriptedGatewayClock() });
    const reading = async (): Promise<void> => {
      for await (const chunk of gateway.chatStream(REQUEST)) expect(chunk).toBeUndefined();
    };
    await expect(reading()).rejects.toMatchObject({ code: "GATEWAY_AUTHENTICATION" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("never replays text after a proxy drops a partially delivered answer", async () => {
    let calls = 0;
    const gateway = new Gateway(config(true), {
      clock: createScriptedGatewayClock(),
      fetchImpl: (): Promise<Response> => {
        calls += 1;
        return Promise.resolve(
          new Response(encoder.encode(deltaLine("partial answer")), {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });
    const received: string[] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of gateway.chatStream(REQUEST)) {
        if (chunk.type === "delta") received.push(chunk.token);
      }
    };
    await expect(consume()).rejects.toThrow();
    expect(received).toEqual(["partial answer"]);
    expect(calls).toBe(1);
  });
});

async function consumeStream(gateway: Gateway): Promise<void> {
  for await (const chunk of gateway.chatStream(REQUEST)) expect(chunk).toBeDefined();
}

describe("stream retry circuit accounting", () => {
  it("counts each failed startup attempt exactly once", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 503 })));
    const gateway = new Gateway(config(true), { fetchImpl, clock: createScriptedGatewayClock() });
    await expect(consumeStream(gateway)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(gateway.circuitStatus(REQUEST.modelId)).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
    });
  });

  it("does not extend the cooldown when a concurrent call opens the breaker during backoff", async () => {
    let now = 0;
    const fake = streamingFake([
      new TimeoutError("first failure"),
      new CircuitOpenError("adapter failure"),
    ]);
    const gateway = new Gateway(
      {
        ...config(true),
        circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, halfOpenProbes: 1 },
      },
      {
        adapter: fake.adapter,
        clock: {
          now: (): number => now,
          sleep: async (): Promise<void> => {
            await expect(consumeStream(gateway)).rejects.toThrow();
            now = 100;
          },
        },
      },
    );
    await expect(consumeStream(gateway)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(gateway.circuitStatus(REQUEST.modelId)).toMatchObject({
      state: "open",
      openedAt: 0,
      consecutiveFailures: 1,
    });
  });

  it("still counts an adapter-thrown CircuitOpenError as a provider failure", async () => {
    const fake = streamingFake([new CircuitOpenError("adapter failure")]);
    const gateway = new Gateway(config(true), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock(),
    });
    await expect(consumeStream(gateway)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(gateway.circuitStatus(REQUEST.modelId).consecutiveFailures).toBe(1);
  });
});

it.each(["streaming", "buffered"])(
  "releases a half-open %s probe when spend admission refuses the attempt",
  async (mode) => {
    let now = 0;
    let refused = false;
    const fake = streamingFake([new TimeoutError("provider outage")]);
    const gateway = new Gateway(
      {
        ...config(true),
        providers: [{ ...PROVIDER, maxRetries: 0 }],
        circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, halfOpenProbes: 1 },
      },
      {
        adapter: fake.adapter,
        clock: { now: (): number => now, sleep: (): Promise<void> => Promise.resolve() },
        spendBudget: {
          reserve: (): GatewaySpendReservation => {
            if (refused) throw new ConfigInvalidError("spend admission refused");
            return { settle: (): void => undefined };
          },
        },
      },
    );
    const consume = async (): Promise<void> => {
      if (mode === "streaming") await consumeStream(gateway);
      else await gateway.chat(REQUEST);
    };
    await expect(consume()).rejects.toBeInstanceOf(TimeoutError);
    now = 1000;
    refused = true;
    await expect(consume()).rejects.toBeInstanceOf(ConfigInvalidError);
    refused = false;
    await expect(consume()).resolves.toBeUndefined();
    expect(gateway.circuitStatus(REQUEST.modelId).state).toBe("closed");
  },
);

it.each(["cancelled", "abandoned"])("releases a %s half-open stream probe", async (outcome) => {
  let now = 0;
  const fake = streamingFake([new TimeoutError("provider outage")]);
  const log = recorder();
  const gateway = new Gateway(
    {
      ...config(true),
      providers: [{ ...PROVIDER, maxRetries: 0 }],
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, halfOpenProbes: 1 },
    },
    {
      adapter: fake.adapter,
      log,
      clock: { now: (): number => now, sleep: (): Promise<void> => Promise.resolve() },
    },
  );
  await expect(consumeStream(gateway)).rejects.toBeInstanceOf(TimeoutError);
  now = 1000;
  const stream = gateway.chatStream({
    ...REQUEST,
    logContext: { correlationId: "cancelled-probe-0001" },
    ...(outcome === "cancelled" ? { cancellationSignal: AbortSignal.abort() } : {}),
  });
  if (outcome === "cancelled") {
    await expect(stream.next()).rejects.toMatchObject({ code: "GATEWAY_CANCELLED" });
    expect(fake.bounds).toHaveLength(1);
  } else {
    expect((await stream.next()).value).toEqual({ type: "delta", token: "answer" });
    await stream.return(undefined);
  }
  expect(log.events).toContainEqual(
    expect.objectContaining({
      op: outcome === "cancelled" ? "gateway.stream.failed" : "gateway.stream.abandoned",
      correlationId: "cancelled-probe-0001",
    }),
  );
  expect(gateway.circuitStatus(REQUEST.modelId).state).toBe("half-open");
  await expect(consumeStream(gateway)).resolves.toBeUndefined();
  expect(gateway.circuitStatus(REQUEST.modelId).state).toBe("closed");
});

it.each(["abandoned", "succeeded", "failed"])(
  "does not let an older %s stream settle a later half-open probe",
  async (outcome) => {
    let now = 0;
    let calls = 0;
    const log = recorder();
    const adapter: ProviderAdapter = {
      call: (): Promise<NormalizedResponse> => Promise.resolve(ANSWER),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        const call = ++calls;
        if (call === 2) throw new TimeoutError("provider outage");
        yield { type: "delta", token: "answer" };
        if (call === 1 && outcome === "failed") throw new TimeoutError("late failure");
        yield { type: "done", response: ANSWER };
      },
    };
    const gateway = new Gateway(
      {
        ...config(true),
        providers: [{ ...PROVIDER, maxRetries: 0 }],
        circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, halfOpenProbes: 1 },
      },
      {
        adapter,
        log,
        clock: { now: (): number => now, sleep: (): Promise<void> => Promise.resolve() },
      },
    );
    const older = gateway.chatStream(REQUEST);
    await older.next();
    await expect(consumeStream(gateway)).rejects.toBeInstanceOf(TimeoutError);
    now = 1000;
    const probe = gateway.chatStream(REQUEST);
    await probe.next();
    if (outcome === "abandoned") await older.return(undefined);
    else if (outcome === "failed") await expect(older.next()).rejects.toBeInstanceOf(TimeoutError);
    else {
      await older.next();
      await older.next();
    }
    expect(gateway.circuitStatus(REQUEST.modelId).state).toBe("half-open");
    await expect(consumeStream(gateway)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(3);
    expect(log.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.circuit.rejected",
        extra: expect.objectContaining({ reason: "probe-saturated", probesInFlight: 1 }) as unknown,
      }),
    );
    await probe.next();
    await probe.next();
    expect(gateway.circuitStatus(REQUEST.modelId).state).toBe("closed");
  },
);

// The Coding Workbench consumer returns at the done packet without advancing or closing
// the generator. All terminal resources and evidence must already be settled at that point.
it.each(["native", "buffered", "terminal-only"])(
  "settles a %s stream before handing done to its consumer",
  async (mode) => {
    let now = 0;
    const closed = vi.fn();
    const settle = vi.fn();
    const log = recorder();
    const call = vi
      .fn<() => Promise<NormalizedResponse>>()
      .mockRejectedValueOnce(new TimeoutError("outage"))
      .mockResolvedValue(ANSWER);
    const adapter: ProviderAdapter = {
      call,
      ...(mode !== "buffered"
        ? {
            callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
              try {
                const response: NormalizedResponse = await call();
                if (mode !== "terminal-only") yield { type: "delta", token: response.content };
                yield { type: "done", response };
              } finally {
                closed();
              }
            },
          }
        : {}),
    };
    const gateway = new Gateway(
      {
        ...config(true),
        providers: [{ ...PROVIDER, maxRetries: 0 }],
        circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, halfOpenProbes: 1 },
      },
      {
        adapter,
        log,
        clock: { now: (): number => now, sleep: (): Promise<void> => Promise.resolve() },
        spendBudget: { reserve: (): GatewaySpendReservation => ({ settle }) },
      },
    );
    await expect(consumeStream(gateway)).rejects.toBeInstanceOf(TimeoutError);
    now = 1000;
    settle.mockClear();
    closed.mockClear();
    const stream = gateway.chatStream(REQUEST);
    if (mode !== "terminal-only") {
      expect(await stream.next()).toMatchObject({ value: { type: "delta" } });
    }
    expect(await stream.next()).toMatchObject({ value: { type: "done" } });
    expect(gateway.circuitStatus(REQUEST.modelId)).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
    expect(settle).toHaveBeenCalledExactlyOnceWith(ANSWER.usage);
    expect(closed).toHaveBeenCalledTimes(mode === "buffered" ? 0 : 1);
    expect(log.events.filter((event) => event.op === "gateway.stream.completed")).toHaveLength(1);
    expect(log.events.filter((event) => event.op === "gateway.stream.abandoned")).toHaveLength(0);
    // A late cleanup must not settle the same reservation or emit an outcome twice.
    await stream.return(undefined);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(log.events.filter((event) => event.op === "gateway.stream.completed")).toHaveLength(1);
    await expect(consumeStream(gateway)).resolves.toBeUndefined();
  },
);

it("does not retry a failed half-open probe reached during startup backoff", async () => {
  let now = 0;
  const fake = streamingFake([new TimeoutError("outage"), new TimeoutError("probe failure")]);
  const log = recorder();
  const gateway = new Gateway(
    {
      ...config(true),
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, halfOpenProbes: 1 },
    },
    {
      adapter: fake.adapter,
      log,
      clock: {
        now: (): number => now,
        sleep: (): Promise<void> => {
          now += 1000;
          return Promise.resolve();
        },
      },
    },
  );
  await expect(consumeStream(gateway)).rejects.toThrow("probe failure");
  expect(fake.bounds).toHaveLength(2);
  expect(gateway.circuitStatus(REQUEST.modelId).state).toBe("open");
  expect(log.events.filter((event) => event.op === "gateway.retry.exhausted")).toEqual([
    expect.objectContaining({ extra: expect.objectContaining({ reason: "terminal" }) as unknown }),
  ]);
});
