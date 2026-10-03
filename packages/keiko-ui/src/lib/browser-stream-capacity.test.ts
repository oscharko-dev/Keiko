import { afterEach, describe, expect, it, vi } from "vitest";
import { createOriginLocksFixture } from "../test-utils/origin-locks-fixture";

import {
  acquirePersistentBrowserStreamCapacity,
  backgroundBrowserStreamsSuspended,
  reserveInteractiveBrowserStreamCapacity,
  resetBrowserStreamCapacityForTests,
  subscribeBrowserStreamCapacity,
} from "./browser-stream-capacity";

afterEach(() => {
  resetBrowserStreamCapacityForTests();
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
