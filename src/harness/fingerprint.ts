// Deterministic run-ID and configuration-fingerprint sources. Production uses
// node:crypto (randomUUID, SHA-256); tests inject a counter so IDs are fixed and
// runs are reproducible for replay (ADR-0004 D7).

import { createHash, randomUUID } from "node:crypto";
import type { Fingerprinter, FingerprintInput, IdSource } from "./ports.js";

// Canonical JSON: object keys sorted recursively, array order preserved, undefined
// values omitted (matching JSON.stringify semantics). Two structurally equal configs
// thus serialise to byte-identical strings regardless of key insertion order.
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

export function configFingerprint(input: FingerprintInput): string {
  const canonical = canonicalise(input);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
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
