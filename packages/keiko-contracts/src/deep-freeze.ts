// Recursive runtime immutability for the package's security-relevant constant tables (KEIKO-0139).
//
// `Object.freeze` is SHALLOW and `as const` / `readonly` are compile-time only — TypeScript erases
// both, so a `Object.freeze({...})` around a nested literal leaves every inner object and array
// writable at runtime. That mattered for tables that decide authority:
// `CODING_WORKBENCH_MODE_POLICIES["governed-assist"].effects.delivery.critical = "allowed"` and
// `LEGAL_TRANSITIONS.succeeded.push("running")` both succeeded, and the readers consult those
// objects directly. A plain-JS consumer outside the TypeScript program (this repository has such
// consumers under `scripts/`) or an unsafe-cast call site could therefore rewrite a policy decision
// for the remaining lifetime of the process.
//
// Leaf-package rules (ADR-0019): no imports, no IO, no clock. Pure structural recursion.

// Cycles cannot occur in a frozen constant table declared as a literal, but the seen-set keeps the
// helper total for any input rather than relying on that: a cycle would otherwise recurse forever.
function freezeInto(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  // Own enumerable and non-enumerable values alike — a table is only as immutable as its deepest
  // reachable node.
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    freezeInto(descriptor.value, seen);
  }
}

/**
 * Freezes `value` and every object reachable from it, returning the same reference.
 *
 * Use for a constant table whose nested objects or arrays are part of a security or authority
 * decision. For a flat record, `Object.freeze` alone is sufficient and clearer.
 */
export function deepFreeze<T>(value: T): T {
  freezeInto(value, new WeakSet<object>());
  return value;
}
