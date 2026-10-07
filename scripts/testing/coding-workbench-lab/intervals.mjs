// Interval algebra for the turn profile. A set is a sorted list of disjoint [start, end] pairs of
// seconds; the profile builds one set per kind of time (model, operator pause, tool, gap) and
// subtracts them from each other in a fixed order, so the slices of the wall clock never overlap
// and "other" is whatever no slice claims.

/** The sorted, disjoint union of the pairs; empty and inverted pairs are dropped. */
export function unionOf(intervals) {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .toSorted((left, right) => left[0] - right[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function withoutCut(set, [cutStart, cutEnd]) {
  return set.flatMap(([start, end]) => {
    if (cutEnd <= start || cutStart >= end) return [[start, end]];
    const parts = [];
    if (cutStart > start) parts.push([start, cutStart]);
    if (cutEnd < end) parts.push([cutEnd, end]);
    return parts;
  });
}

/** The parts of `set` that `other` does not cover. */
export function subtract(set, other) {
  return other.reduce(withoutCut, set);
}

/** The parts of `set` inside [from, to]. */
export function clip(set, from, to) {
  return set.flatMap(([start, end]) => {
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end, to);
    return clippedEnd > clippedStart ? [[clippedStart, clippedEnd]] : [];
  });
}

/** The total length of a set in seconds. */
export function lengthOf(set) {
  return set.reduce((total, [start, end]) => total + (end - start), 0);
}
