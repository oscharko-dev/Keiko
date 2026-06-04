// Deterministic run-ID and configuration-fingerprint sources. Production uses
// node:crypto (randomUUID) for the random ID source and the shared security-package
// hashing primitives (canonical-JSON + SHA-256 hex) for the config fingerprint; tests
// inject a counter so IDs are fixed and runs are reproducible for replay (ADR-0004 D7).

import { randomUUID } from "node:crypto";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { Fingerprinter, FingerprintInput, IdSource } from "./ports.js";

export function configFingerprint(input: FingerprintInput): string {
  return sha256Hex(canonicalise(input));
}

export const defaultFingerprinter: Fingerprinter = {
  compute: configFingerprint,
};

export const defaultIdSource: IdSource = {
  newRunId: (): string => randomUUID(),
};

// Test/replay helper: deterministic monotonically increasing run IDs.
export function counterIdSource(): IdSource {
  let n = 0;
  return {
    newRunId: (): string => {
      n += 1;
      return `run-${String(n)}`;
    },
  };
}

// Re-export the canonical-JSON serialiser at its historical name for any caller that still imports
// it from this module. The implementation now lives in @oscharko-dev/keiko-security/hashing.
export { canonicalise };
