import type { WorkspaceDirEntry } from "@oscharko-dev/keiko-workspace";

/** Observe physical cleanup without equating a queued return with a released directory handle. */
export function observeDirectoryIteration(
  entries: AsyncIterable<WorkspaceDirEntry>,
  onEntry: () => void,
  onCleanupFailure: (error: unknown) => void,
  onCleanup: (cleanup: Promise<unknown>) => void,
): AsyncIterable<WorkspaceDirEntry> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WorkspaceDirEntry> {
      const iterator = entries[Symbol.asyncIterator]();
      let closing: Promise<IteratorResult<WorkspaceDirEntry>> | undefined;
      const failures = new Set<unknown>();
      const failed = (error: unknown): void => {
        if (failures.has(error)) return;
        failures.add(error);
        onCleanupFailure(error);
      };
      return {
        next: async (): Promise<IteratorResult<WorkspaceDirEntry>> => {
          try {
            const entry = await iterator.next();
            if (entry.done !== true) onEntry();
            return entry;
          } catch (error) {
            if (closing !== undefined) failed(error);
            throw error;
          }
        },
        return: (): Promise<IteratorResult<WorkspaceDirEntry>> => {
          if (closing !== undefined) return closing;
          closing = closeObservedIterator(iterator, failed);
          onCleanup(closing);
          return closing;
        },
      };
    },
  };
}

async function closeObservedIterator(
  iterator: AsyncIterator<WorkspaceDirEntry>,
  onFailure: (error: unknown) => void,
): Promise<IteratorResult<WorkspaceDirEntry>> {
  try {
    return (await iterator.return?.()) ?? { done: true, value: undefined };
  } catch (error) {
    onFailure(error);
    throw error;
  }
}

export function directoryCleanupTracker(): {
  observe: (cleanup: Promise<unknown>) => void;
  pendingCount: () => number;
} {
  const pending = new Set<Promise<unknown>>();
  return {
    observe: (cleanup): void => {
      pending.add(cleanup);
      const settled = (): void => {
        pending.delete(cleanup);
      };
      void cleanup.then(settled, settled);
    },
    pendingCount: (): number => pending.size,
  };
}
