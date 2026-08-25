// Exhaustiveness helper for discriminated unions across the Quality Intelligence
// contract surface (Epic #270, Issue #277). Pure; throws at runtime if the type
// system has been bypassed (e.g. via `as`). Mirrors the convention used in
// `memory-internal.ts` (`assertNeverMemoryType`) but is shared by every QI union.
//
// KEIKO-0898: never serialise the whole value into the error message — this helper
// runs on the naming boundary and its thrown TypeError can bubble out through log
// sinks, evidence records, and BFF responses. `JSON.stringify(value)` would echo
// arbitrary properties (potentially the raw body a QI union was carrying) into a
// string the audit ledger's redaction contract must never see. Extract only the
// bounded discriminant `kind` and the typeof.

const DISCRIMINANT_MAX_CHARS = 64;

const readDiscriminant = (value: unknown): string => {
  if (value !== null && typeof value === "object" && "kind" in value) {
    const kind = (value as { readonly kind?: unknown }).kind;
    // Only render primitive kinds — a `kind` field that itself holds an object would default to
    // `[object Object]` via String(), which is misleading and still risks leaking a nested shape.
    if (typeof kind === "string") return kind.slice(0, DISCRIMINANT_MAX_CHARS);
    if (typeof kind === "number" || typeof kind === "boolean") {
      return kind.toString().slice(0, DISCRIMINANT_MAX_CHARS);
    }
    if (kind !== undefined) return typeof kind;
  }
  return typeof value;
};

export const assertQualityIntelligenceNever = (value: never): never => {
  throw new TypeError(`Unexpected Quality Intelligence discriminant: ${readDiscriminant(value)}`);
};
