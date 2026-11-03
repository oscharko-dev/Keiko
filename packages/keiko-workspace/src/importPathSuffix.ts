interface SuffixEntry {
  readonly reversed: string;
  readonly path: string;
}

interface SuffixIndex {
  readonly entries: readonly SuffixEntry[];
  readonly resolved: Map<string, string | undefined>;
}

const indexes = new WeakMap<ReadonlySet<string>, SuffixIndex>();

function reverse(value: string): string {
  return value.split("").reverse().join("");
}

function indexFor(paths: ReadonlySet<string>): SuffixIndex {
  const cached = indexes.get(paths);
  if (cached !== undefined) return cached;
  const entries = [...paths].map((path) => ({ reversed: reverse(path.toLowerCase()), path }));
  entries.sort((left, right) =>
    left.reversed < right.reversed ? -1 : Number(left.reversed > right.reversed),
  );
  const index: SuffixIndex = { entries, resolved: new Map() };
  indexes.set(paths, index);
  return index;
}

function lowerBound(entries: readonly SuffixEntry[], prefix: string): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const entry = entries[middle];
    if (entry !== undefined && entry.reversed < prefix) low = middle + 1;
    else high = middle;
  }
  return low;
}

function shortestMatch(entries: readonly SuffixEntry[], prefix: string): string | undefined {
  let best: string | undefined;
  for (let index = lowerBound(entries, prefix); index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.reversed.startsWith(prefix) !== true) break;
    const path = entry.path;
    if (
      best === undefined ||
      path.length < best.length ||
      (path.length === best.length && path < best)
    ) {
      best = path;
    }
  }
  return best;
}

/** Internal resolver for the immutable path inventory of one structural index build. */
export function findImportPathSuffix(
  paths: ReadonlySet<string>,
  normalizedSuffix: string,
): string | undefined {
  const index = indexFor(paths);
  if (index.resolved.has(normalizedSuffix)) return index.resolved.get(normalizedSuffix);
  const match = shortestMatch(index.entries, reverse(normalizedSuffix));
  index.resolved.set(normalizedSuffix, match);
  return match;
}
