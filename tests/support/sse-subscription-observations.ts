import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { resetServerLogger } from "./activity-log-test-support.js";
import { createBufferedServerLogSink } from "./buffered-server-log.js";
import {
  createServerLogger,
  setServerLogger,
} from "../../packages/keiko-server/src/observability/index.js";
import {
  SSE_STALLED_READER_TIMEOUT_MS,
  type SseBackpressureSignal,
} from "../../packages/keiko-server/src/sse-write.js";

export interface SseResponseObservation {
  res: ServerResponse;
  readonly writes: string[];
  destroyCount: number;
  destroyed: boolean;
  ended: boolean;
  writeReturns: boolean;
  readonly emitClose: () => void;
  readonly emitDrain: () => void;
}

interface SseResponseEventMethods {
  on(event: string, listener: (...args: unknown[]) => void): ServerResponse;
  once(event: string, listener: (...args: unknown[]) => void): ServerResponse;
  off(event: string, listener: (...args: unknown[]) => void): ServerResponse;
}

export function createSseResponseEventMethods(
  emitter: EventEmitter,
  response: () => ServerResponse,
): SseResponseEventMethods {
  return {
    on(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.on(event, listener);
      return response();
    },
    once(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.once(event, listener);
      return response();
    },
    off(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.off(event, listener);
      return response();
    },
  };
}

function createObservationResponse(
  state: SseResponseObservation,
  emitter: EventEmitter,
  writes: string[],
): ServerResponse {
  const res = {
    get destroyed(): boolean {
      return state.destroyed;
    },
    get writableEnded(): boolean {
      return state.ended;
    },
    writeHead(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    write(chunk: string): boolean {
      writes.push(chunk);
      return state.writeReturns;
    },
    end(): ServerResponse {
      state.ended = true;
      return res as unknown as ServerResponse;
    },
    // Like a real response: destroying marks it destroyed and fires `close`, which is what the
    // route's own close handler unsubscribes on.
    destroy(): void {
      state.destroyCount += 1;
      state.destroyed = true;
      emitter.emit("close");
    },
    ...createSseResponseEventMethods(
      emitter,
      (): ServerResponse => res as unknown as ServerResponse,
    ),
  };
  return res as unknown as ServerResponse;
}

function createResponseObservationCore(): {
  state: SseResponseObservation;
  emitter: EventEmitter;
} {
  const writes: string[] = [];
  const emitter = new EventEmitter();
  const state: SseResponseObservation = {
    res: undefined as unknown as ServerResponse,
    writes,
    destroyCount: 0,
    destroyed: false,
    ended: false,
    writeReturns: true,
    emitClose: (): void => {
      emitter.emit("close");
    },
    emitDrain: (): void => {
      emitter.emit("drain");
    },
  };
  state.res = createObservationResponse(state, emitter, writes);
  return { state, emitter };
}

export function createSseResponseObservation(): SseResponseObservation {
  return createResponseObservationCore().state;
}

export function createEmittingSseResponseObservation(): SseResponseObservation {
  const { state, emitter } = createResponseObservationCore();
  const descriptor = Object.getOwnPropertyDescriptor(
    {
      emit(event: string): boolean {
        return emitter.emit(event);
      },
    },
    "emit",
  );
  if (descriptor === undefined) throw new TypeError("Missing SSE fixture emit descriptor");
  Object.defineProperty(state.res, "emit", descriptor);
  return state;
}

interface SubscriptionResponse {
  readonly res: ServerResponse;
  readonly writes: readonly string[];
  readonly destroyCount: number;
  writeReturns: boolean;
}

export interface NativeSseSubscription<Manager> {
  readonly manager: Manager;
  readonly observe: (beforeAcquire: (receiver: unknown) => void, beforeRelease: () => void) => void;
}

export function createObservedSseSubscription<Manager, Listener>(
  manager: Manager,
  subscribe: (listener: Listener) => () => void,
  installNativeSpy: (acquire: (this: Manager, listener: Listener) => () => void) => void,
): NativeSseSubscription<Manager> {
  return {
    manager,
    observe: (beforeAcquire, beforeRelease): void => {
      installNativeSpy(function (this: Manager, listener: Listener): () => void {
        beforeAcquire(this);
        const release = subscribe(listener);
        return (): void => {
          beforeRelease();
          release();
        };
      });
    },
  };
}

interface SubscriptionObservationBinding<Manager, Response extends SubscriptionResponse> {
  readonly response: () => Response;
  readonly subscription: () => NativeSseSubscription<Manager>;
  readonly open: (
    res: ServerResponse,
    manager: Manager,
    redactor: (value: unknown) => unknown,
    onBackpressure?: (signal: SseBackpressureSignal) => void,
    correlationId?: string,
  ) => void;
  readonly emitFirst: (manager: Manager) => void;
  readonly emitNext: (manager: Manager) => void;
  readonly closePairResponse: (response: Response) => void;
  readonly inputCorrelationIds: readonly [string, string];
  readonly expectedCorrelationIds: readonly [string, string];
  readonly expectedCursorFrames: readonly [string, string];
}

function expectReadyPair(
  first: SubscriptionResponse,
  second: SubscriptionResponse,
  subscriptionWriteCounts: readonly number[],
): void {
  expect(subscriptionWriteCounts).toEqual([0, 1]);
  expect(first.writes).toEqual(["event: ready\ndata: {}\n\n"]);
  expect(second.writes).toEqual(["event: ready\ndata: {}\n\n"]);
}

function expectPairTerminalEvents(
  sink: ReturnType<typeof createBufferedServerLogSink>,
  correlations: readonly [string, string],
): void {
  expect(sink.events).toHaveLength(2);
  expect(sink.events[0]).toMatchObject({
    op: "sse.stream.closed",
    correlationId: correlations[0],
    extra: { frameCount: 2, reason: "client-disconnected" },
  });
  expect(sink.events[1]).toMatchObject({
    op: "sse.stream.closed",
    correlationId: correlations[1],
    extra: { frameCount: 3, reason: "client-disconnected" },
  });
}

function registerPair<Manager, Response extends SubscriptionResponse>(
  binding: SubscriptionObservationBinding<Manager, Response>,
): void {
  it("preserves manager receiver, subscription order and independent cursors", (): void => {
    const first = binding.response();
    const second = binding.response();
    const native = binding.subscription();
    const manager = native.manager;
    const subscriptionWriteCounts: number[] = [];
    let unsubscribeCount = 0;
    native.observe(
      (receiver): void => {
        expect(receiver).toBe(manager);
        subscriptionWriteCounts.push(first.writes.length + second.writes.length);
      },
      (): void => {
        unsubscribeCount += 1;
      },
    );
    const redact = vi.fn((value: unknown): unknown => value);
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const open = binding.open;
    try {
      open(first.res, manager, redact, undefined, binding.inputCorrelationIds[0]);
      open(second.res, manager, redact, undefined, binding.inputCorrelationIds[1]);
      expectReadyPair(first, second, subscriptionWriteCounts);
      binding.emitFirst(manager);
      expect(first.writes[1]).toContain(binding.expectedCursorFrames[0]);
      expect(second.writes[1]).toBe(first.writes[1]);
      expect(redact).toHaveBeenCalledTimes(1);
      binding.closePairResponse(first);
      binding.closePairResponse(first);
      expect(unsubscribeCount).toBe(1);
      binding.emitNext(manager);
      expect(first.writes).toHaveLength(2);
      expect(second.writes[2]).toContain(binding.expectedCursorFrames[1]);
      binding.closePairResponse(second);
      binding.closePairResponse(second);
      expect(unsubscribeCount).toBe(2);
      expectPairTerminalEvents(sink, binding.expectedCorrelationIds);
    } finally {
      binding.closePairResponse(first);
      binding.closePairResponse(second);
      vi.restoreAllMocks();
      resetServerLogger();
    }
  });
}

function registerReadyStall<Manager, Response extends SubscriptionResponse>(
  binding: SubscriptionObservationBinding<Manager, Response>,
): void {
  it("unsubscribes once before ready-stall destruction and retains close idempotency", (): void => {
    vi.useFakeTimers();
    const fake = binding.response();
    const native = binding.subscription();
    const manager = native.manager;
    const trace: string[] = [];
    native.observe(
      (): void => undefined,
      (): void => {
        expect(fake.destroyCount).toBe(0);
        trace.push("unsubscribe");
      },
    );
    fake.writeReturns = false;
    const open = binding.open;
    try {
      open(
        fake.res,
        manager,
        (value): unknown => value,
        (signal): void => {
          expect(fake.destroyCount).toBe(0);
          expect(signal).toEqual({ accepted: false, frameBytes: 23 });
          trace.push("observer");
        },
      );
      expect(trace).toEqual([]);
      vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
      expect(trace).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(trace).toEqual(["observer", "unsubscribe"]);
      expect(fake.destroyCount).toBe(1);
      fake.res.emit("close");
      expect(trace).toEqual(["observer", "unsubscribe"]);
      binding.emitNext(manager);
      expect(fake.writes.filter((frame) => !frame.startsWith(":"))).toEqual([
        "event: ready\ndata: {}\n\n",
      ]);
    } finally {
      fake.res.emit("close");
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
}

export function defineSseSubscriptionObservationContract<
  Manager,
  Response extends SubscriptionResponse,
>(binding: SubscriptionObservationBinding<Manager, Response>): void {
  registerPair(binding);
  registerReadyStall(binding);
}

/** The stalled-reader bound tears the stream down exactly at its deadline, signalling once. */
function expectStalledReaderTeardown(
  fake: SseResponseObservation,
  signals: readonly SseBackpressureSignal[],
): void {
  vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
  expect(fake.destroyCount).toBe(0);
  expect(signals).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(fake.destroyCount).toBe(1);
  expect(signals).toHaveLength(1);
}

/** A drain after a false write keeps the stream open and subscribed for the next event. */
function expectDrainRecovery(
  fake: SseResponseObservation,
  signals: readonly SseBackpressureSignal[],
  emitNext: () => void,
): void {
  fake.emitDrain();
  fake.writeReturns = true;
  vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS * 2);
  expect(fake.destroyCount).toBe(0);
  expect(signals).toHaveLength(0);
  const writesBefore = fake.writes.length;
  emitNext();
  expect(fake.writes).toHaveLength(writesBefore + 1);
  expect(fake.destroyCount).toBe(0);
}

interface BackpressureBinding<Manager> {
  readonly manager: () => Manager;
  readonly open: (
    res: ServerResponse,
    manager: Manager,
    redactor: (value: unknown) => unknown,
    onBackpressure?: (signal: SseBackpressureSignal) => void,
  ) => void;
  /** Emits the run event a slow reader is handed first; `firstKind` names its kind. */
  readonly emitFirst: (manager: Manager, runId: string) => void;
  readonly firstKind: string;
  /** Emits a later run event of another kind. */
  readonly emitNext: (manager: Manager, runId: string) => void;
  /** Emits a run-completed event; `completedFrame` is the namespaced frame it produces. */
  readonly emitCompleted: (manager: Manager, runId: string) => void;
  readonly completedFrame: string;
}

interface OpenedBackpressureStream<Manager> {
  readonly fake: SseResponseObservation;
  readonly manager: Manager;
  readonly signals: SseBackpressureSignal[];
}

function openBackpressureStream<Manager>(
  binding: BackpressureBinding<Manager>,
  stallReady = false,
): OpenedBackpressureStream<Manager> {
  const fake = createEmittingSseResponseObservation();
  const manager = binding.manager();
  const signals: SseBackpressureSignal[] = [];
  if (stallReady) fake.writeReturns = false;
  binding.open(
    fake.res,
    manager,
    (value) => value,
    (signal) => {
      signals.push(signal);
    },
  );
  return { fake, manager, signals };
}

function registerReadyFrameStall<Manager>(binding: BackpressureBinding<Manager>): void {
  it("destroys once and signals when the reader stalls on the ready frame itself", () => {
    vi.useFakeTimers();
    const { fake, manager, signals } = openBackpressureStream(binding, true);
    expect(fake.writes).toHaveLength(1);
    expect(fake.destroyCount).toBe(0);
    expect(signals).toHaveLength(0);
    expectStalledReaderTeardown(fake, signals);
    expect(signals[0]?.accepted).toBe(false);
    // The stall bound aborted the stream before any event: nothing further is written or destroyed.
    const writesAfterKill = fake.writes.length;
    binding.emitFirst(manager, "run-bp");
    expect(fake.writes).toHaveLength(writesAfterKill);
    expect(fake.destroyCount).toBe(1);
  });
}

function registerEventFrameStall<Manager>(binding: BackpressureBinding<Manager>): void {
  it("aborts, unsubscribes, destroys once, and signals when the reader stalls after res.write returns false", () => {
    vi.useFakeTimers();
    const { fake, manager, signals } = openBackpressureStream(binding);
    // The client took the ready frame and goes slow only once events flow, so the first EVENT frame
    // is the queued one. A stalled ready frame has its own case.
    expect(fake.writes).toHaveLength(1);
    fake.writeReturns = false;
    binding.emitFirst(manager, "run-bp");
    // The frame is queued, not dropped, and nothing is torn down yet.
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes[1]).toContain(binding.firstKind);
    expect(fake.destroyCount).toBe(0);
    expect(signals).toHaveLength(0);
    expectStalledReaderTeardown(fake, signals);
    expect(signals[0]?.accepted).toBe(false);
    expect(signals[0]?.frameBytes).toBeGreaterThan(0);
    // The abort unsubscribed from the manager, so a second event produces no further work.
    const writesAfterKill = fake.writes.length;
    binding.emitNext(manager, "run-bp");
    expect(fake.writes).toHaveLength(writesAfterKill);
    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
    // res.on("close") firing after an abort-driven unsubscribe must not double-unsubscribe/throw.
    expect(() => {
      fake.emitClose();
    }).not.toThrow();
  });
}

function registerDrainAndHealthyWrites<Manager>(binding: BackpressureBinding<Manager>): void {
  it("keeps the stream open and subscribed when a false write is followed by drain", () => {
    vi.useFakeTimers();
    const { fake, manager, signals } = openBackpressureStream(binding);
    fake.writeReturns = false;
    binding.emitFirst(manager, "run-drain");
    expectDrainRecovery(fake, signals, () => {
      binding.emitNext(manager, "run-drain");
    });
  });
  it("keeps the normal write path intact when res.write returns true", () => {
    const { fake, manager, signals } = openBackpressureStream(binding);
    binding.emitCompleted(manager, "run-ok");
    expect(fake.destroyCount).toBe(0);
    expect(signals).toHaveLength(0);
    expect(fake.writes.join("")).toContain(binding.completedFrame);
  });
}

/** Registers the stalled-reader cases every namespaced runner SSE stream must satisfy. */
export function defineSseBackpressureContract<Manager>(
  binding: BackpressureBinding<Manager>,
): void {
  afterEach(() => {
    vi.useRealTimers();
  });
  registerReadyFrameStall(binding);
  registerEventFrameStall(binding);
  registerDrainAndHealthyWrites(binding);
}

export interface SessionStreamScenario {
  /** Opens the scenario's stream on `res`, reporting backpressure to `onBackpressure`. */
  readonly open: (
    res: ServerResponse,
    onBackpressure: (signal: SseBackpressureSignal) => void,
  ) => void;
  /** Emits the scenario's `sequence`-th session event through its own fresh manager. */
  readonly emit: (sequence: number) => void;
}

interface SessionBackpressureBinding {
  /** The response observation the suite already uses for its streams. */
  readonly response: () => SseResponseObservation;
  /** A stream over a fresh manager for one named scenario: "bp", "ready", "late" or "drain". */
  readonly scenario: (name: string) => SessionStreamScenario;
}

function openSessionScenario(
  binding: SessionBackpressureBinding,
  name: string,
  stallReady: boolean,
): {
  readonly fake: SseResponseObservation;
  readonly stream: SessionStreamScenario;
  readonly signals: SseBackpressureSignal[];
} {
  vi.useFakeTimers();
  const fake = binding.response();
  const stream = binding.scenario(name);
  const signals: SseBackpressureSignal[] = [];
  if (stallReady) fake.writeReturns = false;
  stream.open(fake.res, (signal) => {
    signals.push(signal);
  });
  return { fake, stream, signals };
}

function registerSessionStall(binding: SessionBackpressureBinding): void {
  it("aborts, unsubscribes, destroys once, and signals when the reader stalls after res.write returns false", () => {
    const { fake, stream, signals } = openSessionScenario(binding, "bp", true);
    // A false write is flow control: the stream stays open and keeps queueing frames.
    stream.emit(1);
    expect(fake.writes).toHaveLength(2);
    expect(fake.destroyCount).toBe(0);
    expect(signals).toHaveLength(0);
    expectStalledReaderTeardown(fake, signals);
    expect(signals[0]?.accepted).toBe(false);
    expect(signals[0]?.frameBytes).toBeGreaterThan(0);
    // The abort unsubscribed, so a second event produces no further writes or destroys.
    const writesAfterKill = fake.writes.length;
    stream.emit(2);
    expect(fake.writes).toHaveLength(writesAfterKill);
    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
    // close firing after an abort-driven unsubscribe must not double-unsubscribe or throw.
    expect(() => {
      fake.emitClose();
    }).not.toThrow();
  });
}

function registerSessionFrameStalls(binding: SessionBackpressureBinding): void {
  it("protects the ready frame itself, not just later events (KEIKO-0142)", () => {
    // The ready frame is written before any manager event. If it is queued and the reader never
    // drains it, the stalled-reader bound must still tear the stream down without a later event.
    const { fake, signals } = openSessionScenario(binding, "ready", true);
    expect(fake.writes.length).toBeGreaterThan(0);
    expect(fake.destroyCount).toBe(0);
    expect(signals).toHaveLength(0);
    expectStalledReaderTeardown(fake, signals);
  });
  it("kills a stalled reader on an event frame when the ready frame was accepted (KEIKO-0142)", () => {
    // The complementary path: ready frame accepted, a later event frame queued and never drained.
    const { fake, stream, signals } = openSessionScenario(binding, "late", false);
    expect(fake.destroyCount).toBe(0);
    fake.writeReturns = false;
    stream.emit(1);
    expect(fake.destroyCount).toBe(0);
    expect(signals).toHaveLength(0);
    expectStalledReaderTeardown(fake, signals);
  });
}

function registerSessionDrain(binding: SessionBackpressureBinding): void {
  it("keeps the stream open and subscribed when a false write is followed by drain", () => {
    const { fake, stream, signals } = openSessionScenario(binding, "drain", true);
    expectDrainRecovery(fake, signals, () => {
      stream.emit(1);
    });
  });
}

/** Registers the stalled-reader cases every session-scoped SSE stream must satisfy (KEIKO-0142). */
export function defineSessionSseBackpressureContract(binding: SessionBackpressureBinding): void {
  afterEach(() => {
    vi.useRealTimers();
  });
  registerSessionStall(binding);
  registerSessionFrameStalls(binding);
  registerSessionDrain(binding);
}
