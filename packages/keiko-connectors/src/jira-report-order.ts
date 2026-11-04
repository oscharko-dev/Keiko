/** Locale-free order by Unicode code point, so a digest never depends on the host's ICU. */
export function compareCodePoints(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done === true || y.done === true)
      return Number(x.done !== true) - Number(y.done !== true);
    const difference = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}
