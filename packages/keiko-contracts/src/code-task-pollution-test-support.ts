// Test-only support for the real-Object.prototype-pollution regression pins across
// code-task-acceptance.test.ts, code-task-run-control.test.ts, code-task-auxiliary.test.ts, and
// code-task-governance.test.ts (Codex P1 3789773829's ownField/hasInheritedEnumerableProperty
// tests). Not part of the package's public surface: it is a sibling-importable module within this
// package's own src/, matching how code-task-run-control.ts already imports value exports from
// code-task-acceptance.ts, but it is never re-exported from index.ts. Lives outside any
// `*.test.ts` file specifically so it is defined once and shared, not duplicated four times --
// CodeRabbit flagged the duplication when this helper was still copy-pasted per file, and predicted
// exactly the bug KfQ 3789982967 then found in that duplicated form.
//
// KfQ 3789982967: the original per-file helper always deleted the polluted key in its `finally`,
// regardless of whether Object.prototype already had an own property under that key before the
// pollution started. For every key this audit series actually pollutes ("value", "outcome", "kind",
// "status", "decision", "operation") that is currently harmless, since none of them collide with a
// real Object.prototype member -- but the helper's OWN correctness must not depend on that staying
// true for every future caller. Capturing the original descriptor with
// Object.getOwnPropertyDescriptor and restoring it (or deleting only when there truly was none)
// makes the helper correct regardless of what key a future test pollutes.
// typescript:S6643 ("Object prototype is read only, properties should not be added") fires on both
// defineProperty calls below. Sound rule for production code; this function's entire purpose is the
// deliberate exception -- exercising the real, global Object.prototype pollution these tests defend
// against is the point (a safe stand-in object cannot reach isRecord's prototype-identity check, so
// only the real prototype proves the guard), and it is always restored in `finally`, per-key, to
// exactly its original descriptor (see the KfQ 3789982967 paragraph above).
export function withPollutedPrototype<T>(
  key: string,
  descriptor: Pick<PropertyDescriptor, "value" | "enumerable" | "writable">,
  run: () => T,
): T {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
  try {
    Object.defineProperty(Object.prototype, key, { configurable: true, ...descriptor }); // NOSONAR typescript:S6643 — deliberate, restored below
    return run();
  } finally {
    if (original) {
      Object.defineProperty(Object.prototype, key, original); // NOSONAR typescript:S6643 — restoring the original descriptor
    } else {
      Reflect.deleteProperty(Object.prototype, key);
    }
  }
}
