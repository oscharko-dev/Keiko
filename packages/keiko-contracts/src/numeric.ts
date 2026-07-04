// Shared numeric primitives (GEN-DUP-SEMANTIC-003).
//
// `clampUnit` is the single canonical [0, 1] clamp several packages had re-implemented
// inline (confidence scores, ranking weights, coverage ratios). Non-finite inputs (NaN,
// -Infinity) and negatives collapse to 0; Infinity and any value >= 1 collapse to 1.
// Pure leaf: no IO, no clock, no randomness, no other keiko-* imports.

/**
 * Clamp `value` into the closed unit interval [0, 1].
 *
 * - `NaN` maps to `0`.
 * - `-Infinity` and any value `<= 0` map to `0`.
 * - `+Infinity` and any value `>= 1` map to `1`.
 * - Otherwise the value is returned unchanged.
 *
 * The `>= 1` test is ordered before the finiteness test so `+Infinity` (which
 * `Number.isFinite` reports as non-finite) still saturates to `1` rather than
 * collapsing to `0`. `NaN` fails every comparison and falls through to the final `0`.
 */
export function clampUnit(value: number): number {
  if (value >= 1) return 1;
  if (value > 0) return value;
  return 0;
}
