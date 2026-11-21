// Content-free error classification — the leaf every diagnostics producer in this package
// classifies an unknown thrown value through (ADR-0173 D11).
//
// WHY THIS IS A LEAF (NO IMPORT FROM `server-log.ts` OR `../diagnostics-log.ts`)
//
// `diagnostics-log.ts` already depends on `./observability/server-log.js` (for
// `createFileServerLogSink`), so `server-log.ts` cannot import back from `diagnostics-log.ts`
// without forming a cycle — and `server-log.ts`'s own `errorKindOf` needs exactly the hardened
// classification this module provides, instead of maintaining a second, less-hardened
// regex-based reader. Moving the classification primitives here, with no import of either
// module, lets both depend inward on it: `diagnostics-log.ts` re-exports these names so every
// existing import site keeps working unchanged, and `server-log.ts` / `stack-frames.ts` import
// straight from here.
//
// WHY A HOSTILE THROWN VALUE NEVER CRASHES CLASSIFICATION
//
// Every reflective read below assumes the value it is reading was NOT constructed by this
// codebase: a thrown value, its prototype chain, and any property on it are attacker- or
// provider-controlled. A proxy trap or a throwing accessor must degrade to the safe, generic
// answer rather than propagate — classifying a failure must never itself become a second failure.

/**
 * `Error.name` and the instance's `constructor` are plain mutable own properties: a hostile
 * thrown value — or a buggy merge of request data onto an error — can load them with
 * request-derived text. A name passes only when it is one of these SPECIFIC well-known
 * built-ins, which legitimately ride on generic `Error`/`DOMException` instances (e.g. an abort
 * reason named "AbortError") where the declared class name would erase the useful distinction.
 * The generic "Error" is deliberately NOT in the set: for it, the code-declared class name is the
 * more specific, equally safe label.
 */
export const SPECIFIC_BUILT_IN_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
]);

/**
 * Class names come from code (class declarations), never from request data, so a bounded,
 * identifier-shaped constructor name is safe to surface.
 */
export const DECLARED_ERROR_CLASS_SHAPE = /^[A-Z][A-Za-z0-9]{0,63}$/;

/**
 * Machine tokens (`code`, `requestId`) reuse the correlation-id alphabet: no whitespace, no
 * prose, bounded length.
 */
export const MACHINE_TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

type UnknownPropertyReceiver = Readonly<Record<string, unknown>>;

function isPropertyReceiver(value: unknown): value is UnknownPropertyReceiver {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function constructorShape(): void {
  return undefined;
}

// SonarCloud's TypeScript architecture serializer currently folds the literal "constructor" on
// an unknown object to the native Object function and emits an unreadable UDG. Deriving the same
// standard key from a code-owned prototype preserves the runtime lookup without putting that
// literal into the reflective call. The hosted full-analysis evidence gate pins the workaround.
const CONSTRUCTOR_KEY = Object.getOwnPropertyNames(constructorShape.prototype).at(0) ?? "";

// The fields a classifier reads from a thrown value it did not build. Every value is untrusted
// until one of the typed readers below has checked it.
export interface ThrownErrorFields {
  readonly cause?: unknown;
  readonly code?: unknown;
  readonly errors?: unknown;
  readonly kind?: unknown;
  readonly name?: unknown;
  readonly partialUsage?: unknown;
  readonly reason?: unknown;
  readonly requestId?: unknown;
}

// Admits any value a property can be read from (an object or a function); a primitive has no
// fields to read.
export function thrownErrorFields(value: unknown): ThrownErrorFields | undefined {
  return isPropertyReceiver(value) ? value : undefined;
}

// Reflective reads from a thrown value are hostile-input reads: accessors and proxy traps may
// throw. Every read this module and its consumers make off an unknown error runs inside `read`
// here, and a throw degrades to absence.
export function safeProperty<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function errorStringField(
  fields: ThrownErrorFields | undefined,
  field: keyof ThrownErrorFields,
): string | undefined {
  return safeProperty(() => {
    const value = fields?.[field];
    return typeof value === "string" ? value : undefined;
  });
}

// An object or function field, such as a `cause` whose own fields are read next.
export function errorObjectField(
  fields: ThrownErrorFields | undefined,
  field: keyof ThrownErrorFields,
): object | undefined {
  return safeProperty(() => {
    const value = fields?.[field];
    return isPropertyReceiver(value) ? value : undefined;
  });
}

// An array field, such as `AggregateError.errors`. Its elements are thrown values themselves.
export function errorArrayField(
  fields: ThrownErrorFields | undefined,
  field: keyof ThrownErrorFields,
): readonly unknown[] | undefined {
  return safeProperty(() => {
    const value = fields?.[field];
    return Array.isArray(value) ? value : undefined;
  });
}

// Forwards a `code`/`requestId` style value only when it is a bounded machine token: the charset
// and length bound exclude prose, whitespace, and oversized payloads. Values are dropped, never
// rewritten, so the field stays machine-parseable or absent. The message redactor is deliberately
// NOT consulted here — producers that redact by constant message would otherwise lose every token.
export function machineToken(value: unknown): string | undefined {
  return typeof value === "string" && MACHINE_TOKEN_SHAPE.test(value) ? value : undefined;
}

// Reads the constructor name off the PROTOTYPE (not the instance) so an own-property
// `constructor` planted by hostile data cannot shadow the code-declared class. Exported (rather
// than kept module-private, as it was before this file existed) only because it moved out of
// `diagnostics-log.ts` verbatim as part of the ADR-0173 D11 leaf extraction and that module
// re-exports it; no producer outside `contentFreeErrorClass` has a use for it on its own.
export function declaredErrorClassName(error: Error): string | undefined {
  try {
    const proto = Reflect.getPrototypeOf(error);
    if (proto === null) return undefined;

    const ctor = safeProperty(() => {
      const value = isPropertyReceiver(proto) ? proto[CONSTRUCTOR_KEY] : undefined;
      return typeof value === "function" ? value : undefined;
    });
    const name = errorStringField(ctor, "name");
    if (name === undefined || !DECLARED_ERROR_CLASS_SHAPE.test(name)) return undefined;
    return name;
  } catch {
    // Every reflection point above may be trapped by hostile input. This function is exported and
    // cannot rely on `contentFreeErrorClass`'s outer try/catch to absorb the throw for it.
    return undefined;
  }
}

// Resolves the content-free class of an unknown thrown value: a specific built-in error name, else
// the class name declared in code (recovering subclasses that never assign `this.name`), else the
// generic "Error" (or `typeof` for non-Error throws). Shared by every diagnostics producer that
// labels an error, so the mutable-`name` hardening lives in exactly one place.
export function contentFreeErrorClass(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error;
    const name = errorStringField(error, "name");
    if (name !== undefined && SPECIFIC_BUILT_IN_ERROR_NAMES.has(name)) return name;
    return declaredErrorClassName(error) ?? "Error";
  } catch {
    // Reflection over a hostile value (a proxy trap or throwing accessor) must never turn the
    // diagnostic path into a second failure; degrade to the generic class instead.
    return "Error";
  }
}
