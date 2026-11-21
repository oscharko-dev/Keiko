// Pure, deterministic hashing primitives shared across the security trust boundary. Callers in
// harness, audit, and UI compose these into higher-level fingerprints, evidence digests, and CSP
// hashes without re-deriving the cryptographic boundary in each layer.
//
// Why these helpers live here, not in node:crypto callers: the security package is the leaf trust
// boundary, so the canonical-JSON serialiser and the SHA-256 wrappers belong with redact() and the
// safe-error taxonomy — any future regulated-delivery audit only needs to inspect one module to
// confirm hashing semantics are stable.

import { createHash } from "node:crypto";

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { isWorkspaceRecord } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

// Canonical JSON: object keys sorted recursively, array order preserved, undefined values omitted
// (matching JSON.stringify semantics). Two structurally equal inputs serialise to byte-identical
// strings regardless of key insertion order, so SHA-256 over the canonical form is order-stable.
export function canonicalise(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalise(item)).join(",")}]`;
  }
  if (!isWorkspaceRecord(value)) {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareStrings(a, b))
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
