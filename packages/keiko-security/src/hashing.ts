// Pure, deterministic hashing primitives shared across the security trust boundary. Callers in
// harness, audit, and UI compose these into higher-level fingerprints, evidence digests, and CSP
// hashes without re-deriving the cryptographic boundary in each layer.
//
// Why these helpers live here, not in node:crypto callers: the security package is the leaf trust
// boundary, so the canonical-JSON serialiser and the SHA-256 wrappers belong with redact() and the
// safe-error taxonomy — any future regulated-delivery audit only needs to inspect one module to
// confirm hashing semantics are stable.

import { createHash } from "node:crypto";

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
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalise(v)}`);
  return `{${entries.join(",")}}`;
}

// SHA-256 of a UTF-8 string, hex-encoded. Used for run-fingerprints and any other identifier-style
// digest where hex is the expected format.
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// SHA-256 of a UTF-8 string, base64-encoded. Used for CSP `'sha256-...'` source tokens (RFC 4648
// standard base64, which is what browsers compare CSP hashes against).
export function sha256Base64(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64");
}
