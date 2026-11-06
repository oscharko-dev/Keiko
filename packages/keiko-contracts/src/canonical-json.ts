import { compareStrings } from "./comparators.js";

// Canonical JSON: object keys sorted recursively, array order preserved, undefined values omitted
// (matching JSON.stringify semantics). Two structurally equal inputs serialise to byte-identical
// strings regardless of key insertion order, so SHA-256 over the canonical form is order-stable.
export function canonicalise(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalise(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalise(v)}`);
  return `{${entries.join(",")}}`;
}
