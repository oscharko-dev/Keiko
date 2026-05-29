// A deliberately buggy function for the bug-investigation integration fixture. `half` should divide
// by 2 but divides by 3, so the regression test in tests/buggy.test.ts FAILS before the fix and
// PASSES after the integration test applies the corrected diff (D11: fail-before / pass-after gives
// real evidence even though the workflow does not run the pre-patch baseline).
export const half = (n: number): number => n / 3;
