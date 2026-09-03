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

interface ErrorConstructorMetadata {
  readonly name: unknown;
  readonly prototype: unknown;
}

function isPropertyReceiver(value: unknown): value is UnknownPropertyReceiver {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isCallableErrorConstructor(value: unknown): value is ErrorConstructorMetadata {
  return typeof value === "function";
}

// Reflective reads from a thrown value are hostile-input reads: accessors and proxy traps may
// throw. Every optional machine field, and every field this module reads off an unknown error,
// goes through this helper and degrades to absence.
export function safeProperty(value: unknown, property: string): unknown {
  if (!isPropertyReceiver(value)) return undefined;
  try {
    return value[property];
  } catch {
    return undefined;
  }
}

// Property descriptors returned by the runtime are fresh plain records. Inspect their OWN data
// slot rather than reading `descriptor.value` directly: a hostile Object.prototype accessor must
// not turn an accessor descriptor into a data descriptor or execute while an error is classified.
function dataDescriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (descriptor === undefined) return undefined;
  return Reflect.getOwnPropertyDescriptor(descriptor, "value")?.value;
}

function ownDataProperty(value: object, property: string): unknown {
  return dataDescriptorValue(Reflect.getOwnPropertyDescriptor(value, property));
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

    // Keep constructor reflection descriptor-based and expose only its metadata shape after the
    // runtime callable check. Passing a directly function-narrowed value back into a generic
    // reflection helper made Sonar's architecture serializer emit an invalid native-function key
    // and discard this source's UDG. The descriptors also avoid executing hostile accessors.
    const ctor = ownDataProperty(proto, "constructor");
    if (!isCallableErrorConstructor(ctor)) return undefined;
    const declaredPrototype = ownDataProperty(ctor, "prototype");
    if (declaredPrototype !== proto) return undefined;
    const name = ownDataProperty(ctor, "name");
    if (typeof name !== "string") return undefined;
    if (!DECLARED_ERROR_CLASS_SHAPE.test(name)) return undefined;
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
    const name = safeProperty(error, "name");
    if (typeof name === "string" && SPECIFIC_BUILT_IN_ERROR_NAMES.has(name)) return name;
    return declaredErrorClassName(error) ?? "Error";
  } catch {
    // Reflection over a hostile value (a proxy trap or throwing accessor) must never turn the
    // diagnostic path into a second failure; degrade to the generic class instead.
    return "Error";
  }
}
