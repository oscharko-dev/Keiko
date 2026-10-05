// Shared order-preserving worker pool for source reads and snapshot construction.
// Limits work in flight without limiting the total number of items processed.

interface ConcurrencyLane<T, R> {
  readonly items: readonly T[];
  readonly results: R[];
  readonly worker: (item: T, index: number, signal: AbortSignal) => Promise<R>;
  readonly signal: AbortSignal;
  readonly owned: AbortController;
  next: number;
  failure: { readonly error: unknown } | undefined;
}

function stopLane<T, R>(lane: ConcurrencyLane<T, R>, error: unknown): { readonly error: unknown } {
  lane.failure ??= { error };
  lane.owned.abort(lane.failure.error);
  return lane.failure;
}

async function executeLaneItem<T, R>(
  lane: ConcurrencyLane<T, R>,
): Promise<
  { readonly done: true } | { readonly done: false; readonly index: number; readonly result: R }
> {
  try {
    lane.signal.throwIfAborted();
    const index = lane.next++;
    if (index >= lane.items.length) return { done: true };
    // The index is in range; undefined is a legitimate value when T includes it.
    const result = await lane.worker(lane.items[index] as T, index, lane.signal);
    return { done: false, index, result };
  } catch (error) {
    stopLane(lane, error);
    throw error;
  }
}

function runLane<T, R>(lane: ConcurrencyLane<T, R>): Promise<void> {
  return new Promise<ConcurrencyLane<T, R>["failure"]>((resolve) => {
    const fail = (error: unknown): void => {
      resolve(stopLane(lane, error));
    };
    const advance = (): void => {
      if (lane.failure !== undefined) {
        resolve(undefined);
        return;
      }
      // Each settled attempt schedules one successor, retaining only the active lane.
      void executeLaneItem(lane).then((item) => {
        if (item.done) resolve(undefined);
        else {
          lane.results[item.index] = item.result;
          advance();
        }
      }, fail);
    };
    advance();
  }).then((failure) => {
    if (failure !== undefined) throw failure.error;
  });
}

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
  const owned = new AbortController();
  const signal =
    parentSignal === undefined ? owned.signal : AbortSignal.any([parentSignal, owned.signal]);
  const lane: ConcurrencyLane<T, R> = {
    items,
    results,
    worker,
    signal,
    owned,
    next: 0,
    failure: undefined,
  };
  try {
    await Promise.all(Array.from({ length: cap }, () => runLane(lane)));
    return results;
  } finally {
    owned.abort();
  }
};

/** Lazily starts one operation at a time; consumer exit closes the source without prefetch. */
export async function* iterateSequentialResults<T, R>(
  items: Iterable<T>,
  operation: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  for (const item of items) yield operation(item);
}
