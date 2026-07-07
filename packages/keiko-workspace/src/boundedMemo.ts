// Bounded memoization for pure string-keyed derivations on the repo-search hot path.
//
// Search classifies the same path many times per query (discovery walk, candidate bucketing,
// low-value policy, ranking), and across queries the path population of a workspace is stable —
// so per-call recomputation of pure predicates dominates large-repository search latency.
//
// Eviction is a WHOLE-CACHE FLUSH when the cap is reached, not per-entry LRU/FIFO. Search
// iterates paths in a stable order, so with a working set larger than the cap an LRU/FIFO cache
// degrades to a 0% hit rate while still paying delete/insert churn on every call (classic
// sequential-scan thrashing). A generational flush keeps every entry hittable within a
// generation and costs one O(size) clear per cap-fill.
//
// Only use this for functions that are PURE in their key: the cache must never be able to
// change an observable result, only skip recomputation.

export function memoizeByStringKey<V>(
  maxEntries: number,
  compute: (key: string) => V,
): (key: string) => V {
  const cache = new Map<string, V>();
  return (key: string): V => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = compute(key);
    if (cache.size >= maxEntries) {
      cache.clear();
    }
    cache.set(key, value);
    return value;
  };
}

// Path-keyed predicate/classification memos: sized so repositories in the tens of thousands of
// files fit one generation, while worst-case retained memory stays bounded (65k short strings +
// primitive values ≈ a few MB).
export const PATH_MEMO_MAX_ENTRIES = 65_536;
