const HIGH_SURROGATE_START = 0xd800;
const LOW_SURROGATE_END = 0xdfff;

function isSurrogate(unit: number): boolean {
  return unit >= HIGH_SURROGATE_START && unit <= LOW_SURROGATE_END;
}
function compareWholeCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0);
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Locale-free order by Unicode code point, so a digest never depends on the host's ICU. */
export function compareCodePoints(left: string, right: string): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a === b) continue;
    return isSurrogate(a) || isSurrogate(b) ? compareWholeCodePoints(left, right) : a - b;
  }
  return left.length - right.length;
}
