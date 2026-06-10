// Bounded-concurrency worker pool for the Figma snapshot-build (Epic #750, Issue #759).
//
// A huge enterprise board has many screens to render and download. Firing every byte-download at
// once would burst the API (inviting 429s) and the host. This runs the per-screen work through a
// fixed, small concurrency cap — order-preserving so the assembled Snapshot is deterministic — and
// is generic over the work it drives (no Figma specifics, no timers, no scheduler).

/**
 * Map `items` through `worker` with at most `limit` invocations in flight at once, preserving
 * input order in the result. `limit` is clamped to `[1, items.length]`. If any worker rejects the
 * whole operation rejects (the snapshot builder turns a per-screen failure into a skip BEFORE it
 * reaches here, so a rejection is a genuine fault, not a partial-render case).
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> => {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const runLane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  };

  await Promise.all(Array.from({ length: cap }, () => runLane()));
  return results;
};
