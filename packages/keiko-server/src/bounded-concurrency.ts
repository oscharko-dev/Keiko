// Shared order-preserving worker pool for source reads and snapshot construction.
// Limits work in flight without limiting the total number of items processed.

/**
 * Runs each item through `worker`, preserving input order. Invalid concurrency values use one
 * lane; valid values are bounded by the input length. Worker rejection stops further dequeuing
 * and rejects with the original failure. Active workers receive the owned child signal;
 * cooperative workers stop immediately, while uncooperative work cannot dequeue another item.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  parentSignal?: AbortSignal,
): Promise<readonly R[]> => {
  if (items.length === 0) return [];
  const safeLimit = Number.isInteger(limit) && limit >= 1 ? limit : 1;
  const cap = Math.max(1, Math.min(safeLimit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const owned = new AbortController();
  const signal =
    parentSignal === undefined ? owned.signal : AbortSignal.any([parentSignal, owned.signal]);

  const runLane = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined) return;
      signal.throwIfAborted();
      const index = next;
      next += 1;
      if (index >= items.length) return;
      // The index is in range; undefined is a legitimate value when T includes it.
      const item = items[index] as T;
      try {
        results[index] = await worker(item, index, signal);
      } catch (error) {
        failure ??= { error };
        owned.abort(failure.error);
        throw failure.error;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: cap }, () => runLane()));
    return results;
  } finally {
    owned.abort();
  }
};
