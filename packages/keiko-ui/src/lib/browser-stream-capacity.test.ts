import { afterEach, describe, expect, it, vi } from "vitest";
import { createOriginLocksFixture } from "../test-utils/origin-locks-fixture";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

import {
  acquirePersistentBrowserStreamCapacity,
  backgroundBrowserStreamsSuspended,
  admitDirectBrowserStream,
  admitDirectBrowserStreamAsync,
  type DirectStreamAdmission,
  PERSISTENT_STREAM_CONNECTION_CEILING,
  sharedStreamConnectionBudget,
  reserveInteractiveBrowserStreamCapacity,
  resetBrowserStreamCapacityForTests,
  subscribeBrowserStreamCapacity,
} from "./browser-stream-capacity";

afterEach(() => {
  resetBrowserStreamCapacityForTests();
  resetClientDiagnosticWriter();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser stream capacity", () => {
  it("suspends background streams until every interactive reservation is released", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserStreamCapacity(listener);
    const releaseFirst = reserveInteractiveBrowserStreamCapacity();
    const releaseSecond = reserveInteractiveBrowserStreamCapacity();

    expect(backgroundBrowserStreamsSuspended()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseFirst();
    releaseFirst();
    expect(backgroundBrowserStreamsSuspended()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseSecond();
    expect(backgroundBrowserStreamsSuspended()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    unsubscribe();
  });
});

describe("origin-wide persistent stream capacity", () => {
  it("limits independent consumers to three origin slots and yields every five seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const active = new Set<number>();
    const granted = new Set<number>();
    let peak = 0;
    const releases = Array.from({ length: 6 }, (_, index) =>
      acquirePersistentBrowserStreamCapacity(
        () => {
          active.add(index);
          granted.add(index);
          peak = Math.max(peak, active.size);
        },
        () => active.delete(index),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(active.size).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(peak).toBe(3);
    expect(granted.size).toBe(6);
    expect(active.size).toBe(3);
    releases.forEach((release) => release());
    expect(active.size).toBe(0);
  });

  it("cancels queued and held leases without opening stale consumers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const held = Array.from({ length: 3 }, () =>
      acquirePersistentBrowserStreamCapacity(vi.fn(), vi.fn()),
    );
    const grant = vi.fn();
    const release = vi.fn();
    const cancel = acquirePersistentBrowserStreamCapacity(grant, release);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    cancel();
    held.forEach((stop) => stop());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(grant).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("cancelled");
  });

  it("bounds pending acquisition and does not open streams without a coordinator", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: { request: () => new Promise(() => undefined) } });
    const grant = vi.fn();
    const release = vi.fn();
    acquirePersistentBrowserStreamCapacity(grant, release);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(grant).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("unavailable");
    vi.stubGlobal("navigator", {});
    acquirePersistentBrowserStreamCapacity(grant, vi.fn())();
    expect(grant).not.toHaveBeenCalled();
  });
});

it("retains an uncontended lease and probes another free slot across independent tabs", async () => {
  vi.useFakeTimers();
  const locks = createOriginLocksFixture();
  vi.stubGlobal("navigator", { locks });
  const first = vi.fn();
  const released = vi.fn();
  const stop = acquirePersistentBrowserStreamCapacity(first, released);
  await vi.advanceTimersByTimeAsync(0);
  resetBrowserStreamCapacityForTests(); // A second independent page starts its own slot counter at zero.
  const second = vi.fn();
  const stopSecond = acquirePersistentBrowserStreamCapacity(second, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(released).not.toHaveBeenCalled();
  stop();
  stopSecond();
});

it("never interrupts an active non-replayable connection for a queued consumer", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
  const releases = Array.from({ length: 3 }, () => vi.fn());
  const held = releases.map((released) =>
    acquirePersistentBrowserStreamCapacity(vi.fn(), released, { yieldable: false }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const grant = vi.fn();
  const cancel = acquirePersistentBrowserStreamCapacity(grant, vi.fn());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(grant).not.toHaveBeenCalled();
  expect(releases.every((released) => released.mock.calls.length === 0)).toBe(true);
  cancel();
  held.forEach((stop) => stop());
});

it("never cycles the only healthy connection without an origin waiter", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
  const released = vi.fn();
  const stop = acquirePersistentBrowserStreamCapacity(vi.fn(), released);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(released).not.toHaveBeenCalled();
  stop();
});

it("records a failed contention query once without dropping a healthy connection or error prose", async () => {
  vi.useFakeTimers();
  const locks = createOriginLocksFixture();
  const query = vi.fn().mockRejectedValue(new TypeError("private customer query failure"));
  vi.stubGlobal("navigator", { locks: { request: locks.request, query } });
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  const grant = vi.fn();
  const released = vi.fn();
  const stop = acquirePersistentBrowserStreamCapacity(grant, released, {
    correlationId: "capacity-failure-1",
  });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(grant).toHaveBeenCalledOnce();
  expect(released).not.toHaveBeenCalled();
  expect(writer).toHaveBeenCalledOnce();
  expect(writer).toHaveBeenCalledWith(
    "[keiko] persistent stream contention query unavailable",
    expect.objectContaining({ correlationId: "capacity-failure-1", errorKind: "unavailable" }),
  );
  expect(JSON.stringify(writer.mock.calls)).not.toContain("private customer query failure");
  stop();
});

// U-37 / #4573: persistent streams of every document of the origin share four connection slots, so
// two of the six HTTP/1.1 connections stay free for finite reads. The ceiling is enforced when a
// stream is admitted, not by counting streams after they opened.
describe("persistent stream connection ceiling", () => {
  function admitAll(
    count: number,
    admitted: Set<number>,
    denied?: Set<number>,
  ): DirectStreamAdmission[] {
    return Array.from({ length: count }, (_, index) =>
      admitDirectBrowserStream(
        () => admitted.add(index),
        () => denied?.add(index),
      ),
    );
  }

  it("admits at most four direct streams and lets the shared pool yield its last slot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    expect(sharedStreamConnectionBudget()).toBe(3);
    const admitted = new Set<number>();
    const admissions = admitAll(6, admitted);
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted.size).toBe(PERSISTENT_STREAM_CONNECTION_CEILING);
    expect(sharedStreamConnectionBudget()).toBe(0);
    admissions[0]?.release();
    admissions[0]?.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted.size).toBe(PERSISTENT_STREAM_CONNECTION_CEILING + 1);
    admissions.forEach((admission) => admission.release());
    expect(sharedStreamConnectionBudget()).toBe(3);
  });

  it("shares the ceiling across documents and with the shared pool", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    let live = 0;
    let peak = 0;
    const open = (): void => {
      live += 1;
      peak = Math.max(peak, live);
    };
    const pool = Array.from({ length: 3 }, () =>
      acquirePersistentBrowserStreamCapacity(open, () => (live -= 1)),
    );
    const documentA = Array.from({ length: 2 }, () => admitDirectBrowserStream(open, vi.fn()));
    resetBrowserStreamCapacityForTests(); // Another tab starts its own counters, not its locks.
    const documentB = Array.from({ length: 3 }, () => admitDirectBrowserStream(open, vi.fn()));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(peak).toBeLessThanOrEqual(PERSISTENT_STREAM_CONNECTION_CEILING);
    expect(live).toBeLessThanOrEqual(PERSISTENT_STREAM_CONNECTION_CEILING);
    [...pool, ...documentA.map((a) => a.release), ...documentB.map((b) => b.release)].forEach(
      (stop) => stop(),
    );
  });

  it("denies a stream that waits past the acquisition deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const denied = new Set<number>();
    const admissions = admitAll(5, new Set<number>(), denied);
    await vi.advanceTimersByTimeAsync(20_000);
    expect([...denied]).toEqual([4]);
    expect(admissions[4]?.active).toBe(false);
    admissions.forEach((admission) => admission.release());
  });

  it("admits a stream asynchronously and not at all once its signal aborted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const controller = new AbortController();
    const first = admitDirectBrowserStreamAsync(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const release = await first;
    expect(release).not.toBeNull();
    release?.();
    controller.abort();
    await expect(admitDirectBrowserStreamAsync(controller.signal)).resolves.toBeNull();
  });

  it("falls back to this document's ceiling when Web Locks are unavailable", () => {
    vi.stubGlobal("navigator", {});
    const admitted = new Set<number>();
    const denied = new Set<number>();
    const admissions = admitAll(5, admitted, denied);
    expect(admitted.size).toBe(PERSISTENT_STREAM_CONNECTION_CEILING);
    expect([...denied]).toEqual([4]);
    admissions.forEach((admission) => admission.release());
  });
});
