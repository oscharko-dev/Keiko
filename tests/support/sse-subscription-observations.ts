import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
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
