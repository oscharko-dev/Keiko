import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import {
  AuthenticationError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  UnknownModelError,
  type GatewayCallRequest,
  type GatewayStreamChunk,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  captureConversationReadinessAdmission,
  conversationModelNotReadyResult,
  mappedConversationReadinessError,
  ConversationModelNotReadyError,
  type ConversationReadinessAdmission,
  withConversationReadinessAdmission,
} from "./conversation-readiness-admission.js";
import {
  CONVERSATION_READINESS_CACHED_AFTER_MS,
  currentConversationReady,
  type UiHandlerDeps,
  type VerifiedModelCapabilityObservation,
} from "./deps.js";

function doneResponse(): NormalizedResponse {
  return {
    modelId: "stream-model",
    content: "hello",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "admission-test",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

// A receiver-dependent ModelPort exactly like the production GatewayModelPort: callStream is a
// PROTOTYPE method reading instance state through `this`. Class bodies are strict mode, so an
// unbound extraction throws a TypeError on the first next() — the defect this file pins.
class ReceiverBoundPort implements ModelPort {
  private readonly chunks: readonly GatewayStreamChunk[];

  public constructor(chunks: readonly GatewayStreamChunk[]) {
    this.chunks = chunks;
  }

  public call(): Promise<NormalizedResponse> {
    return Promise.resolve(doneResponse());
  }

  public async *callStream(
    _request: GatewayRequest,
    _signal: AbortSignal,
  ): AsyncIterable<GatewayStreamChunk> {
    for (const chunk of this.chunks) {
      yield await Promise.resolve(chunk);
    }
  }
}

function readyDeps(generation: number): Pick<UiHandlerDeps, "gatewayConfig"> {
  const checkedAt = new Date().toISOString();
  return {
    gatewayConfig: {
      storagePath: "/dev/null",
      current: () => undefined,
      present: () => true,
      set: () => undefined,
      verification: () => UNVERIFIED_GATEWAY,
      generation: () => generation,
      recordVerification: () => undefined,
      verifiedCapability: () => ({
        modelId: "stream-model",
        generation,
        checkedAt,
        fields: { conversationReady: true },
      }),
      recordVerifiedCapability: () => undefined,
      clearVerifiedCapability: () => false,
    },
  };
}

describe("withConversationReadinessAdmission — streaming receiver", () => {
  it("forwards callStream with its original receiver instead of throwing TypeError", async () => {
    const chunks: readonly GatewayStreamChunk[] = [
      { type: "delta", token: "hello" },
      { type: "done", response: doneResponse() },
    ];
    const deps = readyDeps(3);
    const admission = captureConversationReadinessAdmission(deps, "stream-model");
    if ("status" in admission) throw new Error("expected fresh test model admission");
    expect(admission.gatewayConfigGeneration).toBe(deps.gatewayConfig?.generation());
    const wrapped = withConversationReadinessAdmission(
      new ReceiverBoundPort(chunks),
      "stream-model",
      admission,
      deps,
    );

    const stream = wrapped.callStream;
    expect(stream).toBeDefined();
    if (stream === undefined) return;
    const seen: GatewayStreamChunk[] = [];
    for await (const chunk of stream(
      { modelId: "stream-model", messages: [] },
      new AbortController().signal,
    )) {
      seen.push(chunk);
    }
    expect(seen).toEqual(chunks);
  });
});

const ADMITTED_MODEL = "stream-model";
const TURN_STARTED_AT = Date.parse("2026-10-13T12:00:00.000Z");
const ADMITTED_REQUEST: GatewayCallRequest = { modelId: ADMITTED_MODEL, messages: [] };

interface MutableReadiness {
  generation: number;
  globalWrites: number;
  observation: VerifiedModelCapabilityObservation | undefined;
}

function currentReadyDeps(state: MutableReadiness): Pick<UiHandlerDeps, "gatewayConfig"> {
  return {
    gatewayConfig: {
      storagePath: "/dev/null",
      current: () => undefined,
      present: () => true,
      set: () => undefined,
      verification: () => UNVERIFIED_GATEWAY,
      generation: () => state.generation,
      recordVerification: () => undefined,
      verifiedCapability: () => state.observation,
      recordVerifiedCapability: (
        modelId,
        fields,
        checkedAt,
        generation,
        conversationCheckedAt,
      ): void => {
        state.globalWrites += 1;
        if (generation !== undefined && generation !== state.generation) return;
        state.observation = {
          modelId,
          fields,
          checkedAt,
          generation: state.generation,
          ...(conversationCheckedAt === undefined ? {} : { conversationCheckedAt }),
        };
      },
      clearVerifiedCapability: () => false,
    },
  };
}

function expiredClock(): void {
  vi.setSystemTime(Date.now() + CONVERSATION_READINESS_CACHED_AFTER_MS + 1);
}

function completedLongResponse(): Promise<NormalizedResponse> {
  expiredClock();
  return Promise.resolve(doneResponse());
}

class ContinuationPort implements ModelPort {
  public bufferedCalls = 0;
  public streamedCalls = 0;
  public readonly signals: AbortSignal[] = [];
  private readonly respond: () => Promise<NormalizedResponse>;
  private readonly chunks: () => AsyncIterable<GatewayStreamChunk>;

  public constructor(
    respond: () => Promise<NormalizedResponse> = completedLongResponse,
    chunks: () => AsyncIterable<GatewayStreamChunk> = completedLongStream,
  ) {
    this.respond = respond;
    this.chunks = chunks;
  }

  public call(_request: GatewayRequest, signal: AbortSignal): Promise<NormalizedResponse> {
    this.bufferedCalls += 1;
    this.signals.push(signal);
    return this.respond();
  }

  public async *callStream(
    _request: GatewayRequest,
    signal: AbortSignal,
  ): AsyncIterable<GatewayStreamChunk> {
    this.streamedCalls += 1;
    this.signals.push(signal);
    yield* this.chunks();
  }
}

async function* completedLongStream(): AsyncIterable<GatewayStreamChunk> {
  expiredClock();
  yield await Promise.resolve({ type: "delta", token: "hello" } as const);
  yield await Promise.resolve({ type: "done", response: doneResponse() } as const);
}

function continuationFixture(port: ModelPort = new ContinuationPort()): {
  readonly state: MutableReadiness;
  readonly deps: Pick<UiHandlerDeps, "gatewayConfig">;
  readonly admission: ConversationReadinessAdmission;
  readonly wrapped: ModelPort;
} {
  const state: MutableReadiness = {
    generation: 3,
    globalWrites: 0,
    observation: {
      modelId: ADMITTED_MODEL,
      generation: 3,
      checkedAt: new Date().toISOString(),
      fields: { conversationReady: true },
    },
  };
  const deps = currentReadyDeps(state);
  const admission = captureConversationReadinessAdmission(deps, ADMITTED_MODEL);
  if ("status" in admission) throw new TypeError("Expected genuine fresh admission");
  return {
    state,
    deps,
    admission,
    wrapped: withConversationReadinessAdmission(port, ADMITTED_MODEL, admission, deps),
  };
}

async function callBuffered(
  wrapped: ModelPort,
  signal: AbortSignal = new AbortController().signal,
  request: GatewayCallRequest = ADMITTED_REQUEST,
): Promise<NormalizedResponse> {
  return wrapped.call(request, signal);
}

function requiredStream(wrapped: ModelPort): AsyncIterator<GatewayStreamChunk> {
  const stream = wrapped.callStream;
  if (stream === undefined) throw new TypeError("Expected actual streaming ModelPort");
  return stream(ADMITTED_REQUEST, new AbortController().signal)[Symbol.asyncIterator]();
}

function changedObservation(
  prior: VerifiedModelCapabilityObservation,
  change: string,
): VerifiedModelCapabilityObservation {
  const future = new Date(TURN_STARTED_AT + 1).toISOString();
  switch (change) {
    case "failed-probe":
      return { ...prior, fields: { conversationReady: false } };
    case "observation-generation":
      return { ...prior, generation: prior.generation - 1 };
    case "observation-model":
      return { ...prior, modelId: "other-model" };
    case "malformed":
      return { ...prior, checkedAt: "invalid" };
    case "future":
      return { ...prior, checkedAt: future };
    case "malformed-conversation-time":
      return { ...prior, conversationCheckedAt: "invalid" };
    case "future-conversation-time":
      return { ...prior, conversationCheckedAt: future };
    default:
      return prior;
  }
}

describe("configuration-bound readiness without request-time model probes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TURN_STARTED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetServerLogger();
  });

  // ADR-0171, owner amendment 2026-11-05: age is diagnostic, generation remains authoritative.
  it("reuses an old startup success across turns without changing its evidence", async () => {
    const port = new ContinuationPort();
    const fixture = continuationFixture(port);
    const observation = fixture.state.observation;
    expiredClock();
    await expect(callBuffered(fixture.wrapped)).resolves.toEqual(doneResponse());
    const nextTurn = withConversationReadinessAdmission(
      port,
      ADMITTED_MODEL,
      fixture.admission,
      fixture.deps,
    );
    await expect(callBuffered(nextTurn)).resolves.toEqual(doneResponse());
    expect(port.bufferedCalls).toBe(2);
    expect(fixture.state.observation).toEqual(observation);
    expect(fixture.state.globalWrites).toBe(0);
    expect(currentConversationReady(fixture.deps, ADMITTED_MODEL)).toBe(true);
  });

  it.each([
    "failed-probe",
    "cleared",
    "generation",
    "observation-generation",
    "observation-model",
    "model",
    "malformed",
    "future",
    "malformed-conversation-time",
    "future-conversation-time",
  ] as const)("still denies %s before provider work", async (change) => {
    const port = new ContinuationPort();
    const { state, wrapped } = continuationFixture(port);
    const prior = state.observation;
    if (prior === undefined) throw new TypeError("Expected fixture observation");
    if (change === "cleared") state.observation = undefined;
    else if (change === "generation") state.generation += 1;
    else state.observation = changedObservation(prior, change);
    const request =
      change === "model" ? { ...ADMITTED_REQUEST, modelId: "other-model" } : ADMITTED_REQUEST;
    await expect(callBuffered(wrapped, undefined, request)).rejects.toBeInstanceOf(
      ConversationModelNotReadyError,
    );
    expect(port.bufferedCalls).toBe(0);
  });

  it("rejects a wrapper-model mismatch before provider work", async () => {
    const port = new ContinuationPort();
    const { admission, deps } = continuationFixture(port);
    const wrapped = withConversationReadinessAdmission(port, "other-model", admission, deps);
    await expect(
      callBuffered(wrapped, undefined, { ...ADMITTED_REQUEST, modelId: "other-model" }),
    ).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
  });

  it("honours cancellation without provider work", async () => {
    const port = new ContinuationPort();
    const { wrapped } = continuationFixture(port);
    const controller = new AbortController();
    controller.abort();
    await expect(callBuffered(wrapped, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(port.bufferedCalls).toBe(0);
  });

  it("keeps the original streaming receiver and signal after a long idle", async () => {
    const port = new ContinuationPort();
    const { wrapped } = continuationFixture(port);
    expiredClock();
    const iterator = requiredStream(wrapped);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "delta" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "done" } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(port.streamedCalls).toBe(1);
  });

  it("reports actual provider errors without inserting a test request", async () => {
    const port = new ContinuationPort(() =>
      Promise.reject(new TypeError("Fixture provider unavailable")),
    );
    const { wrapped } = continuationFixture(port);
    expiredClock();
    await expect(callBuffered(wrapped)).rejects.toThrow("Fixture provider unavailable");
    expect(port.bufferedCalls).toBe(1);
  });

  it("emits body-free fresh, cached and refused admission evidence", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const port = new ContinuationPort(() =>
      Promise.resolve({ ...doneResponse(), content: "PRIVATE_READINESS_RESPONSE_BODY" }),
    );
    const { wrapped, state } = continuationFixture(port);
    const request: GatewayCallRequest = {
      ...ADMITTED_REQUEST,
      messages: [{ role: "user", content: "PRIVATE_READINESS_REQUEST_BODY" }],
      logContext: { correlationId: "readiness-cache-proof" },
    };
    await callBuffered(wrapped, undefined, request);
    expiredClock();
    await callBuffered(wrapped, undefined, request);
    state.observation = undefined;
    await expect(callBuffered(wrapped, undefined, request)).rejects.toBeInstanceOf(
      ConversationModelNotReadyError,
    );
    const events = sink.events.filter((event) => event.op === "gateway.conversation.admission");
    expect(events.map((event) => event.extra?.disposition)).toEqual([
      "allowed-fresh",
      "allowed-cached",
      "observation-unavailable",
    ]);
    for (const event of events) {
      expectActivityLogProof(
        "gateway.conversation.admission.line",
        formatActivityLogProofLine(event),
      );
      expect(event).toMatchObject({ correlationId: "readiness-cache-proof" });
    }
    const analyzed = analyzeLogText(events.map(formatActivityLogProofLine).join(""));
    expect(analyzed.evidence).toMatchObject({
      classification: "supported",
      corruptLineCount: 0,
      supportedLineCount: 3,
    });
    expect(
      analyzed.timelines
        .find((timeline) => timeline.correlationId === "readiness-cache-proof")
        ?.lines.map((line) => line.extra?.disposition),
    ).toEqual(["allowed-fresh", "allowed-cached", "observation-unavailable"]);
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_READINESS_REQUEST_BODY");
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_READINESS_RESPONSE_BODY");
    expect(port.bufferedCalls).toBe(2);
  });
});

it("keeps the shared tool-calling refusal clear for every connected tool without prescribing repeated checks", () => {
  const error = new ConversationModelNotReadyError("tool-calling");
  const expected =
    "The selected model cannot use the connected tools. Choose a model with tool calling.";
  expect(error.message).toBe(expected);
  const result = conversationModelNotReadyResult("tool-calling");
  expect(result).toEqual({
    status: 400,
    body: { error: { code: "CONVERSATION_UNAVAILABLE_MODEL", message: expected } },
  });
  expect(mappedConversationReadinessError(error)).toEqual(result);
  expect(error.message).not.toMatch(/Jira|Settings|check|disconnect/iu);
});

it.each([
  [
    "authentication",
    (): AuthenticationError => new AuthenticationError("synthetic rejected credential"),
  ],
  ["missing-model", (): ProviderError => new ProviderError("synthetic missing model", 404)],
  ["unknown-model", (): UnknownModelError => new UnknownModelError("synthetic unknown model")],
] as const)(
  "withdraws readiness after an actual %s answer without another probe",
  async (_label, failure) => {
    const error = failure();
    const dispatch = vi.fn(() => Promise.reject(error));
    const fixture = continuationFixture({ call: dispatch });
    await expect(callBuffered(fixture.wrapped)).rejects.toBe(error);
    expect(fixture.state.observation?.fields.conversationReady).toBe(false);
    expect(fixture.state.globalWrites).toBe(1);
    await expect(callBuffered(fixture.wrapped)).rejects.toBeInstanceOf(
      ConversationModelNotReadyError,
    );
    expect(dispatch).toHaveBeenCalledOnce();
  },
);

it.each([
  (): RateLimitError => new RateLimitError("synthetic rate limit"),
  (): TimeoutError => new TimeoutError("synthetic timeout"),
  (): ProviderError => new ProviderError("synthetic unavailable", 503),
  (): ProviderError => new ProviderError("synthetic validation", 400),
])("keeps a ready observation after transient or request-specific failure", async (failure) => {
  const error = failure();
  const dispatch = vi.fn(() => Promise.reject(error));
  const fixture = continuationFixture({ call: dispatch });
  const observation = fixture.state.observation;
  await expect(callBuffered(fixture.wrapped)).rejects.toBe(error);
  expect(fixture.state.observation).toBe(observation);
  expect(fixture.state.globalWrites).toBe(0);
});

it.each(["generation", "observation"] as const)(
  "does not overwrite a newer %s with a late provider refusal",
  async (replacement) => {
    let rejectCall: (error: unknown) => void = () => undefined;
    const pending = new Promise<NormalizedResponse>((_resolve, reject) => {
      rejectCall = reject;
    });
    const fixture = continuationFixture({ call: () => pending });
    const call = callBuffered(fixture.wrapped);
    const error = new AuthenticationError("synthetic late credential refusal");
    const rejected = expect(call).rejects.toBe(error);
    if (replacement === "generation") fixture.state.generation += 1;
    else {
      const previous = fixture.state.observation;
      if (previous === undefined) throw new TypeError("Expected observation");
      fixture.state.observation = { ...previous, fields: { ...previous.fields } };
    }
    rejectCall(error);
    await rejected;
    expect(fixture.state.observation?.fields.conversationReady).toBe(true);
    expect(fixture.state.globalWrites).toBe(0);
  },
);

it("withdraws streamed readiness after a definitive provider refusal", async () => {
  const error = new ProviderError("synthetic removed model", 404);
  const fixture = continuationFixture({
    call: () => Promise.resolve(doneResponse()),
    callStream: async function* () {
      yield await Promise.reject(error);
    },
  });
  const stream = fixture.wrapped.callStream;
  if (stream === undefined) throw new TypeError("Expected stream");
  await expect(async () => {
    for await (const _chunk of stream(ADMITTED_REQUEST, new AbortController().signal)) {
      /* consume */
    }
  }).rejects.toBe(error);
  expect(fixture.state.observation?.fields.conversationReady).toBe(false);
  expect(fixture.state.globalWrites).toBe(1);
});

it("names explicit Settings verification with a closed readiness refusal and zero provider calls", async () => {
  const dispatch = vi.fn(() => Promise.resolve(doneResponse()));
  const fixture = continuationFixture({ call: dispatch });
  const observation = fixture.state.observation;
  if (observation === undefined) throw new TypeError("Expected observation");
  fixture.state.observation = { ...observation, fields: { conversationReady: false } };
  const result = captureConversationReadinessAdmission(fixture.deps, ADMITTED_MODEL);
  expect(result).toMatchObject({
    status: 400,
    body: { error: { code: "CONVERSATION_MODEL_NOT_READY" } },
  });
  expect(JSON.stringify(result)).toContain("Settings > Models");
  await expect(callBuffered(fixture.wrapped)).rejects.toBeInstanceOf(
    ConversationModelNotReadyError,
  );
  expect(dispatch).not.toHaveBeenCalled();
});
