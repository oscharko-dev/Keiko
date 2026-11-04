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

async function completedBufferedFixture(): Promise<{
  readonly fixture: ReturnType<typeof continuationFixture>;
  readonly port: ContinuationPort;
}> {
  const port = new ContinuationPort();
  const fixture = continuationFixture(port);
  expect(currentConversationReady(fixture.deps, ADMITTED_MODEL)).toBe(true);
  await expect(callBuffered(fixture.wrapped)).resolves.toEqual(doneResponse());
  expect(port.bufferedCalls).toBe(1);
  expect(currentConversationReady(fixture.deps, ADMITTED_MODEL)).toBe(false);
  return { fixture, port };
}

describe("bounded readiness continuation after successful completion", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TURN_STARTED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetServerLogger();
  });

  it("permits the same turn's bounded next call after a completed synthesis spans freshness", async () => {
    const { fixture, port } = await completedBufferedFixture();
    const observation = fixture.state.observation;
    const signal = new AbortController().signal;
    await expect(callBuffered(fixture.wrapped, signal)).resolves.toEqual(doneResponse());
    expect(port.bufferedCalls).toBe(2);
    expect(port.signals.at(-1)).toBe(signal);
    expect(fixture.state.observation).toEqual(observation);
    expect(fixture.state.globalWrites).toBe(0);
    expect(currentConversationReady(fixture.deps, ADMITTED_MODEL)).toBe(false);
  });

  it("requires a fresh first call on a new wrapper even after another wrapper completed", async () => {
    const { fixture, port } = await completedBufferedFixture();
    const fresh = withConversationReadinessAdmission(
      port,
      ADMITTED_MODEL,
      fixture.admission,
      fixture.deps,
    );
    await expect(callBuffered(fresh)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(1);
    expect(captureConversationReadinessAdmission(fixture.deps, ADMITTED_MODEL)).toMatchObject({
      status: 400,
    });
  });

  it("rejects an expired first call before any provider work", async () => {
    const port = new ContinuationPort();
    const { wrapped } = continuationFixture(port);
    expiredClock();
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
  });

  it("expires the private completion witness at the same bounded freshness interval", async () => {
    const { fixture, port } = await completedBufferedFixture();
    expiredClock();
    await expect(callBuffered(fixture.wrapped)).rejects.toBeInstanceOf(
      ConversationModelNotReadyError,
    );
    expect(port.bufferedCalls).toBe(1);
  });

  it.each(["failed-probe", "cleared", "generation", "model", "malformed", "future"] as const)(
    "rejects %s instead of treating it as an aging positive observation",
    async (change) => {
      const { fixture, port } = await completedBufferedFixture();
      const prior = fixture.state.observation;
      if (prior === undefined) throw new TypeError("Expected retained positive observation");
      if (change === "failed-probe")
        fixture.state.observation = { ...prior, fields: { conversationReady: false } };
      if (change === "cleared") fixture.state.observation = undefined;
      if (change === "generation") fixture.state.generation += 1;
      if (change === "model")
        fixture.state.observation = { ...prior, modelId: "replacement-model" };
      if (change === "malformed")
        fixture.state.observation = { ...prior, conversationCheckedAt: "invalid-time" };
      if (change === "future")
        fixture.state.observation = {
          ...prior,
          conversationCheckedAt: new Date(Date.now() + 1).toISOString(),
        };
      await expect(callBuffered(fixture.wrapped)).rejects.toBeInstanceOf(
        ConversationModelNotReadyError,
      );
      expect(port.bufferedCalls).toBe(1);
    },
  );

  it("rejects a request-model mismatch even while the admitted model is fresh", async () => {
    const port = new ContinuationPort();
    const { wrapped } = continuationFixture(port);
    await expect(
      callBuffered(wrapped, undefined, { ...ADMITTED_REQUEST, modelId: "other-model" }),
    ).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
  });

  it("rejects a wrapper-model mismatch before a fresh dispatch", async () => {
    const port = new ContinuationPort();
    const { admission, deps } = continuationFixture(port);
    const wrapped = withConversationReadinessAdmission(port, "other-model", admission, deps);
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
  });

  it("does not invoke a port for an already cancelled request", async () => {
    const port = new ContinuationPort();
    const { wrapped } = continuationFixture(port);
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled fixture", "AbortError"));
    await expect(callBuffered(wrapped, controller.signal)).rejects.toThrow();
    expect(port.bufferedCalls).toBe(0);
  });

  it("does not derive continuation from a failed first call", async () => {
    const port = new ContinuationPort(() => {
      expiredClock();
      return Promise.reject(new Error("Fixture provider failure"));
    });
    const { wrapped } = continuationFixture(port);
    await expect(callBuffered(wrapped)).rejects.toThrow("Fixture provider failure");
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(1);
  });

  it("does not derive continuation from a first call cancelled before completion", async () => {
    const controller = new AbortController();
    const port = new ContinuationPort(() => {
      expiredClock();
      const failure = new DOMException("Cancelled fixture", "AbortError");
      controller.abort(failure);
      return Promise.reject(failure);
    });
    const { wrapped } = continuationFixture(port);
    await expect(callBuffered(wrapped, controller.signal)).rejects.toThrow("Cancelled fixture");
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(1);
  });

  it("does not derive continuation from a response for a different model", async () => {
    const port = new ContinuationPort(() => {
      expiredClock();
      return Promise.resolve({ ...doneResponse(), modelId: "replacement-model" });
    });
    const { wrapped } = continuationFixture(port);
    await expect(callBuffered(wrapped)).resolves.toMatchObject({ modelId: "replacement-model" });
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(1);
  });

  it("rejects a private completion witness from a future clock after rollback", async () => {
    const { fixture, port } = await completedBufferedFixture();
    vi.setSystemTime(Date.now() - 1);
    expect(currentConversationReady(fixture.deps, ADMITTED_MODEL)).toBe(false);
    await expect(callBuffered(fixture.wrapped)).rejects.toBeInstanceOf(
      ConversationModelNotReadyError,
    );
    expect(port.bufferedCalls).toBe(1);
  });

  it("does not derive continuation when an aborted call resolves successfully", async () => {
    const controller = new AbortController();
    const port = new ContinuationPort(() => {
      expiredClock();
      controller.abort(new DOMException("Cancelled fixture", "AbortError"));
      return Promise.resolve(doneResponse());
    });
    const { wrapped } = continuationFixture(port);
    await expect(callBuffered(wrapped, controller.signal)).resolves.toEqual(doneResponse());
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(1);
  });

  it("recognizes a genuinely completed done stream with its receiver preserved", async () => {
    const port = new ContinuationPort();
    const { wrapped, deps } = continuationFixture(port);
    const stream = requiredStream(wrapped);
    expect(await stream.next()).toMatchObject({ value: { type: "delta" }, done: false });
    expect(await stream.next()).toMatchObject({
      value: { type: "done", response: doneResponse() },
      done: false,
    });
    expect(await stream.next()).toMatchObject({ done: true });
    await expect(callBuffered(wrapped)).resolves.toEqual(doneResponse());
    expect(port.streamedCalls).toBe(1);
    expect(port.bufferedCalls).toBe(1);
    expect(currentConversationReady(deps, ADMITTED_MODEL)).toBe(false);
  });

  it.each([
    ["buffered", "error"],
    ["buffered", "cancelled"],
    ["buffered", "content_filter"],
    ["streamed", "error"],
    ["streamed", "cancelled"],
    ["streamed", "content_filter"],
  ] as const)(
    "does not renew continuation after a completed %s response marked %s",
    async (mode, finishReason) => {
      const response: NormalizedResponse = { ...doneResponse(), finishReason };
      const port = new ContinuationPort(
        () => {
          expiredClock();
          return Promise.resolve(response);
        },
        async function* (): AsyncIterable<GatewayStreamChunk> {
          expiredClock();
          yield await Promise.resolve({ type: "delta", token: "hello" } as const);
          yield await Promise.resolve({ type: "done", response } as const);
        },
      );
      const { wrapped, deps } = continuationFixture(port);
      if (mode === "buffered") await expect(callBuffered(wrapped)).resolves.toEqual(response);
      else {
        const stream = wrapped.callStream;
        if (stream === undefined) throw new TypeError("Expected actual streaming ModelPort");
        const chunks: GatewayStreamChunk[] = [];
        for await (const chunk of stream(ADMITTED_REQUEST, new AbortController().signal)) {
          chunks.push(chunk);
        }
        expect(chunks).toEqual([
          { type: "delta", token: "hello" },
          { type: "done", response },
        ]);
      }
      expect(currentConversationReady(deps, ADMITTED_MODEL)).toBe(false);
      expect(port.bufferedCalls + port.streamedCalls).toBe(1);
      await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
      expect(port.bufferedCalls + port.streamedCalls).toBe(1);
    },
  );

  it("does not derive continuation from an unfinished stream", async () => {
    const port = new ContinuationPort();
    const { wrapped } = continuationFixture(port);
    const stream = requiredStream(wrapped);
    expect(await stream.next()).toMatchObject({ value: { type: "delta" }, done: false });
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
    await stream.return?.();
  });

  it("does not derive continuation from an early end without a done response", async () => {
    const port = new ContinuationPort(
      undefined,
      async function* (): AsyncIterable<GatewayStreamChunk> {
        expiredClock();
        yield await Promise.resolve({ type: "delta", token: "hello" } as const);
      },
    );
    const { wrapped } = continuationFixture(port);
    const stream = requiredStream(wrapped);
    await stream.next();
    expect(await stream.next()).toMatchObject({ done: true });
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
  });

  it("does not derive continuation from a stream that fails before done", async () => {
    const port = new ContinuationPort(
      undefined,
      async function* (): AsyncIterable<GatewayStreamChunk> {
        expiredClock();
        yield await Promise.resolve({ type: "delta", token: "hello" } as const);
        throw new Error("Fixture stream failure");
      },
    );
    const { wrapped } = continuationFixture(port);
    const stream = requiredStream(wrapped);
    await stream.next();
    await expect(stream.next()).rejects.toThrow("Fixture stream failure");
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
  });
  it("formats correlated fresh and bounded-continuation admissions without request or answer bodies", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const port = new ContinuationPort(() => {
      expiredClock();
      return Promise.resolve({ ...doneResponse(), content: "PRIVATE_READINESS_RESPONSE_BODY" });
    });
    const { wrapped } = continuationFixture(port);
    const request: GatewayCallRequest = {
      ...ADMITTED_REQUEST,
      messages: [{ role: "user", content: "PRIVATE_READINESS_REQUEST_BODY" }],
      logContext: { correlationId: "readiness-continuation-proof" },
    };
    await callBuffered(wrapped, undefined, request);
    await callBuffered(wrapped, undefined, request);
    expiredClock();
    await expect(callBuffered(wrapped, undefined, request)).rejects.toBeInstanceOf(
      ConversationModelNotReadyError,
    );
    const events = sink.events.filter((event) => event.op === "gateway.conversation.admission");
    expect(events.map((event) => event.extra?.disposition)).toEqual([
      "allowed-fresh",
      "allowed-continuation",
      "expired",
    ]);
    for (const event of events) {
      expectActivityLogProof(
        "gateway.conversation.admission.line",
        formatActivityLogProofLine(event),
      );
      expect(event).toMatchObject({ correlationId: "readiness-continuation-proof" });
    }
    const report = analyzeLogText(events.map(formatActivityLogProofLine).join(""));
    expect(report.evidence).toMatchObject({
      classification: "supported",
      corruptLineCount: 0,
      supportedLineCount: 3,
    });
    expect(
      report.timelines
        .find((timeline) => timeline.correlationId === "readiness-continuation-proof")
        ?.lines.map((line) => line.extra?.disposition),
    ).toEqual(["allowed-fresh", "allowed-continuation", "expired"]);
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_READINESS_REQUEST_BODY");
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_READINESS_RESPONSE_BODY");
    expect(port.bufferedCalls).toBe(2);
  });
});

describe("an expired turn call is checked once more when the caller can check (#4173)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TURN_STARTED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetServerLogger();
  });

  function rechecked(
    port: ContinuationPort,
    recheck: (state: MutableReadiness) => Promise<void>,
  ): { readonly state: MutableReadiness; readonly wrapped: ModelPort; readonly calls: string[] } {
    const fixture = continuationFixture(port);
    const calls: string[] = [];
    const wrapped = withConversationReadinessAdmission(
      port,
      ADMITTED_MODEL,
      fixture.admission,
      fixture.deps,
      async (modelId) => {
        calls.push(modelId);
        await recheck(fixture.state);
      },
    );
    return { state: fixture.state, wrapped, calls };
  }
  function freshObservation(state: MutableReadiness): void {
    state.observation = {
      modelId: ADMITTED_MODEL,
      generation: state.generation,
      checkedAt: new Date().toISOString(),
      fields: { conversationReady: true },
    };
  }

  it("continues a turn whose failed calls outlasted freshness once the check answers ready", async () => {
    // The 2026-11-01 S08 sequence: the model's calls failed, so no completion witness exists, and the
    // next call of the same turn arrives after the freshness interval.
    const port = new ContinuationPort(() => {
      expiredClock();
      return Promise.reject(new Error("Fixture provider failure"));
    });
    const { wrapped, calls } = rechecked(port, (state) => {
      freshObservation(state);
      return Promise.resolve();
    });
    await expect(callBuffered(wrapped)).rejects.toThrow("Fixture provider failure");
    await expect(callBuffered(wrapped)).rejects.toThrow("Fixture provider failure");
    expect(calls).toEqual([ADMITTED_MODEL]);
    expect(port.bufferedCalls).toBe(2);
  });

  it("still refuses before any provider work when the check leaves the model unconfirmed", async () => {
    const port = new ContinuationPort();
    const { wrapped, calls } = rechecked(port, () => Promise.resolve());
    expiredClock();
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(calls).toEqual([ADMITTED_MODEL]);
    expect(port.bufferedCalls).toBe(0);
  });

  it("still refuses when the check answers not ready", async () => {
    const port = new ContinuationPort();
    const { wrapped } = rechecked(port, (state) => {
      freshObservation(state);
      const observation = state.observation;
      if (observation !== undefined)
        state.observation = { ...observation, fields: { conversationReady: false } };
      return Promise.resolve();
    });
    expiredClock();
    await expect(callBuffered(wrapped)).rejects.toBeInstanceOf(ConversationModelNotReadyError);
    expect(port.bufferedCalls).toBe(0);
  });

  it.each(["failed-probe", "generation", "model"] as const)(
    "never checks again for %s, which is no mere expiry",
    async (change) => {
      const port = new ContinuationPort();
      const { state, wrapped, calls } = rechecked(port, (current) => {
        freshObservation(current);
        return Promise.resolve();
      });
      const prior = state.observation;
      if (prior === undefined) throw new TypeError("Expected positive observation");
      if (change === "failed-probe")
        state.observation = { ...prior, fields: { conversationReady: false } };
      if (change === "generation") state.generation += 1;
      const request =
        change === "model" ? { ...ADMITTED_REQUEST, modelId: "other-model" } : ADMITTED_REQUEST;
      await expect(callBuffered(wrapped, undefined, request)).rejects.toBeInstanceOf(
        ConversationModelNotReadyError,
      );
      expect(calls).toEqual([]);
      expect(port.bufferedCalls).toBe(0);
    },
  );

  it("checks a streamed call the same way", async () => {
    const port = new ContinuationPort();
    const { wrapped, calls } = rechecked(port, (state) => {
      freshObservation(state);
      return Promise.resolve();
    });
    expiredClock();
    const stream = requiredStream(wrapped);
    await expect(stream.next()).resolves.toMatchObject({ value: { type: "delta" } });
    expect(calls).toEqual([ADMITTED_MODEL]);
    expect(port.streamedCalls).toBe(1);
  });
});
