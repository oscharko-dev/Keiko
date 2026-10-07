// #3873 (F17): a reasoning model that spends its whole output budget without a tool call or a
// final answer (Gemma 4 31B behind LiteLLM, run 324076066246415201273338647160811469441) used to
// surface at once, and the coding runtime retried the identical turn, which ran away identically.
// The gateway now steers ONE repaired attempt — the original request plus one fixed system
// correction — before the exhaustion surfaces, on the buffered and on the streamed path alike.
// #3873 (F23): the same one repair covers an answer that ended after reasoning without a tool call
// or any text (Gemma 4 31B streamed through LiteLLM, run 74202984158312182524609898190850427735),
// which the coding runtime also retried identically until the operator stopped the run.
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  GatewayError,
  ProviderEmptyAnswerError,
  ProviderOutputExhaustedError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import {
  EMPTY_ANSWER_REPAIR_MESSAGE,
  Gateway,
  OUTPUT_EXHAUSTED_REPAIR_MESSAGE,
  type GatewayCallRequest,
} from "./gateway.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import { providerRequestBudgetMs } from "./resilience.js";
import { GatewayToolCatalogError } from "./toolCatalogBridge.js";
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

// The coding sidecar route asks for the steered repair with the explicit `answerRepair` signal; a
// call without it surfaces such an answer at once (pinned below and in gateway.test.ts).
const REQUEST: GatewayCallRequest = {
  modelId: MODEL,
  messages: [{ role: "user", content: "Read the seven files and fix the bug." }],
  maxOutputTokens: 8_192,
  logContext: { correlationId: "run-f17-324076" },
  answerRepair: "steered",
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

  // The repair window closes with the first answer delta: once answer text reached the caller,
  // nothing may be replayed, so a later exhaustion surfaces at once and unmarked — the honest
  // outcome of what was already shown, never a second answer appended to it. Forwarded reasoning
  // does not close it (owner decision 2026-10-06, F17 option iii; pinned in the next describe).
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
  const CODING_REQUEST: GatewayCallRequest = {
    ...REQUEST,
    latencyProfile: "coding-workbench",
    reasoningDelivery: "forward",
  };
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

// #3873 (F23): a model that reasons and then ends its turn without a tool call or any text (the
// provider answers HTTP 200 with `finish_reason: "stop"`, so it is not an exhausted budget) got no
// repair: the coding runtime retried the identical turn seven times. The same one steered repair now
// covers it — with its own fixed correction — but only when the answer carried reasoning; an answer
// that was empty with no reasoning at all keeps being surfaced as the model's final word (#3610).
describe("Gateway empty-answer repair after reasoning (#3873 F23)", () => {
  const emptyAfterReasoning = (): ProviderEmptyAnswerError =>
    new ProviderEmptyAnswerError(MODEL, [], true);
  const plainEmpty = (): ProviderEmptyAnswerError => new ProviderEmptyAnswerError(MODEL);
  const exhausted = (): ProviderOutputExhaustedError => new ProviderOutputExhaustedError(MODEL);

  it("steers exactly one repaired buffered attempt with the empty-answer correction appended", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([emptyAfterReasoning(), toolCallAnswer()]);

    const result = await gatewayFor(scripted, events).chat(REQUEST);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.outputRepair).toBe("recovered");
    expect(scripted.requests).toHaveLength(2);
    // The original request plus ONE system correction: nothing is dropped and the model's
    // reasoning is never quoted back.
    expect(scripted.requests[1]?.messages).toEqual([
      ...REQUEST.messages,
      { role: "system", content: EMPTY_ANSWER_REPAIR_MESSAGE },
    ]);
    expect(scripted.requests[1]?.maxOutputTokens).toBe(REQUEST.maxOutputTokens);
    const scheduled = scheduledLines(events);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      correlationId: "run-f17-324076",
      extra: { reason: "empty-answer-repair", delayMs: 0, attempt: 1, httpStatus: 200 },
    });
    expect(
      expectActivityLogProof(
        "gateway.retry.scheduled.emitted-line",
        formatActivityLogProofLine(scheduled[0] ?? {}),
      ),
    ).toMatchObject({ reason: "empty-answer-repair", delayMs: 0 });
    expect(JSON.stringify(events)).not.toContain("Read the seven files");
  });

  it("words the empty-answer correction apart from the exhausted-budget one", () => {
    expect(EMPTY_ANSWER_REPAIR_MESSAGE).not.toBe(OUTPUT_EXHAUSTED_REPAIR_MESSAGE);
    expect(EMPTY_ANSWER_REPAIR_MESSAGE).toContain("ended after reasoning");
    expect(EMPTY_ANSWER_REPAIR_MESSAGE).toContain("without a tool call or a final answer");
  });

  it("surfaces a second empty answer once, marked as the repair's outcome, without a third attempt", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([
      emptyAfterReasoning(),
      emptyAfterReasoning(),
      toolCallAnswer(),
    ]);
    const gateway = gatewayFor(scripted, events);

    const failure = await gateway.chat(REQUEST).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect(failure).toMatchObject({ outputRepair: "empty-again" });
    expect(scripted.requests).toHaveLength(2);
    expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
      "empty-answer-repair",
    ]);
    expect(events.find((event) => event.op === "gateway.retry.exhausted")?.extra).toMatchObject({
      attempt: 2,
      reason: "terminal",
    });
    // The model answered twice: neither answer is a provider fault for the breaker.
    expect(gateway.circuitStatus(MODEL)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  // The #3610 pin, kept exactly: an empty answer with no reasoning is the model's final word.
  it("does not repair an empty answer that carried no reasoning", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([plainEmpty(), toolCallAnswer()]);

    const failure = await gatewayFor(scripted, events)
      .chat(REQUEST)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect((failure as GatewayError).outputRepair).toBeUndefined();
    expect(scripted.requests).toHaveLength(1);
    expect(scheduledLines(events)).toEqual([]);
  });

  it("grants one repair per call whichever of the two failures comes first", async () => {
    const exhaustedFirst = bufferedAdapter([exhausted(), emptyAfterReasoning(), toolCallAnswer()]);
    const emptyFirst = bufferedAdapter([emptyAfterReasoning(), exhausted(), toolCallAnswer()]);

    const afterExhausted = await gatewayFor(exhaustedFirst, [])
      .chat(REQUEST)
      .catch((error: unknown) => error);
    const afterEmpty = await gatewayFor(emptyFirst, [])
      .chat(REQUEST)
      .catch((error: unknown) => error);

    // The outcome names how the repaired attempt ended, whatever the first failure was.
    expect(afterExhausted).toBeInstanceOf(ProviderEmptyAnswerError);
    expect(afterExhausted).toMatchObject({ outputRepair: "empty-again" });
    expect(afterEmpty).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(afterEmpty).toMatchObject({ outputRepair: "exhausted-again" });
    expect(exhaustedFirst.requests).toHaveLength(2);
    expect(emptyFirst.requests).toHaveLength(2);
    // Each repair carries the correction of the failure it answers.
    expect(exhaustedFirst.requests[1]?.messages.at(-1)?.content).toBe(
      OUTPUT_EXHAUSTED_REPAIR_MESSAGE,
    );
    expect(emptyFirst.requests[1]?.messages.at(-1)?.content).toBe(EMPTY_ANSWER_REPAIR_MESSAGE);
  });

  it("marks a repaired attempt that fails for another reason as failed", async () => {
    const scripted = bufferedAdapter([
      emptyAfterReasoning(),
      new AuthenticationError("credential refused"),
    ]);

    const failure = await gatewayFor(scripted, [])
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
          return Promise.reject(emptyAfterReasoning());
        },
      },
    };

    const failure = await gatewayFor(scripted, events, config(providerValue), clock)
      .chat(REQUEST)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect((failure as GatewayError).outputRepair).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(scheduledLines(events)).toEqual([]);
    expect(events.find((event) => event.op === "gateway.retry.exhausted")?.extra).toMatchObject({
      reason: "budget",
    });
  });

  it("steers one repaired streamed attempt when nothing but discarded reasoning preceded the empty answer", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = streamingAdapter([emptyAfterReasoning(), toolCallAnswer()]);

    const chunks = await drain(
      gatewayFor(scripted, events, config(provider(), true)).chatStream(REQUEST),
    );

    expect(chunks.map((chunk) => chunk.type)).toEqual(["delta", "done"]);
    const done = chunks.at(-1);
    expect(done?.type === "done" ? done.response.outputRepair : undefined).toBe("recovered");
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]?.messages).toEqual([
      ...REQUEST.messages,
      { role: "system", content: EMPTY_ANSWER_REPAIR_MESSAGE },
    ]);
    expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
      "empty-answer-repair",
    ]);
  });

  it("surfaces a second streamed empty answer once, marked as the repair's outcome", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = streamingAdapter([
      emptyAfterReasoning(),
      emptyAfterReasoning(),
      toolCallAnswer(),
    ]);
    const gateway = gatewayFor(scripted, events, config(provider(), true));

    const failure = await drain(gateway.chatStream(REQUEST)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect(failure).toMatchObject({ outputRepair: "empty-again" });
    expect(scripted.requests).toHaveLength(2);
    expect(gateway.circuitStatus(MODEL)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  // The coding turn asks for reasoning delivery, so its first attempt has already shown its
  // reasoning when the answer ends empty. The one repair still runs — the caller then sees a second
  // reasoning passage, and no answer text or tool call is duplicated (owner decision 2026-10-06,
  // option iii, applied to this failure as it is to an exhausted budget).
  describe("after forwarded reasoning", () => {
    const CODING_REQUEST: GatewayCallRequest = {
      ...REQUEST,
      latencyProfile: "coding-workbench",
      reasoningDelivery: "forward",
    };

    it("steers one repaired attempt after reasoning alone was forwarded, delivering a second passage", async () => {
      const events: ModelGatewayLogEvent[] = [];
      const scripted = scriptedStreams([
        [{ type: "reasoning", token: "first passage" }, emptyAfterReasoning()],
        [
          { type: "reasoning", token: "second passage" },
          { type: "done", response: toolCallAnswer() },
        ],
      ]);

      const chunks = await drain(
        gatewayFor(scripted, events, config(provider(), true)).chatStream(CODING_REQUEST),
      );

      expect(kinds(chunks)).toEqual([
        "reasoning:first passage",
        "reasoning:second passage",
        "done",
      ]);
      const done = chunks.at(-1);
      expect(done?.type === "done" ? done.response : undefined).toMatchObject({
        outputRepair: "recovered",
        toolCalls: [{ name: "keiko_read_file" }],
      });
      expect(scripted.requests).toHaveLength(2);
      expect(scripted.requests[1]?.messages).toEqual([
        ...REQUEST.messages,
        { role: "system", content: EMPTY_ANSWER_REPAIR_MESSAGE },
      ]);
      expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
        "empty-answer-repair",
      ]);
      expect(events.find((event) => event.op === "gateway.stream.failed")).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain("first passage");
    });

    it("surfaces a second empty answer after forwarded reasoning once, marked as the repair's outcome", async () => {
      const events: ModelGatewayLogEvent[] = [];
      const scripted = scriptedStreams([
        [{ type: "reasoning", token: "first passage" }, emptyAfterReasoning()],
        [{ type: "reasoning", token: "second passage" }, emptyAfterReasoning()],
        [{ type: "done", response: toolCallAnswer() }],
      ]);
      const gateway = gatewayFor(scripted, events, config(provider(), true));
      const delivered: GatewayStreamChunk[] = [];

      const failure = await drainInto(gateway.chatStream(CODING_REQUEST), delivered);

      expect(kinds(delivered)).toEqual(["reasoning:first passage", "reasoning:second passage"]);
      expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
      expect(failure).toMatchObject({ outputRepair: "empty-again" });
      expect(scripted.requests).toHaveLength(2);
      expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
        "empty-answer-repair",
      ]);
      expect(events.find((event) => event.op === "gateway.stream.failed")?.extra).toMatchObject({
        afterFirstChunk: true,
        chunkCount: 2,
      });
      expect(gateway.circuitStatus(MODEL)).toMatchObject({
        state: "closed",
        consecutiveFailures: 0,
      });
    });

    it("does not repair an empty answer that carried no reasoning, even on a forwarding call", async () => {
      const events: ModelGatewayLogEvent[] = [];
      const scripted = scriptedStreams([
        [{ type: "reasoning", token: "first passage" }, plainEmpty()],
        [{ type: "done", response: toolCallAnswer() }],
      ]);
      const delivered: GatewayStreamChunk[] = [];

      const failure = await drainInto(
        gatewayFor(scripted, events, config(provider(), true)).chatStream(CODING_REQUEST),
        delivered,
      );

      expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
      expect((failure as GatewayError).outputRepair).toBeUndefined();
      expect(scripted.requests).toHaveLength(1);
      expect(scheduledLines(events)).toEqual([]);
    });
  });
});

// The steer belongs to the call, not to one attempt (#3873, F17, F23): when the repaired attempt
// meets an ordinary provider failure, the provider retry that follows resends the corrected request,
// never the original one the model could not answer.
describe("Gateway steered repair across a provider retry (#3873 F17, F23)", () => {
  const failures = [
    [
      "an exhausted answer",
      (): Error => new ProviderOutputExhaustedError(MODEL),
      OUTPUT_EXHAUSTED_REPAIR_MESSAGE,
      "output-exhausted-repair",
    ],
    [
      "an empty answer after reasoning",
      (): Error => new ProviderEmptyAnswerError(MODEL, [], true),
      EMPTY_ANSWER_REPAIR_MESSAGE,
      "empty-answer-repair",
    ],
  ] as const;

  it.each(failures)(
    "keeps the correction on the buffered provider retry after %s",
    async (_label, failure, correction, reason) => {
      const events: ModelGatewayLogEvent[] = [];
      const scripted = bufferedAdapter([
        failure(),
        new TransportError("fixture connection reset"),
        toolCallAnswer(),
      ]);

      const result = await gatewayFor(scripted, events).chat(REQUEST);

      expect(result.outputRepair).toBe("recovered");
      const steered = [...REQUEST.messages, { role: "system", content: correction }];
      expect(scripted.requests.map((request) => request.messages)).toEqual([
        REQUEST.messages,
        steered,
        steered,
      ]);
      expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
        reason,
        "retryable-error",
      ]);
    },
  );

  it.each(failures)(
    "keeps the correction on the streamed provider retry after %s",
    async (_label, failure, correction, reason) => {
      const events: ModelGatewayLogEvent[] = [];
      const scripted = streamingAdapter([
        failure(),
        new TransportError("fixture connection reset"),
        toolCallAnswer(),
      ]);

      const chunks = await drain(
        gatewayFor(scripted, events, config(provider(), true)).chatStream(REQUEST),
      );

      const done = chunks.at(-1);
      expect(done?.type === "done" ? done.response.outputRepair : undefined).toBe("recovered");
      const steered = [...REQUEST.messages, { role: "system", content: correction }];
      expect(scripted.requests.map((request) => request.messages)).toEqual([
        REQUEST.messages,
        steered,
        steered,
      ]);
      expect(scheduledLines(events).map((event) => event.extra?.reason)).toEqual([
        reason,
        "retryable-error",
      ]);
    },
  );
});

// #3873 review: the steered repair is not part of every chat call. A call that does not ask for it
// (`answerRepair` absent) — the commit draft, interactive chat — surfaces an exhausted or empty
// answer at once, with one provider request and no scheduled repair, as it did before F17.
describe("Gateway steered repair is opt-in (#3873 review)", () => {
  const { answerRepair: _steered, ...UNSTEERED } = REQUEST;
  const failures = [
    ["an exhausted answer", (): Error => new ProviderOutputExhaustedError(MODEL)],
    ["an empty answer after reasoning", (): Error => new ProviderEmptyAnswerError(MODEL, [], true)],
  ] as const;

  it.each(failures)(
    "surfaces %s at once on a buffered call that did not ask for the repair",
    async (_label, failure) => {
      const events: ModelGatewayLogEvent[] = [];
      const scripted = bufferedAdapter([failure(), toolCallAnswer()]);

      const error = await gatewayFor(scripted, events)
        .chat(UNSTEERED)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).outputRepair).toBeUndefined();
      expect(scripted.requests).toHaveLength(1);
      expect(scheduledLines(events)).toEqual([]);
    },
  );

  it.each(failures)(
    "surfaces %s at once on a streamed call that did not ask for the repair",
    async (_label, failure) => {
      const events: ModelGatewayLogEvent[] = [];
      const scripted = streamingAdapter([failure(), toolCallAnswer()]);

      const error = await drain(
        gatewayFor(scripted, events, config(provider(), true)).chatStream(UNSTEERED),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).outputRepair).toBeUndefined();
      expect(scripted.requests).toHaveLength(1);
      expect(scheduledLines(events)).toEqual([]);
    },
  );
});

// A catalog rejection of an offered tool that carries its schema correction, like the bridge raises.
function catalogRejection(toolCallId: string, invalidPath: string): GatewayToolCatalogError {
  return new GatewayToolCatalogError("invalid-arguments", undefined, true, {
    toolCallId,
    offeredAlias: "keiko_workspace_read",
    shape: {
      missingRequired: [],
      invalidPaths: [invalidPath],
      unexpectedPropertyCount: 0,
      droppedPathCount: 0,
    },
  });
}

// #3873 review: the schema correction of a buffered call is decided when the attempt that carries it
// starts, on the retry loop's own attempt count. A steered repair sits on top of the provider's
// attempts, so a call that exhausts once and then repeats an invalid tool call gets a correction
// for EVERY rejection the loop retries — never a stale one re-sent with a repair line that claims a
// correction that was not sent.
describe("Gateway schema correction after a steered repair (#3873 review)", () => {
  it("corrects each rejection the loop retries, on the provider's attempt count", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const scripted = bufferedAdapter([
      new ProviderOutputExhaustedError(MODEL),
      catalogRejection("call-a", "path.first"),
      catalogRejection("call-b", "path.second"),
      catalogRejection("call-c", "path.third"),
    ]);

    const failure = await gatewayFor(scripted, events)
      .chat(REQUEST)
      .catch((error: unknown) => error);

    // maxRetries 2: three provider attempts plus the one steered repair, then the rejection surfaces.
    expect(failure).toBeInstanceOf(GatewayToolCatalogError);
    expect(scripted.requests).toHaveLength(4);
    const corrections = scripted.requests.map((request) => request.messages.at(-1)?.content ?? "");
    expect(corrections[1]).toBe(OUTPUT_EXHAUSTED_REPAIR_MESSAGE);
    expect(corrections[2]).toContain("path.first");
    expect(corrections[3]).toContain("path.second");
    const repairs = events.filter((event) => event.op === "gateway.tool-catalog.repair");
    expect(repairs.map((event) => [event.extra?.state, event.extra?.toolCallId])).toEqual([
      ["scheduled", "call-a"],
      ["scheduled", "call-b"],
    ]);
    expect(
      expectActivityLogProof(
        "gateway.tool-catalog.repair.emitted-line",
        formatActivityLogProofLine(repairs[1] ?? {}),
      ),
    ).toMatchObject({ state: "scheduled", toolCallId: "call-b" });
    expect(events.find((event) => event.op === "gateway.retry.exhausted")?.extra).toMatchObject({
      reason: "max-retries",
    });
  });
});

// #3873 review: the attempts a call discarded — a steered repair's first answer, a rejected tool
// call, a stream that failed after its usage arrived — were processed by the provider. Their
// reported usage rides on the answer as `discardedAttemptUsage`, so the coding run's prompt
// allowance can count them; `usage` keeps describing the answer itself.
describe("Gateway discarded attempt usage (#3873 review)", () => {
  function exhaustedWithUsage(promptTokens: number, completionTokens: number): Error {
    const error = new ProviderOutputExhaustedError(MODEL);
    error.partialUsage = { promptTokens, completionTokens, streamedChars: 0 };
    return error;
  }

  it("reports the usage of the repaired buffered attempt beside the answer's own", async () => {
    const scripted = bufferedAdapter([exhaustedWithUsage(1_200, 8_192), toolCallAnswer()]);

    const result = await gatewayFor(scripted, []).chat(REQUEST);

    expect(result.usage).toMatchObject({ promptTokens: 20, completionTokens: 30 });
    expect(result.discardedAttemptUsage).toEqual({
      attemptCount: 1,
      promptTokens: 1_200,
      completionTokens: 8_192,
    });
  });

  it("reports the usage of the repaired streamed attempt on the done chunk", async () => {
    const scripted = streamingAdapter([exhaustedWithUsage(900, 4_000), toolCallAnswer()]);

    const chunks = await drain(
      gatewayFor(scripted, [], config(provider(), true)).chatStream(REQUEST),
    );

    const done = chunks.at(-1);
    expect(done?.type === "done" ? done.response.discardedAttemptUsage : undefined).toEqual({
      attemptCount: 1,
      promptTokens: 900,
      completionTokens: 4_000,
    });
  });

  it("adds nothing for an attempt that failed before the provider reported usage", async () => {
    const scripted = bufferedAdapter([new TransportError("refused"), toolCallAnswer()]);

    const result = await gatewayFor(scripted, []).chat(REQUEST);

    expect(result.discardedAttemptUsage).toBeUndefined();
  });
});
