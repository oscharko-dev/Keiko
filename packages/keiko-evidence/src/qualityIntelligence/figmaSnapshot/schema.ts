// Persisted Figma Snapshot evidence record (Epic #750, Issue #753, ADR-0023 evidence discipline).
//
// The immutable, redaction-safe on-disk shape of a Figma Snapshot. It mirrors the QI evidence
// manifest posture: a breaking change introduces a NEW `figmaSnapshotSchemaVersion` literal rather
// than mutating this one; every string leaf has passed through redaction before persist; NO token,
// NO secret, NO outbound url, NO header reaches this shape.
//
// The rendered PNG bytes do NOT live inline — they are written as binary side-files and referenced
// here by relative path + sha256 (the same tamper-evidence pattern as ADR-0017 side-files). The
// integrity hashes are computed by the server builder over the in-memory Snapshot BEFORE persist
// and are reproduced here verbatim, so a loaded record can be drift-checked against #735.
//
// `irJson` is the structural Screen-IR (#752) serialised as an opaque JSON value. It is design
// CONTENT — the artifact's purpose — and is kept (not redacted away); only secrets are stripped.

export const FIGMA_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** A reference to one rendered screen image written as a binary side-file. */
export interface FigmaSnapshotImageRef {
  readonly mimeType: "image/png";
  /** Path RELATIVE to the per-run side-file subdir. */
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export type FigmaSnapshotSkipReason =
  | "render-url-missing"
  | "render-fetch-failed"
  | "render-empty"
  | "render-oversized";

export interface FigmaSnapshotSkippedScreenRow {
  readonly screenId: string;
  readonly reason: FigmaSnapshotSkipReason;
}

export interface FigmaSnapshotScreenRow {
  readonly screenId: string;
  /** Opaque serialised Screen-IR (#752). Design content — kept, not redacted away. */
  readonly irJson: unknown;
  readonly image: FigmaSnapshotImageRef;
  readonly integrityHash: string;
}

/** Token-free provenance carried for audit. `fetchedAt` is audit-only and NOT in any hash. */
export interface FigmaSnapshotProvenanceRow {
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version: string | undefined;
  readonly fetchedAt: string;
}

export interface FigmaSnapshotRedactionSummary {
  readonly totalStringsScanned: number;
  readonly stringsRedacted: number;
  readonly patternsMatched: Readonly<Record<string, number>>;
}

export interface FigmaSnapshotRecord {
  readonly figmaSnapshotSchemaVersion: typeof FIGMA_SNAPSHOT_SCHEMA_VERSION;
  readonly runId: string;
  readonly provenance: FigmaSnapshotProvenanceRow;
  readonly screens: readonly FigmaSnapshotScreenRow[];
  readonly skippedScreens: readonly FigmaSnapshotSkippedScreenRow[];
  readonly integrityHash: string;
  readonly redactionSummary: FigmaSnapshotRedactionSummary;
}

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>([
  "figmaSnapshotSchemaVersion",
  "runId",
  "provenance",
  "screens",
  "skippedScreens",
  "integrityHash",
  "redactionSummary",
]);

export interface FigmaSnapshotValidationResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

// Strict-schema gate for a deserialised snapshot record: schema-version literal + closed key set.
// Structural correctness of the integrity hashes is the builder's responsibility, not this gate's.
export function validateFigmaSnapshotRecord(value: unknown): FigmaSnapshotValidationResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "record is not an object" };
  }
  const record = value as Record<string, unknown>;
  if (record.figmaSnapshotSchemaVersion !== FIGMA_SNAPSHOT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unexpected figmaSnapshotSchemaVersion (expected ${String(FIGMA_SNAPSHOT_SCHEMA_VERSION)})`,
    };
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, reason: `unknown record key: ${key}` };
    }
  }
  if (!Array.isArray(record.screens) || !Array.isArray(record.skippedScreens)) {
    return { ok: false, reason: "screens and skippedScreens must be arrays" };
  }
  return { ok: true, reason: undefined };
}
