// Deterministic UTF-16 code-unit string comparator, identical in order to a bare Array#sort on
// strings but with an explicit compare function (javascript:S2871). Callers that compare sorted
// key sets or hash sorted path lists depend on this exact order, so a locale-aware comparator —
// which reorders digit-bearing keys such as b1/b10/b2 — must never be substituted.
export function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
