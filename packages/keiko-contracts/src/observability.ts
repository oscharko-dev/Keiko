// Shared error-kind classification gate (ADR-0173 D11).
//
// Three packages write an `errorKind` field onto their own activity-log envelope —
// `keiko-server`, `keiko-model-gateway`, `keiko-local-knowledge` — and each classifies an unknown
// thrown value into that field by reading a `code`/`name` property and refusing anything that
// fails a shape gate. Until this module existed, `ERROR_KIND_PATTERN` was declared
// byte-identically in all three, pinned only by a test that diffed the three declarations against
// each other (`scripts/__tests__/error-kind-pattern-drift.test.mjs`, retired in the same change
// that added this file). That test could only ever catch drift AFTER one copy relaxed; it could
// never prevent a fourth copy, in a fourth package, from being declared tomorrow with a wider
// character class. Moving the pattern here — the leaf every other package already depends on
// inward toward, per ADR-0019 — makes that drift structurally impossible: there is exactly one
// declaration, and every writer imports it instead of restating it.
//
// The gate exists because `code` and `name` are PROVIDER- or CALLER-CONTROLLED strings, never
// this repository's: an SDK, a hostile response body, or a bare `Object.assign(new Error(), {
// code: "…" })` call decides them. A conforming value is an identifier, a taxonomy code, or a
// constructor name (`PROXY_BLOCKED_BY_POLICY`, `ECONNREFUSED`, `TypeError`) — never a sentence,
// and never long enough to hide an echoed payload. `errorKind` is an ENVELOPE field, so it
// bypasses the `extra` redaction path entirely: this shape gate is the only thing standing
// between a provider's rejected-input message and a log line an operator will grep in the clear.

/**
 * The shape an error KIND may take: a leading letter, then up to 63 more letters, digits,
 * underscores, dots, or hyphens — 64 characters total. Long enough for every taxonomy code and
 * constructor name this codebase produces, short enough that a sentence — which starts
 * accumulating spaces and punctuation within a handful of words — cannot pass.
 */
export const ERROR_KIND_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * True when `value` is a string conforming to {@link ERROR_KIND_PATTERN}: an identifier, a
 * taxonomy code, or a constructor name, never a sentence. A type guard so a caller can narrow
 * `unknown` directly instead of re-testing after {@link classifyErrorKind} already did the work.
 */
export function isErrorKind(value: unknown): value is string {
  return typeof value === "string" && ERROR_KIND_PATTERN.test(value);
}

/**
 * Returns `value` unchanged when it is a conforming error kind, else `undefined`. This is the
 * exact shape-gated read every package's `code`/`name` reducer performs on a candidate property —
 * factored out so those reducers delegate to one shared decision instead of each restating the
 * regex test. Reading the property itself (and surviving a hostile accessor that throws) stays the
 * caller's job: this function only judges a value already in hand.
 */
export function classifyErrorKind(value: unknown): string | undefined {
  return isErrorKind(value) ? value : undefined;
}
