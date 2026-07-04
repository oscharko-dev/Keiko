// Shared path helper for the bug-investigation seam (ADR-0009). A single owner for the
// backslash→forward-slash normalization used by failure-parse (frame files), context (ranking
// paths), and guard (scope predicates). Pure string op: no IO, no clock, no RNG, no regex — so it
// adds no ReDoS surface and stays safe on attacker-influenceable failure output.

// Normalizes Windows-style backslash separators to POSIX forward slashes. `a\b\c` -> `a/b/c`.
export const toPosix = (value: string): string => value.split("\\").join("/");
