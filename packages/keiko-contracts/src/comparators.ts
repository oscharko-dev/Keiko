// Shared deterministic comparators (epic #2719 W4, issue #2723). Dozens of call sites across the
// monorepo sorted string keys with a locally re-declared `a < b ? -1 : a > b ? 1 : 0` — one
// canonical, fully-tested implementation here instead of re-deriving it at every call site.
// Deliberately plain code-unit comparison, not `String#localeCompare`: locale-aware comparison
// reorders digit-bearing keys (e.g. "b1"/"b10"/"b2") and would silently change the sort order of
// every caller that depends on this exact, locale-independent order.
// Leaf-package rule (ADR-0019): no @oscharko-dev/keiko-* imports; pure functions only.

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
