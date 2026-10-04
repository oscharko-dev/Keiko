// Shared order-preserving worker pool for source reads and snapshot construction.
// Limits work in flight without limiting the total number of items processed.

/**
 * Runs each item through `worker`, preserving input order. Invalid concurrency values use one
 * lane; valid values are bounded by the input length. Worker rejection stops further dequeuing
 * and rejects the operation. Already-running workers may finish.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> => {
  if (items.length === 0) return [];
  const safeLimit = Number.isInteger(limit) && limit >= 1 ? limit : 1;
  const cap = Math.max(1, Math.min(safeLimit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;

  const runLane = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: cap }, () => runLane()));
  return results;
};
