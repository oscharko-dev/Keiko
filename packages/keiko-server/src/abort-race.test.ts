import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AbortDeadlineRaceError,
  AbortRaceError,
  raceAbort,
  raceAbortDeadline,
} from "./abort-race.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("raceAbort", () => {
  it("settles on cancellation without waiting for the work", async () => {
    const work = deferred<string>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const outcome = raceAbort(work.promise, controller.signal);

    controller.abort();

    await expect(outcome).rejects.toBeInstanceOf(AbortRaceError);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    work.resolve("late");
    await Promise.resolve();
  });

  it("observes a late rejection after cancellation", async () => {
    const work = deferred<string>();
    const controller = new AbortController();
    controller.abort();
    const outcome = raceAbort(work.promise, controller.signal);

    await expect(outcome).rejects.toBeInstanceOf(AbortRaceError);
    work.reject(new Error("late provider rejection"));
    await Promise.resolve();
  });

  it("removes its abort listener when work resolves", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await expect(raceAbort(Promise.resolve("done"), controller.signal)).resolves.toBe("done");

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes its abort listener when work rejects", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await expect(raceAbort(Promise.reject(new Error("failed")), controller.signal)).rejects.toThrow(
      "failed",
    );

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("raceAbortDeadline", () => {
  it("does not start an operation at the absolute deadline", async () => {
    const operation = vi.fn<() => Promise<string>>(() => Promise.resolve("late"));

    await expect(
      raceAbortDeadline(operation, { deadlineAtMs: 10, nowMs: () => 10 }),
    ).rejects.toMatchObject({ reason: "timeout" });

    expect(operation).not.toHaveBeenCalled();
  });

  it("reports timeout when an operation rejects after reaching the deadline", async () => {
    let nowMs = 0;
    const outcome = raceAbortDeadline(
      () => {
        nowMs = 10;
        return Promise.reject(new Error("underlying failure"));
      },
      { deadlineAtMs: 10, nowMs: () => nowMs },
    );

    await expect(outcome).rejects.toMatchObject({ reason: "timeout" });
  });

  it("bounds a never-settling operation and observes its late rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pending = deferred<string>();
    const outcome = raceAbortDeadline(() => pending.promise, {
      deadlineAtMs: 10,
      nowMs: Date.now,
    });
    const expectation = expect(outcome).rejects.toMatchObject({ reason: "timeout" });

    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    pending.reject(new Error("late operation rejection"));
    await Promise.resolve();
  });

  it("forwards cooperative cancellation and removes the caller listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let operationSignal: AbortSignal | undefined;
    let contextKeys: readonly string[] = [];
    const pending = deferred<string>();
    const outcome = raceAbortDeadline(
      (context) => {
        contextKeys = Object.keys(context).sort();
        const { signal } = context;
        operationSignal = signal;
        return pending.promise;
      },
      { deadlineAtMs: 60_000, nowMs: () => 0, signal: controller.signal },
    );
    const expectation = expect(outcome).rejects.toBeInstanceOf(AbortDeadlineRaceError);
    await Promise.resolve();

    controller.abort();

    await expectation;
    expect(operationSignal?.aborted).toBe(true);
    expect(contextKeys).toEqual(["signal", "timeoutMs"]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    pending.resolve("late");
  });

  it("does not let Node clamp a far-future absolute deadline to one millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new AbortController();
    const pending = deferred<string>();
    let receivedTimeoutMs: number | undefined;
    const outcome = raceAbortDeadline(
      ({ timeoutMs }) => {
        receivedTimeoutMs = timeoutMs;
        return pending.promise;
      },
      {
        deadlineAtMs: 2_147_483_647 + 1_000,
        nowMs: Date.now,
        signal: controller.signal,
      },
    );
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(false);
    expect(receivedTimeoutMs).toBe(2_147_483_647);
    const expectation = expect(outcome).rejects.toMatchObject({ reason: "aborted" });
    controller.abort();
    await expectation;
    pending.resolve("late");
  });
});
