import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type { GatewayCallRequest, GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";
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
  ConversationModelNotReadyError,
  type ConversationReadinessAdmission,
  withConversationReadinessAdmission,
} from "./conversation-readiness-admission.js";
import {
  CONVERSATION_READINESS_MAX_AGE_MS,
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
      recordVerifiedCapability: (): void => {
        state.globalWrites += 1;
      },
      clearVerifiedCapability: () => false,
    },
  };
}

function expiredClock(): void {
  vi.setSystemTime(Date.now() + CONVERSATION_READINESS_MAX_AGE_MS + 1);
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
    await expect(callBuffered(wrapped, controller.signal)).rejects.toBeDefined();
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
