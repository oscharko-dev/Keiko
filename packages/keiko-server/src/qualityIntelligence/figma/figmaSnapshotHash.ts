// Deterministic integrity hashing for the Figma Snapshot (Epic #750, Issue #753, drift #735).
//
// The hash is the drift identity: same unchanged design ⇒ byte-identical hash, regardless of when
// it was fetched. We therefore canonicalise to a stable key order and EXCLUDE the wall-clock
// `fetchedAt`. The snapshot identity is the pinned Figma `version` + the sorted per-screen
// identities (each = screenId + structural IR + image content sha256). `version` and the IR are
// deterministic outputs of #751/#752; the image sha is included so an unexpected render-byte change
// surfaces as drift too.

import { createHash } from "node:crypto";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";

type ScreenIr = QualityIntelligenceFigma.ScreenIr;

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

// Stable stringify: object keys are emitted in sorted order at every depth so the serialisation is
// independent of insertion order. Arrays keep their (already deterministic) order from #752.
const canonical = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
  return `{${entries.join(",")}}`;
};

/** sha256 over the canonical per-screen identity: {screenId, ir, imageSha256}. */
export const hashScreen = (screenId: string, ir: ScreenIr, imageSha256: string): string =>
  sha256Hex(canonical({ imageSha256, ir, screenId }));

/**
 * sha256 over the canonical snapshot identity: schema version + pinned Figma version + the
 * per-screen hashes sorted by screenId. EXCLUDES `fetchedAt` so the hash is drift-stable across
 * re-fetches of the same unchanged design.
 */
export const hashSnapshot = (
  snapshotSchemaVersion: number,
  version: string | undefined,
  perScreen: readonly { readonly screenId: string; readonly integrityHash: string }[],
): string => {
  const screens = [...perScreen]
    .sort((a, b) => (a.screenId < b.screenId ? -1 : a.screenId > b.screenId ? 1 : 0))
    .map((s) => ({ integrityHash: s.integrityHash, screenId: s.screenId }));
  return sha256Hex(canonical({ screens, snapshotSchemaVersion, version: version ?? null }));
};

export const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
