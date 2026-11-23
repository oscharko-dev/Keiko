import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RelayAdmissionGate,
  UpstreamWatchdog,
  type RelayGateLimits,
} from "./repositoryRelayLimiter.js";
import { RelayRefusal } from "./repositoryRelayResponse.js";

const LIMITS: RelayGateLimits = {
  perBinding: 2,
  process: 3,
  maxWaiters: 2,
  waitMs: 1000,
  textBudgetBytes: 100,
};

afterEach(() => {
  vi.useRealTimers();
});

const idle = (): AbortSignal => new AbortController().signal;

describe("RelayAdmissionGate", () => {
  it("admits up to the binding's cap and the process cap, and queues the rest in arrival order", async () => {
    const gate = new RelayAdmissionGate(LIMITS);
    const a = {};
    const b = {};
    const a1 = await gate.acquire(a, idle());
    const a2 = await gate.acquire(a, idle());
    const order: string[] = [];
    const a3 = gate.acquire(a, idle()).then((slot) => {
      order.push("a3");
      return slot;
    });
    const b1 = await gate.acquire(b, idle());
    // The process cap (3) is reached: b2 waits behind a3.
    const b2 = gate.acquire(b, idle()).then((slot) => {
      order.push("b2");
      return slot;
    });
    expect(gate.snapshot()).toMatchObject({ inFlight: 3, waiting: 2 });
    a1.release();
    // a1's place goes to a3 first (arrival order), b2 still waits for the process cap.
    const third = await a3;
    expect(order).toEqual(["a3"]);
    b1.release();
    await b2;
    expect(order).toEqual(["a3", "b2"]);
    for (const slot of [a2, third, await b2]) slot.release();
    expect(gate.snapshot()).toEqual({ inFlight: 0, waiting: 0, textBytes: 0 });
  });

  it("refuses at once as relay-busy when the queue is full", async () => {
    const gate = new RelayAdmissionGate({ ...LIMITS, perBinding: 1, maxWaiters: 1 });
    const key = {};
    await gate.acquire(key, idle());
    const waiting = gate.acquire(key, idle());
    waiting.catch(() => undefined);
    await expect(gate.acquire(key, idle())).rejects.toMatchObject({
      reason: "relay-busy",
      status: 503,
    });
  });

  it("refuses a waiter once its wait ran out and removes it from the queue", async () => {
    vi.useFakeTimers();
    const gate = new RelayAdmissionGate({ ...LIMITS, perBinding: 1 });
    const key = {};
    await gate.acquire(key, idle());
    const waiting = expect(gate.acquire(key, idle())).rejects.toMatchObject({
      reason: "relay-busy",
    });
    await vi.advanceTimersByTimeAsync(LIMITS.waitMs);
    await waiting;
    expect(gate.snapshot().waiting).toBe(0);
  });

  it("ends a wait when the signal aborts, and refuses an already aborted one", async () => {
    const gate = new RelayAdmissionGate({ ...LIMITS, perBinding: 1 });
    const key = {};
    await gate.acquire(key, idle());
    const controller = new AbortController();
    const waiting = expect(gate.acquire(key, controller.signal)).rejects.toMatchObject({
      reason: "run-aborted",
    });
    controller.abort();
    await waiting;
    expect(gate.snapshot().waiting).toBe(0);
    await expect(gate.acquire({}, AbortSignal.abort())).rejects.toBeInstanceOf(RelayRefusal);
  });

  it("holds buffered text against one budget, grows a reservation and returns it once", async () => {
    const gate = new RelayAdmissionGate(LIMITS);
    const first = await gate.acquire({}, idle());
    const second = await gate.acquire({}, idle());
    first.reserveText(60);
    // A reservation is the exchange's running total: a smaller one holds nothing more.
    first.reserveText(40);
    expect(gate.snapshot().textBytes).toBe(60);
    expect(() => {
      second.reserveText(41);
    }).toThrow(expect.objectContaining({ reason: "relay-busy" }));
    second.reserveText(40);
    first.release();
    first.release();
    expect(gate.snapshot().textBytes).toBe(40);
    second.release();
    expect(gate.snapshot()).toEqual({ inFlight: 0, waiting: 0, textBytes: 0 });
  });
});

describe("UpstreamWatchdog", () => {
  it("expires after the idle limit with the closed refusal as the abort reason", () => {
    vi.useFakeTimers();
    const watchdog = new UpstreamWatchdog(idle(), 1000, 60_000);
    vi.advanceTimersByTime(999);
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(watchdog.timedOut).toBe(true);
    expect(watchdog.signal.reason).toMatchObject({ reason: "upstream-timeout", status: 504 });
  });

  it("does not cut a slow download that keeps sending, until the total ceiling", () => {
    vi.useFakeTimers();
    const watchdog = new UpstreamWatchdog(idle(), 1000, 10_000);
    for (let elapsed = 0; elapsed < 9_000; elapsed += 900) {
      vi.advanceTimersByTime(900);
      watchdog.touch();
    }
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(watchdog.timedOut).toBe(true);
  });

  it("follows its parent's abort without counting as a timeout, and stops its timers", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const watchdog = new UpstreamWatchdog(parent.signal, 1000, 10_000);
    parent.abort();
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timedOut).toBe(false);
    watchdog.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
