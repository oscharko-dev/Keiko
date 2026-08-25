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

  protected constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
    this.name = new.target.name;
  }
}

/**
 * Derive the HTTP status for `code` from a per-domain STATUS_MAP.
 *
 * Two layers of protection, deliberately paired:
 * - **Compile time**: the exhaustive `Record<C, number>` key type on every STATUS_MAP
 *   definition makes a forgotten code a compile error at the map site.
 * - **Runtime (KEIKO-0859)**: a code reaching this function from a widened / deserialized
 *   string (an `as C` upcast, a prototype-chain read like `constructor`, a hand-maintained map
 *   the compiler cannot see) falls back to `500` instead of leaking `undefined` into the
 *   thrown error's `status`. This is defence-in-depth for the compile-time exhaustiveness,
 *   NOT a replacement — the callers all pass the result straight into a `CodedHttpError`
 *   constructor's `status` field expecting a number.
 */
export function httpStatusFor<C extends string>(map: Readonly<Record<C, number>>, code: C): number {
  const status = map[code];
  return typeof status === "number" ? status : 500;
}
