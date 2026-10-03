import { afterEach, describe, expect, it, vi } from "vitest";

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

interface QueuedLock {
  readonly signal: AbortSignal;
  readonly grant: () => void;
}

function fakeOriginLocks(): {
  request: (
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<void>,
  ) => Promise<void>;
} {
  const busy = new Set<string>();
  const queues = new Map<string, QueuedLock[]>();
  const drain = (name: string): void => {
    if (busy.has(name)) return;
    const next = queues.get(name)?.shift();
    if (next === undefined) return;
    if (next.signal.aborted) drain(name);
    else next.grant();
  };
  return {
    request: (name, options, callback): Promise<void> =>
      new Promise((resolve, reject) => {
        const grant = (): void => {
          busy.add(name);
          void callback()
            .then(resolve, reject)
            .finally(() => {
              busy.delete(name);
              drain(name);
            });
        };
        options.signal.addEventListener(
          "abort",
          () => {
            if (!busy.has(name)) drain(name);
            reject(new DOMException("Cancelled", "AbortError"));
          },
          { once: true },
        );
        const queue = queues.get(name) ?? [];
        queue.push({ signal: options.signal, grant });
        queues.set(name, queue);
        drain(name);
      }),
  };
}

describe("origin-wide persistent stream capacity", () => {
  it("limits independent consumers to three origin slots and yields every five seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: fakeOriginLocks() });
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
    vi.stubGlobal("navigator", { locks: fakeOriginLocks() });
    const held = Array.from({ length: 3 }, () =>
      acquirePersistentBrowserStreamCapacity(vi.fn(), vi.fn()),
    );
    const grant = vi.fn();
    const release = vi.fn();
    const cancel = acquirePersistentBrowserStreamCapacity(grant, release);
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
