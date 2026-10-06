// #3873 (F17): a reasoning model that spends its whole output budget without a tool call or a
// final answer (Gemma 4 31B behind LiteLLM, run 324076066246415201273338647160811469441) used to
// surface at once, and the coding runtime retried the identical turn, which ran away identically.
// The gateway now steers ONE repaired attempt — the original request plus one fixed system
// correction — before the exhaustion surfaces, on the buffered and on the streamed path alike.
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  GatewayError,
  ProviderOutputExhaustedError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway, OUTPUT_EXHAUSTED_REPAIR_MESSAGE, type GatewayCallRequest } from "./gateway.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import { providerRequestBudgetMs } from "./resilience.js";
import type {
  Clock,
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const MODEL = "reasoning-coder";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: MODEL,
    baseUrl: "https://provider.example/v1",
    apiKey: "fixture-key",
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function config(providerValue = provider(), streaming = false): GatewayConfig {
  return {
    providers: [providerValue],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: MODEL,
        kind: "chat",
        contextWindow: 131_072,
        maxOutputTokens: 0,
        toolCalling: true,
        structuredOutput: true,
        streaming,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "fixture",
        preferredUseCases: [],
        knownLimitations: [],
      },
    ],
  };
}

const REQUEST: GatewayCallRequest = {
  modelId: MODEL,
  messages: [{ role: "user", content: "Read the seven files and fix the bug." }],
  maxOutputTokens: 8_192,
  logContext: { correlationId: "run-f17-324076" },
};

function toolCallAnswer(): NormalizedResponse {
  return {
    modelId: MODEL,
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id: "call-1", name: "keiko_read_file", arguments: { path: "src/a.ts" } }],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 20,
      completionTokens: 30,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function scriptedClock(): Clock & { readonly advance: (ms: number) => void } {
  let now = 1_000_000;
  return {
    now: (): number => now,
    sleep: (ms): Promise<void> => {
      now += ms;
      return Promise.resolve();
    },
    advance: (ms): void => {
      now += ms;
    },
  };
}

interface Scripted {
  readonly adapter: ProviderAdapter;
  readonly requests: GatewayRequest[];
}

/** A buffered adapter answering each call from `answers` in order: an Error rejects, a response resolves. */
function bufferedAdapter(answers: readonly (Error | NormalizedResponse)[]): Scripted {
  const requests: GatewayRequest[] = [];
  const pending = [...answers];
  return {
    requests,
    adapter: {
      call: (request): Promise<NormalizedResponse> => {
        requests.push(request);
        const answer = pending.shift();
        if (answer === undefined) throw new Error("fixture exhausted");
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}

/** A streaming adapter: an Error ends the open before any chunk, a response streams one delta then done. */
function streamingAdapter(answers: readonly (Error | NormalizedResponse)[]): Scripted {
  const requests: GatewayRequest[] = [];
  const pending = [...answers];
  return {
    requests,
    adapter: {
      call: (): Promise<NormalizedResponse> =>
        Promise.reject(new Error("buffered call unexpected")),
      callStream: async function* (request): AsyncGenerator<GatewayStreamChunk> {
        requests.push(request);
        await Promise.resolve();
        const answer = pending.shift();
        if (answer === undefined) throw new Error("fixture exhausted");
        if (answer instanceof Error) throw answer;
        yield { type: "delta", token: "final answer" };
        yield { type: "done", response: answer };
      },
    },
  };
}

function gatewayFor(
  scripted: Scripted,
  events: ModelGatewayLogEvent[],
  gatewayConfig = config(),
  clock: Clock = scriptedClock(),
): Gateway {
  return new Gateway(gatewayConfig, {
    adapter: scripted.adapter,
    clock,
    random: (): number => 1,
    log: { write: (event): void => void events.push(event) },
  });
}

function scheduledLines(events: readonly ModelGatewayLogEvent[]): ModelGatewayLogEvent[] {
  return events.filter((event) => event.op === "gateway.retry.scheduled");
}

async function drain(stream: AsyncIterable<GatewayStreamChunk>): Promise<GatewayStreamChunk[]> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("Gateway output-exhausted repair (#3873 F17)", () => {
  it("steers exactly one repaired buffered attempt with the fixed correction appended", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([new ProviderOutputExhaustedError(MODEL), toolCallAnswer()]);

    const result = await gatewayFor(scripted, events).chat(REQUEST);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.outputRepair).toBe("recovered");
    expect(scripted.requests).toHaveLength(2);
    // The repaired request is the original plus ONE system correction: nothing is dropped and the
    // model's exhausted reasoning is never quoted back.
    expect(scripted.requests[1]?.messages).toEqual([
      ...REQUEST.messages,
      { role: "system", content: OUTPUT_EXHAUSTED_REPAIR_MESSAGE },
    ]);
    expect(scripted.requests[1]?.maxOutputTokens).toBe(REQUEST.maxOutputTokens);
    const scheduled = scheduledLines(events);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      correlationId: "run-f17-324076",
      extra: { reason: "output-exhausted-repair", delayMs: 0, attempt: 1, httpStatus: 200 },
    });
    expect(
      expectActivityLogProof(
        "gateway.retry.scheduled.emitted-line",
        formatActivityLogProofLine(scheduled[0] ?? {}),
      ),
    ).toMatchObject({ reason: "output-exhausted-repair", delayMs: 0 });
    expect(events.find((event) => event.op === "gateway.chat.completed")?.extra).toMatchObject({
      toolCallCount: 1,
    });
    expect(JSON.stringify(events)).not.toContain("Read the seven files");
  });

  it("surfaces a second exhaustion once, marked as the repair's outcome, without a third attempt", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([
      new ProviderOutputExhaustedError(MODEL),
      new ProviderOutputExhaustedError(MODEL),
      toolCallAnswer(),
    ]);
    const gateway = gatewayFor(scripted, events);

    const failure = await gateway.chat(REQUEST).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(failure).toMatchObject({ outputRepair: "exhausted-again" });
    expect(scripted.requests).toHaveLength(2);
    expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
      "output-exhausted-repair",
    ]);
    expect(events.find((event) => event.op === "gateway.retry.exhausted")?.extra).toMatchObject({
      attempt: 2,
      reason: "terminal",
    });
    expect(events.find((event) => event.op === "gateway.chat.failed")?.extra).toMatchObject({
      outputExhausted: true,
    });
    // The model answered twice: neither answer is a provider fault for the breaker.
    expect(gateway.circuitStatus(MODEL)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("grants the repair independently of the provider's attempt count", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([new ProviderOutputExhaustedError(MODEL), toolCallAnswer()]);

    const result = await gatewayFor(scripted, events, config(provider({ maxRetries: 0 }))).chat(
      REQUEST,
    );

    expect(result.outputRepair).toBe("recovered");
    expect(scripted.requests).toHaveLength(2);
  });

  it("marks a repaired attempt that fails for another reason as failed, not exhausted again", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([
      new ProviderOutputExhaustedError(MODEL),
      new AuthenticationError("credential refused"),
    ]);

    const failure = await gatewayFor(scripted, events)
      .chat(REQUEST)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(failure).toMatchObject({ outputRepair: "failed" });
    expect(scripted.requests).toHaveLength(2);
  });

  it("does not steer a repair the call's budget can no longer hold", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const clock = scriptedClock();
    const providerValue = provider();
    const requests: GatewayRequest[] = [];
    const scripted: Scripted = {
      requests,
      adapter: {
        call: (request): Promise<NormalizedResponse> => {
          requests.push(request);
          clock.advance(providerRequestBudgetMs(providerValue));
          return Promise.reject(new ProviderOutputExhaustedError(MODEL));
        },
      },
    };

    const failure = await gatewayFor(scripted, events, config(providerValue), clock)
      .chat(REQUEST)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).outputRepair).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(scheduledLines(events)).toEqual([]);
    expect(events.find((event) => event.op === "gateway.retry.exhausted")?.extra).toMatchObject({
      reason: "budget",
    });
  });

  it("steers one repaired streamed attempt and carries the outcome on the done chunk", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = streamingAdapter([new ProviderOutputExhaustedError(MODEL), toolCallAnswer()]);

    const chunks = await drain(
      gatewayFor(scripted, events, config(provider(), true)).chatStream(REQUEST),
    );

    expect(chunks.map((chunk) => chunk.type)).toEqual(["delta", "done"]);
    const done = chunks.at(-1);
    expect(done?.type === "done" ? done.response.outputRepair : undefined).toBe("recovered");
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]?.messages).toEqual([
      ...REQUEST.messages,
      { role: "system", content: OUTPUT_EXHAUSTED_REPAIR_MESSAGE },
    ]);
    expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
      "output-exhausted-repair",
    ]);
    expect(events.find((event) => event.op === "gateway.stream.completed")).toBeDefined();
  });

  it("surfaces a second streamed exhaustion once, marked as the repair's outcome", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = streamingAdapter([
      new ProviderOutputExhaustedError(MODEL),
      new ProviderOutputExhaustedError(MODEL),
      toolCallAnswer(),
    ]);
    const gateway = gatewayFor(scripted, events, config(provider(), true));

    const failure = await drain(gateway.chatStream(REQUEST)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(failure).toMatchObject({ outputRepair: "exhausted-again" });
    expect(scripted.requests).toHaveLength(2);
    expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
      "output-exhausted-repair",
    ]);
    expect(events.find((event) => event.op === "gateway.stream.failed")?.extra).toMatchObject({
      outputExhausted: true,
      chunkCount: 0,
    });
    expect(gateway.circuitStatus(MODEL)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  // The repair window is the stream's startup. Once a chunk reached the caller — answer text here;
  // a forwarded reasoning chunk closes the window the same way on a surface that displays reasoning
  // — nothing may be replayed, so a later exhaustion surfaces at once and unmarked: the honest
  // outcome of what was already shown, never a second answer appended to it.
  it("does not repair a streamed exhaustion once a chunk was already delivered", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const requests: GatewayRequest[] = [];
    const scripted: Scripted = {
      requests,
      adapter: {
        call: (): Promise<NormalizedResponse> =>
          Promise.reject(new Error("buffered call unexpected")),
        callStream: async function* (request): AsyncGenerator<GatewayStreamChunk> {
          requests.push(request);
          await Promise.resolve();
          yield { type: "delta", token: "partial" };
          throw new ProviderOutputExhaustedError(MODEL);
        },
      },
    };
    const gateway = gatewayFor(scripted, events, config(provider(), true));
    const delivered: GatewayStreamChunk[] = [];

    const failure = await (async (): Promise<unknown> => {
      try {
        for await (const chunk of gateway.chatStream(REQUEST)) delivered.push(chunk);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(delivered).toEqual([{ type: "delta", token: "partial" }]);
    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect((failure as GatewayError).outputRepair).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(scheduledLines(events)).toEqual([]);
    expect(events.find((event) => event.op === "gateway.stream.failed")?.extra).toMatchObject({
      outputExhausted: true,
      afterFirstChunk: true,
      chunkCount: 1,
    });
  });
});

type StreamStep = GatewayStreamChunk | Error;

/** A streaming adapter whose attempts replay the scripted step lists in order; the last one repeats. */
function scriptedStreams(attempts: readonly (readonly StreamStep[])[]): Scripted {
  const requests: GatewayRequest[] = [];
  let attempt = 0;
  return {
    requests,
    adapter: {
      call: (): Promise<NormalizedResponse> =>
        Promise.reject(new Error("buffered call unexpected")),
      callStream: async function* (request): AsyncGenerator<GatewayStreamChunk> {
        requests.push(request);
        const steps = attempts[Math.min(attempt, attempts.length - 1)] ?? [];
        attempt += 1;
        await Promise.resolve();
        for (const step of steps) {
          if (step instanceof Error) throw step;
          yield step;
        }
      },
    },
  };
}

function kinds(chunks: readonly GatewayStreamChunk[]): readonly string[] {
  return chunks.map((chunk) => (chunk.type === "done" ? "done" : `${chunk.type}:${chunk.token}`));
}

/** Drains a stream into `delivered`; resolves with the failure that ended it, or undefined. */
async function drainInto(
  stream: AsyncIterable<GatewayStreamChunk>,
  delivered: GatewayStreamChunk[],
): Promise<unknown> {
  try {
    for await (const chunk of stream) delivered.push(chunk);
    return undefined;
  } catch (error) {
    return error;
  }
}

// Owner decision 2026-10-06 (option iii): with the reasoning display on, a coding turn's reasoning
// is forwarded as it arrives, so an answer that exhausts its budget on reasoning alone has already
// shown that reasoning. It still gets the one steered repair — the Workbench then shows a second
// reasoning passage, and no answer text or tool call is ever duplicated — while an exhaustion after
// delivered answer text stays unrepaired and honest.
describe("Gateway output-exhausted repair after forwarded reasoning (#3873 F17, option iii)", () => {
  const CODING_REQUEST: GatewayCallRequest = { ...REQUEST, latencyProfile: "coding-workbench" };
  const exhausted = (): ProviderOutputExhaustedError => new ProviderOutputExhaustedError(MODEL);

  it("steers one repaired attempt after reasoning alone was forwarded, delivering a second passage", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = scriptedStreams([
      [{ type: "reasoning", token: "first passage" }, exhausted()],
      [
        { type: "reasoning", token: "second passage" },
        { type: "done", response: toolCallAnswer() },
      ],
    ]);

    const chunks = await drain(
      gatewayFor(scripted, events, config(provider(), true)).chatStream(CODING_REQUEST),
    );

    expect(kinds(chunks)).toEqual(["reasoning:first passage", "reasoning:second passage", "done"]);
    const done = chunks.at(-1);
    expect(done?.type === "done" ? done.response : undefined).toMatchObject({
      outputRepair: "recovered",
      toolCalls: [{ name: "keiko_read_file" }],
    });
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]?.messages).toEqual([
      ...REQUEST.messages,
      { role: "system", content: OUTPUT_EXHAUSTED_REPAIR_MESSAGE },
    ]);
    expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
      "output-exhausted-repair",
    ]);
    expect(events.find((event) => event.op === "gateway.stream.failed")).toBeUndefined();
    expect(events.find((event) => event.op === "gateway.stream.completed")?.extra).toMatchObject({
      chunkCount: 3,
    });
    expect(JSON.stringify(events)).not.toContain("first passage");
  });

  it("surfaces a second exhaustion after forwarded reasoning once, marked as the repair's outcome", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = scriptedStreams([
      [{ type: "reasoning", token: "first passage" }, exhausted()],
      [{ type: "reasoning", token: "second passage" }, exhausted()],
      [{ type: "done", response: toolCallAnswer() }],
    ]);
    const gateway = gatewayFor(scripted, events, config(provider(), true));
    const delivered: GatewayStreamChunk[] = [];

    const failure = await drainInto(gateway.chatStream(CODING_REQUEST), delivered);

    expect(kinds(delivered)).toEqual(["reasoning:first passage", "reasoning:second passage"]);
    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(failure).toMatchObject({ outputRepair: "exhausted-again" });
    expect(scripted.requests).toHaveLength(2);
    expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
      "output-exhausted-repair",
    ]);
    expect(events.find((event) => event.op === "gateway.stream.failed")?.extra).toMatchObject({
      outputExhausted: true,
      afterFirstChunk: true,
      chunkCount: 2,
    });
    expect(gateway.circuitStatus(MODEL)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("does not repair an exhaustion once answer text followed the reasoning", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = scriptedStreams([
      [{ type: "reasoning", token: "thinking" }, { type: "delta", token: "partial" }, exhausted()],
      [{ type: "done", response: toolCallAnswer() }],
    ]);
    const delivered: GatewayStreamChunk[] = [];

    const failure = await drainInto(
      gatewayFor(scripted, events, config(provider(), true)).chatStream(CODING_REQUEST),
      delivered,
    );

    expect(kinds(delivered)).toEqual(["reasoning:thinking", "delta:partial"]);
    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect((failure as GatewayError).outputRepair).toBeUndefined();
    expect(scripted.requests).toHaveLength(1);
    expect(scheduledLines(events)).toEqual([]);
  });
});
