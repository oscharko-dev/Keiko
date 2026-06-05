// Frozen format table for Quality Intelligence export adapters (Epic #270, Issue #283).
//
// Reuses the `QualityIntelligenceExportAdapter` discriminator from
// `@oscharko-dev/keiko-contracts` so the adapter id is the single source of truth.
// The local re-export under the name `QualityIntelligenceExportFormat` is the
// type alias the public spec calls for; downstream callers may import either
// name.
//
// Pure-domain leaf. NO IO. NO new runtime dependency.

import type { QualityIntelligenceExportAdapter } from "@oscharko-dev/keiko-contracts";

/**
 * Public type alias for the adapter discriminator. Identical in shape to the
 * contract-side `QualityIntelligenceExportAdapter`. Spec-mandated name.
 */
export type QualityIntelligenceExportFormat = QualityIntelligenceExportAdapter;

/**
 * Frozen per-format adapter descriptor. The `adapterId` mirrors the contract
 * adapter name; `bytesPerRowHint` is a deterministic capacity hint for callers
 * that need to pre-size buffers. The hints are static guidance — the actual
 * serialised output is what counts, not the hint.
 */
export interface QualityIntelligenceExportFormatDescriptor {
  readonly format: QualityIntelligenceExportFormat;
  readonly adapterId: QualityIntelligenceExportFormat;
  readonly bytesPerRowHint: number;
  readonly filenameExtension: string;
}

const descriptor = (
  format: QualityIntelligenceExportFormat,
  bytesPerRowHint: number,
  filenameExtension: string,
): QualityIntelligenceExportFormatDescriptor =>
  Object.freeze({ format, adapterId: format, bytesPerRowHint, filenameExtension });

/**
 * Frozen lookup table mapping format → adapter descriptor. Eight formats,
 * mirrors `QUALITY_INTELLIGENCE_EXPORT_ADAPTERS` exactly.
 */
export const QUALITY_INTELLIGENCE_EXPORT_FORMAT_TABLE: Readonly<
  Record<QualityIntelligenceExportFormat, QualityIntelligenceExportFormatDescriptor>
> = Object.freeze({
  "jira-issues": descriptor("jira-issues", 512, "csv"),
  qtest: descriptor("qtest", 384, "csv"),
  xray: descriptor("xray", 384, "csv"),
  polarion: descriptor("polarion", 384, "csv"),
  alm: descriptor("alm", 384, "csv"),
  csv: descriptor("csv", 256, "csv"),
  json: descriptor("json", 1024, "json"),
  "spreadsheet-safe-csv": descriptor("spreadsheet-safe-csv", 256, "csv"),
});

/**
 * Returns the descriptor for `format`. Pure lookup; the table is frozen at
 * module load so the returned reference is stable for the process lifetime.
 */
export function getExportFormatDescriptor(
  format: QualityIntelligenceExportFormat,
): QualityIntelligenceExportFormatDescriptor {
  return QUALITY_INTELLIGENCE_EXPORT_FORMAT_TABLE[format];
}
