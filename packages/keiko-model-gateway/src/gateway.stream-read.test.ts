// A buffered call to a route whose provider streams reads each attempt's answer over the stream
// (ADR-0003, coding run 30): the attempt's `timeoutMs` bounds the provider's silence and what is
// left of the call's budget bounds the read, so a long live generation is not cut off at
// `timeoutMs` and generated a second time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError } from "@oscharko-dev/keiko-security/errors/gateway";
import { MAX_TIMER_DELAY_MS } from "./config.js";
import { Gateway } from "./gateway.js";
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

  const encoder = new TextEncoder();
  const sseLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  const deltaLine = (content: string): string =>
    sseLine({ choices: [{ index: 0, delta: { content } }] });
  const finishLine = (reason: string): string =>
    sseLine({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
  const DONE_LINE = "data: [DONE]\n\n";

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
