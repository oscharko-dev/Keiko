// GEN-PERF-RELACT-001 — unit contract for the shared per-workspace activity broadcaster.
// Pins the four properties the per-connection implementation it replaced did not have:
// one shared sweep per tick, full-state late-join without losing diffs for existing
// subscribers, backpressure kills that detach only the non-draining client, and timer
// teardown when the last subscriber leaves.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import {
  subscribeActivityBroadcast,
  _activeBroadcastCountForTests,
  type ActivityFrame,
  type ActivitySubscriber,
} from "./relationship-activity-broadcast.js";

const REFRESH_MS = 5_000;
const PING_MS = 30_000;

interface FakeSseRes {
  readonly written: string[];
  readonly destroyed: () => boolean;
  readonly res: ServerResponse;
}

function fakeSseRes(writeReturns: (frame: string) => boolean = () => true): FakeSseRes {
  const written: string[] = [];
  let destroyed = false;
  const res = {
    write(chunk: string): boolean {
      written.push(chunk);
      return writeReturns(chunk);
    },
    destroy(): void {
      destroyed = true;
    },
  } as unknown as ServerResponse;
  return { written, destroyed: (): boolean => destroyed, res };
}

function subscriberFor(fake: FakeSseRes): ActivitySubscriber {
  return { res: fake.res, controller: new AbortController() };
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
    expect(a.written.length).toBe(afterJoin);
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

  it("destroys a non-draining subscriber and keeps serving the healthy one", () => {
    vi.useFakeTimers();
    const scope = {};
    let revision = 1;
    const collectFrames = vi.fn((): readonly ActivityFrame[] => [frame("snap-1", revision)]);
    const source = { collectFrames, refreshMs: REFRESH_MS, pingMs: PING_MS };
    const healthy = fakeSseRes();
    const slow = fakeSseRes(() => false);
    const slowSubscriber = subscriberFor(slow);
    const unsubHealthy = subscribeActivityBroadcast(scope, "ws-a", subscriberFor(healthy), source);
    subscribeActivityBroadcast(scope, "ws-a", slowSubscriber, source);
    // The join emission already trips backpressure: aborted + destroyed, not buffered.
    expect(slowSubscriber.controller.signal.aborted).toBe(true);
    expect(slow.destroyed()).toBe(true);
    const slowWrites = slow.written.length;
    revision = 2;
    vi.advanceTimersByTime(REFRESH_MS);
    expect(slow.written.length).toBe(slowWrites);
    expect(healthy.written.filter((w) => w.includes('"rev":2'))).toHaveLength(1);
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

  it("releases a joiner whose very first write already hits backpressure", () => {
    vi.useFakeTimers();
    const scope = {};
    const source = {
      collectFrames: (): readonly ActivityFrame[] => [frame("snap-1", 1)],
      refreshMs: REFRESH_MS,
      pingMs: PING_MS,
    };
    const dead = fakeSseRes(() => false);
    subscribeActivityBroadcast(scope, "ws-a", subscriberFor(dead), source);
    expect(dead.destroyed()).toBe(true);
    expect(_activeBroadcastCountForTests(scope)).toBe(0);
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
