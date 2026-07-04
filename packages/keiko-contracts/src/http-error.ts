// Shared coded-HTTP-error mechanism (GEN-DUP-NEAR-008).
//
// Several packages had re-implemented the same status-derivation skeleton: an error class
// carrying a stable string `code` plus the HTTP `status` derived from a per-domain
// `Readonly<Record<Code, number>>` STATUS_MAP. Only the MECHANISM is shared here; each
// domain keeps its own code list and its own STATUS_MAP so the taxonomies never merge.
//
// Pure leaf: no IO, no clock, no randomness, no other keiko-* imports.

/**
 * Base class for domain errors that carry a stable machine-readable `code` and the HTTP
 * `status` derived from that code. Subclasses declare the concrete `code` (a string-literal
 * union member) and pass the STATUS_MAP-derived status up through the constructor.
 *
 * `name` is set to the concrete subclass name via `new.target` so stack traces and logs
 * identify the real error type rather than "CodedHttpError".
 */
export abstract class CodedHttpError extends Error {
  abstract readonly code: string;
  readonly status: number;

  protected constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = new.target.name;
  }
}

/**
 * Derive the HTTP status for `code` from a per-domain STATUS_MAP. Tiny by design: it exists
 * so the lookup site is a single named, tested call rather than an inline `map[code]` that
 * silently returns `undefined` if a code was forgotten (the exhaustive `Record<C, number>`
 * key type makes the omission a compile error at the map's definition).
 */
export function httpStatusFor<C extends string>(map: Readonly<Record<C, number>>, code: C): number {
  return map[code];
}
