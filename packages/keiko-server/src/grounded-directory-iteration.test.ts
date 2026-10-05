import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDirEntry } from "@oscharko-dev/keiko-workspace";
import { observeDirectoryIteration } from "./grounded-directory-iteration.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const ENTRY: WorkspaceDirEntry = {
  name: "entry.txt",
  isDirectory: false,
  isFile: true,
  isSymbolicLink: false,
};

describe("owned directory cleanup observation", () => {
  it.each([true, false])(
    "records late next and return failures once per distinct failure (same=%s)",
    async (same) => {
      const read = deferred<IteratorResult<WorkspaceDirEntry>>();
      const close = deferred<IteratorResult<WorkspaceDirEntry>>();
      const readFailure = new TypeError("private read detail");
      const closeFailure = same ? readFailure : new Error("private close detail");
      const reported = vi.fn<(error: unknown) => void>();
      const queued = vi.fn();
      const entries = vi.fn();
      const iterator = observeDirectoryIteration(
        {
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<WorkspaceDirEntry>> => read.promise,
            return: (): Promise<IteratorResult<WorkspaceDirEntry>> => close.promise,
          }),
        },
        entries,
        reported,
        queued,
      )[Symbol.asyncIterator]();
      const next = iterator.next();
      const closing = iterator.return?.();
      const nextRejected = expect(next).rejects.toBe(readFailure);
      const closeRejected = expect(closing).rejects.toBe(closeFailure);
      expect(queued).toHaveBeenCalledExactlyOnceWith(closing);
      expect(reported).not.toHaveBeenCalled();
      expect(iterator.return?.()).toBe(closing);
      read.reject(readFailure);
      await nextRejected;
      close.reject(closeFailure);
      await closeRejected;
      expect(entries).not.toHaveBeenCalled();
      expect(reported.mock.calls.map(([error]) => error)).toEqual(
        same ? [readFailure] : [readFailure, closeFailure],
      );
    },
  );

  it("leaves an ordinary next failure to the retrieval owner without calling it cleanup", async () => {
    const failure = new TypeError("private matcher detail");
    const reported = vi.fn<(error: unknown) => void>();
    const iterator = observeDirectoryIteration(
      {
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<WorkspaceDirEntry>> => Promise.reject(failure),
        }),
      },
      vi.fn(),
      reported,
      vi.fn(),
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(failure);
    expect(reported).not.toHaveBeenCalled();
  });

  it("retains queued closure until a real async generator finishes its pending read", async () => {
    const started = deferred<undefined>();
    const release = deferred<undefined>();
    let closed = false;
    const recorded: Promise<unknown>[] = [];
    const reported = vi.fn<(error: unknown) => void>();
    async function* source(): AsyncIterable<WorkspaceDirEntry> {
      try {
        started.resolve(undefined);
        await release.promise;
        yield ENTRY;
      } finally {
        closed = true;
      }
    }
    const iterator = observeDirectoryIteration(source(), vi.fn(), reported, (promise) =>
      recorded.push(promise),
    )[Symbol.asyncIterator]();
    const next = iterator.next();
    await started.promise;
    const closing = iterator.return?.();
    expect(recorded).toEqual([closing]);
    expect(closed).toBe(false);
    release.resolve(undefined);
    await next;
    await closing;
    expect(closed).toBe(true);
    expect(reported).not.toHaveBeenCalled();
  });
});
