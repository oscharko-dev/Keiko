import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
// GEN-PERF-RELACT-001 — unit contract for the shared per-workspace activity broadcaster.
// Pins the four properties the per-connection implementation it replaced did not have:
// one shared sweep per tick, full-state late-join without losing diffs for existing
// subscribers, backpressure kills that detach only the non-draining client, and timer
// teardown when the last subscriber leaves.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { SSE_STALLED_READER_TIMEOUT_MS } from "./sse-write.js";
import {
  subscribeActivityBroadcast,
  _activeBroadcastCountForTests,
  type ActivityFrame,
  type ActivitySubscriber,
} from "./relationship-activity-broadcast.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

const REFRESH_MS = 5_000;
const PING_MS = 30_000;

interface FakeSseRes {
  readonly written: string[];
  readonly destroyed: () => boolean;
  readonly drain: () => void;
  readonly res: ServerResponse;
}

function fakeSseRes(writeReturns: (frame: string) => boolean = () => true): FakeSseRes {
  const written: string[] = [];
  const emitter = new EventEmitter();
  let destroyed = false;
  const res = Object.assign(emitter, {
    get destroyed(): boolean {
      return destroyed;
    },
    writableEnded: false,
    write(chunk: string): boolean {
      written.push(chunk);
      return writeReturns(chunk);
    },
    // Like a real response: destroying marks it destroyed and fires `close`.
    destroy(): void {
      destroyed = true;
      emitter.emit("close");
    },
  }) as unknown as ServerResponse;
  return {
    written,
    destroyed: (): boolean => destroyed,
    drain: (): void => {
      emitter.emit("drain");
    },
    res,
  };
}

function subscriberFor(
  fake: FakeSseRes,
  onBackpressure?: ActivitySubscriber["onBackpressure"],
): ActivitySubscriber {
  return {
    res: fake.res,
    controller: new AbortController(),
    ...(onBackpressure === undefined ? {} : { onBackpressure }),
  };
}

function frame(id: string, revision: number): ActivityFrame {
  return {
    id,
    frame: `event: relationship:activity\ndata: {"id":"${id}","rev":${String(revision)}}\n\n`,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeActivityBroadcast", () => {
  it("shares one sweep and one serialized frame per tick across concurrent subscribers", () => {
    vi.useFakeTimers();
    const scope = {};
    let revision = 1;
    const collectFrames = vi.fn((): readonly ActivityFrame[] => [frame("snap-1", revision)]);
    const source = { collectFrames, refreshMs: REFRESH_MS, pingMs: PING_MS };
    const a = fakeSseRes();
    const b = fakeSseRes();
    const unsubA = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(a), source);
    const unsubB = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(b), source);
    collectFrames.mockClear();
    revision = 2;
    vi.advanceTimersByTime(REFRESH_MS);
    // ONE shared sweep for both connections — the per-connection implementation ran one per subscriber.
    expect(collectFrames).toHaveBeenCalledTimes(1);
    expect(a.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
    expect(b.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
    unsubA();
    unsubB();
  });

  it("does not re-send unchanged frames on a tick", () => {
    vi.useFakeTimers();
    const scope = {};
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [frame("snap-1", 1)],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const a = fakeSseRes();
    const unsub = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(a), source);
    const afterJoin = a.written.length;
    vi.advanceTimersByTime(REFRESH_MS * 3);
    expect(a.written).toHaveLength(afterJoin);
    unsub();
  });

  it("sends the full state to a late joiner and the missed diff to existing subscribers", () => {
    vi.useFakeTimers();
    const scope = {};
    let revision = 1;
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [frame("snap-1", revision)],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const early = fakeSseRes();
    const unsubEarly = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(early), source);
    expect(early.written.filter((w) => w.includes('"rev":1'))).toHaveLength(1);
    // State changes between ticks; a second window connects before the next tick.
    revision = 2;
    const late = fakeSseRes();
    const unsubLate = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(late), source);
    expect(late.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
    expect(early.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
    unsubEarly();
    unsubLate();
  });

  it("destroys a subscriber that drains nothing for the stall bound and keeps serving the healthy one", () => {
    vi.useFakeTimers();
    const scope = {};
    let revision = 1;
    const collectFrames = vi.fn((): readonly ActivityFrame[] => [frame("snap-1", revision)]);
    const source = { collectFrames, refreshMs: REFRESH_MS, pingMs: PING_MS };
    const healthy = fakeSseRes();
    const slow = fakeSseRes(() => false);
    const onBackpressure = vi.fn();
    const slowSubscriber = subscriberFor(slow, onBackpressure);
    const unsubHealthy = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(healthy), source);
    subscribeActivityBroadcast(scope, "ws-a", slowSubscriber, source);
    // The join emission is a false write: flow control, so the subscriber is queued, not killed.
    expect(slowSubscriber.controller.signal.aborted).toBe(false);
    expect(slow.destroyed()).toBe(false);
    expect(onBackpressure).not.toHaveBeenCalled();

    // Until the bound it keeps receiving frames (queued behind the ones it has not drained).
    revision = 2;
    vi.advanceTimersByTime(REFRESH_MS);
    expect(slow.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
    expect(healthy.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - REFRESH_MS - 1);
    expect(slowSubscriber.controller.signal.aborted).toBe(false);
    expect(slow.destroyed()).toBe(false);
    expect(onBackpressure).not.toHaveBeenCalled();

    // The bound passes with nothing drained: aborted + destroyed, not buffered.
    vi.advanceTimersByTime(1);
    expect(slowSubscriber.controller.signal.aborted).toBe(true);
    expect(slow.destroyed()).toBe(true);
    expect(onBackpressure).toHaveBeenCalledTimes(1);
    const slowWrites = slow.written.length;
    revision = 3;
    vi.advanceTimersByTime(REFRESH_MS);
    expect(slow.written).toHaveLength(slowWrites);
    expect(healthy.written.filter((w) => w.includes('"rev":3'))).toHaveLength(1);
    unsubHealthy();
  });

  it("pings every subscriber on the ping cadence through the backpressure guard", () => {
    vi.useFakeTimers();
    const scope = {};
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const a = fakeSseRes();
    const b = fakeSseRes();
    const unsubA = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(a), source);
    const unsubB = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(b), source);
    vi.advanceTimersByTime(PING_MS);
    expect(a.written.filter((w) => w.startsWith(": ping"))).toHaveLength(1);
    expect(b.written.filter((w) => w.startsWith(": ping"))).toHaveLength(1);
    unsubA();
    unsubB();
  });

  it("tears down the shared timers when the last subscriber detaches", () => {
    vi.useFakeTimers();
    const scope = {};
    const collectFrames = vi.fn((): readonly ActivityFrame[] => []);
    const source = { collectFrames, refreshMs: REFRESH_MS, pingMs: PING_MS };
    const a = fakeSseRes();
    const unsub = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(a), source);
    expect(_activeBroadcastCountForTests(scope)).toBe(1);
    unsub();
    unsub(); // idempotent
    expect(_activeBroadcastCountForTests(scope)).toBe(0);
    collectFrames.mockClear();
    vi.advanceTimersByTime(REFRESH_MS * 4);
    expect(collectFrames).not.toHaveBeenCalled();
  });

  it("releases a joiner that stalls on its very first write once the stall bound passes", () => {
    vi.useFakeTimers();
    const scope = {};
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [frame("snap-1", 1)],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const dead = fakeSseRes(() => false);
    subscribeActivityBroadcast(scope, "ws-a", subscriberFor(dead), source);
    expect(dead.destroyed()).toBe(false);
    expect(_activeBroadcastCountForTests(scope)).toBe(1);

    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
    expect(dead.destroyed()).toBe(false);
    expect(_activeBroadcastCountForTests(scope)).toBe(1);

    vi.advanceTimersByTime(1);
    expect(dead.destroyed()).toBe(true);
    expect(_activeBroadcastCountForTests(scope)).toBe(0);
  });

  it("keeps a subscriber attached when a false write is followed by drain", () => {
    vi.useFakeTimers();
    const scope = {};
    let revision = 1;
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [frame("snap-1", revision)],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    let accept = false;
    const reader = fakeSseRes(() => accept);
    const onBackpressure = vi.fn();
    const subscriber = subscriberFor(reader, onBackpressure);
    const unsub = subscribeActivityBroadcast(scope, "ws-a", subscriber, source);

    reader.drain();
    accept = true;
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS * 2);

    expect(subscriber.controller.signal.aborted).toBe(false);
    expect(reader.destroyed()).toBe(false);
    expect(onBackpressure).not.toHaveBeenCalled();
    expect(_activeBroadcastCountForTests(scope)).toBe(1);
    revision = 2;
    vi.advanceTimersByTime(REFRESH_MS);
    expect(reader.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
    unsub();
  });

  it("isolates broadcasters across scopes and workspaces", () => {
    vi.useFakeTimers();
    const scopeA = {};
    const scopeB = {};
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const one = fakeSseRes();
    const two = fakeSseRes();
    const three = fakeSseRes();
    const u1 = subscribeActivityBroadcast(scopeA, "ws-a", subscriberFor(one), source);
    const u2 = subscribeActivityBroadcast(scopeA, "ws-b", subscriberFor(two), source);
    const u3 = subscribeActivityBroadcast(scopeB, "ws-a", subscriberFor(three), source);
    expect(_activeBroadcastCountForTests(scopeA)).toBe(2);
    expect(_activeBroadcastCountForTests(scopeB)).toBe(1);
    u1();
    u2();
    u3();
    expect(_activeBroadcastCountForTests(scopeA)).toBe(0);
    expect(_activeBroadcastCountForTests(scopeB)).toBe(0);
  });
});

// Finding 0 (#2902 audit): a fanned-out subscriber's OWN request correlationId never reached its
// own stream's terminal `sse.stream.closed` line — ActivitySubscriber had no field to carry it and
// writeTo() (the shared fan-out write path) never passed one to writeSseFrame.
describe("ActivitySubscriber correlationId threading (#2902 audit finding 0)", () => {
  function listenableFakeRes(): { res: ServerResponse; fireClose: () => void } {
    const emitter = new EventEmitter();
    const res = {
      writableEnded: false,
      write: () => true,
      destroy: (): void => undefined,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
      },
    } as unknown as ServerResponse;
    return { res, fireClose: () => emitter.emit("close") };
  }

  afterEach(() => {
    resetServerLogger();
  });

  it("attaches the joining subscriber's own correlationId to its sse.stream.closed line", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const scope = {};
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [frame("snap-1", 1)],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const { res, fireClose } = listenableFakeRes();
    const subscriber: ActivitySubscriber = {
      res,
      controller: new AbortController(),
      correlationId: "corr-relact-1",
    };

    subscribeActivityBroadcast(scope, "ws-corr", subscriber, source);
    fireClose();

    const closed = sink.events.filter((event) => event.op === "sse.stream.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.correlationId).toBe("corr-relact-1");
  });

  it("two concurrent subscribers on the same broadcaster each keep their own correlationId", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const scope = {};
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [frame("snap-1", 1)],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const first = listenableFakeRes();
    const second = listenableFakeRes();
    subscribeActivityBroadcast(
      scope,
      "ws-corr-2",
      { res: first.res, controller: new AbortController(), correlationId: "corr-first" },
      source,
    );
    subscribeActivityBroadcast(
      scope,
      "ws-corr-2",
      { res: second.res, controller: new AbortController(), correlationId: "corr-second" },
      source,
    );
    first.fireClose();
    second.fireClose();

    const closed = sink.events.filter((event) => event.op === "sse.stream.closed");
    expect(closed).toHaveLength(2);
    expect(closed.map((event) => event.correlationId).sort()).toEqual([
      "corr-first",
      "corr-second",
    ]);
  });
});
