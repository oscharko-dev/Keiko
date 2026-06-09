// Figma Snapshot value types (Epic #750, Issue #753).
//
// The Snapshot is the immutable, self-contained artifact assembled at the end of the bounded
// snapshot-build: per-screen IR (from #752) + the rendered PNG bytes + token-free provenance
// (from #751) + per-screen and snapshot integrity hashes. Once assembled it is the communication
// boundary — every downstream stage (#754 QI source, #755 codegen) reads ONLY this value and
// NEVER re-contacts Figma.
//
// These are the IN-MEMORY assembly types produced by the builder. The persisted, redacted,
// side-file-backed evidence shape lives in keiko-evidence (figmaSnapshot/schema.ts); the store
// strips the inline bytes onto disk and records a side-file ref. NO token is present on any of
// these types by construction.

import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { FigmaProvenance } from "./figmaConnector.js";

type ScreenIr = QualityIntelligenceFigma.ScreenIr;

/** The rendered image for one screen — raw bytes plus their content hash (tamper-evidence). */
export interface FigmaRenderedImage {
  readonly mimeType: "image/png";
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
}

/** One assembled screen: the structural IR plus its render. */
export interface FigmaSnapshotScreen {
  readonly screenId: string;
  readonly ir: ScreenIr;
  readonly image: FigmaRenderedImage;
  /** sha256 over the canonical {screenId, ir, imageSha256} body — the per-screen drift identity. */
  readonly integrityHash: string;
}

/** Why a detected screen produced no render and was excluded from `screens` (partial-render). */
export type FigmaSkippedScreenReason =
  | "render-url-missing"
  | "render-fetch-failed"
  | "render-empty"
  | "render-oversized";

export interface FigmaSkippedScreen {
  readonly screenId: string;
  readonly reason: FigmaSkippedScreenReason;
}

/**
 * The immutable Figma Snapshot value. `integrityHash` is DETERMINISTIC for drift detection
 * (#735): it is keyed on the pinned Figma `version` + the sorted per-screen identities, and
 * deliberately EXCLUDES the wall-clock `fetchedAt` so two snapshots of the same unchanged design
 * at different times hash identically. `provenance.fetchedAt` is retained for audit only.
 */
export interface FigmaSnapshot {
  readonly snapshotSchemaVersion: 1;
  readonly provenance: FigmaProvenance;
  readonly screens: readonly FigmaSnapshotScreen[];
  readonly skippedScreens: readonly FigmaSkippedScreen[];
  readonly integrityHash: string;
}
