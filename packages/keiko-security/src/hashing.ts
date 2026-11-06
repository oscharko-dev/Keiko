// SHA-256 wrappers remain owned by the security trust boundary. Canonical JSON is the same
// pure shared Contracts function, re-exported here to preserve every existing Security API.
// Browser-safe consumers can use that leaf without importing node:crypto.

import { createHash } from "node:crypto";
export { canonicalise } from "@oscharko-dev/keiko-contracts/runtime/canonical-json";

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
