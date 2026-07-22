import { describe, expect, it, vi } from "vitest";
import { AbortRaceError, raceAbort } from "./abort-race.js";

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
