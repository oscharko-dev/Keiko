// Shared deterministic non-cryptographic hash-to-id helper (FNV-1a, 32-bit) — stable across runs,
// no IO. Mirrors #754/#811/#752. Extracted from four independent, byte-identical copies previously
// inlined in a11yBaseline.ts, htmlCssAdapter.ts, navGraph.ts, and screenIrTestBaseline.ts (#2905
// KEIKO-0531) so a future change to the algorithm only needs to happen once.

/**
 * Core FNV-1a 32-bit fold. `unicodeAware` selects the iteration unit:
 *  - `false` (default) — iterate UTF-16 code units via `charCodeAt`, the historical behavior used
 *    for plain identifier hashing (a11yBaseline.ts, navGraph.ts, screenIrTestBaseline.ts).
 *  - `true` — iterate Unicode code points via `codePointAt` so a string containing an emoji or
 *    other astral character hashes identically regardless of UTF-16 surrogate-pair splitting
 *    (htmlCssAdapter.ts's CSS class-name hash).
 */
function fnv1a32(key: string, unicodeAware: boolean): number {
  let hash = 0x811c9dc5;
  if (unicodeAware) {
    for (const char of key) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193);
    }
  } else {
    for (let i = 0; i < key.length; i += 1) {
      // Intentional: switching to codePointAt would change the hash for any string containing a
      // surrogate pair, breaking the ids the three non-unicode-aware callers have already
      // emitted. `unicodeAware: true` is the opt-in code-point path.
      hash ^= key.charCodeAt(i); // NOSONAR typescript:S7758
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

/**
 * FNV-1a hash of `key`, rendered in `radix`. `radix: 16` (the default) zero-pads to 8 hex digits
 * to match the fixed-width ids this package emits; `radix: 36` emits the unpadded base-36 form
 * used for CSS class-name suffixes. Pass `unicodeAware: true` to hash by Unicode code point
 * instead of UTF-16 code unit (see `fnv1a32`).
 */
export function fnv1aHex(key: string, radix: 16 | 36 = 16, unicodeAware = false): string {
  const digits = fnv1a32(key, unicodeAware).toString(radix);
  return radix === 16 ? digits.padStart(8, "0") : digits;
}
