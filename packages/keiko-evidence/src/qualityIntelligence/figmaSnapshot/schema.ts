// Persisted Figma Snapshot evidence record (Epic #750, Issue #753, ADR-0023 evidence discipline).
//
// The immutable, redaction-safe on-disk shape of a Figma Snapshot. It mirrors the QI evidence
// manifest posture: a breaking change introduces a NEW `figmaSnapshotSchemaVersion` literal rather
// than mutating this one; every string leaf has passed through redaction before persist; NO token,
// NO secret, NO outbound Figma/render URL, NO header reaches this shape.
//
// The rendered PNG bytes do NOT live inline — they are written as binary side-files and referenced
// here by relative path + sha256 (the same tamper-evidence pattern as ADR-0017 side-files). The
// integrity hashes follow the server builder's deterministic hash projection but are recomputed by
// the evidence store after redaction so they describe the exact persisted artifact. A loaded record
// can then be drift-checked against #735. Optional #752 metadata (`links`, `tokens`) keeps separate
// artifact hashes: they are not drift identity, but downstream consumers must not trust a tampered
// artifact under an otherwise-valid drift hash.
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

/** Why a screen was excluded from the snapshot. The `render-fetch-failed:<CODE>` variant carries
 * the FigmaConnectorErrorCode suffix when the download threw a coded error, letting retention
 * and metrics distinguish misconfigured egress from an unclassified network flake.
 */
export type FigmaSnapshotSkipReason =
  | "render-url-missing"
  | "render-url-blocked"
  | "render-fetch-failed"
  | `render-fetch-failed:${string}`
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

/**
 * A raw inter-screen transition carried for the navigation/flow graph (#811). OPTIONAL and additive:
 * a record without `links` (e.g. an older snapshot) is still valid and the navigation derivation
 * degrades to zero nav items. NOT part of any integrity hash — `links` is non-identity design
 * metadata, so adding it does not change the drift hash (#735). Node ids + trigger are design content
 * (already redaction-safe); no token, secret, or outbound URL ever reaches this shape.
 */
export interface FigmaSnapshotLinkRow {
  readonly sourceNodeId: string;
  readonly trigger: string;
  readonly targetNodeId: string;
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

/** Tamper-evidence for optional #752 artifacts that are hash-neutral for drift identity. */
export interface FigmaSnapshotArtifactHashes {
  readonly links?: string;
  readonly tokens?: string;
  readonly metrics?: string;
}

export interface FigmaSnapshotAugmentationMetrics {
  readonly deterministic: number;
  readonly modelAugmented: number;
  readonly modelAugmentedShare: number;
}

export interface FigmaSnapshotNavGraphMetrics {
  readonly screens: number;
  readonly transitions: number;
}

export interface FigmaSnapshotA11yMetrics {
  readonly findings: number;
}

/** Numeric-only operational metrics from Issue #760. No ids, names, links, text, or token. */
export interface FigmaSnapshotMetrics {
  readonly reductionRatio: number;
  readonly screenCount: number;
  readonly renderCount: number;
  readonly designTokenCount: number;
  readonly augmentation: FigmaSnapshotAugmentationMetrics;
  readonly navGraph?: FigmaSnapshotNavGraphMetrics;
  readonly a11y?: FigmaSnapshotA11yMetrics;
}

export interface FigmaSnapshotRecord {
  readonly figmaSnapshotSchemaVersion: typeof FIGMA_SNAPSHOT_SCHEMA_VERSION;
  readonly runId: string;
  readonly provenance: FigmaSnapshotProvenanceRow;
  readonly screens: readonly FigmaSnapshotScreenRow[];
  readonly skippedScreens: readonly FigmaSnapshotSkippedScreenRow[];
  /** Raw inter-screen transitions for the navigation/flow graph (#811). Optional + additive. */
  readonly links?: readonly FigmaSnapshotLinkRow[];
  /**
   * The deterministic design-tokens artifact (#752) — colours, typography, spacing, radius — kept as
   * an opaque serialised value (like {@link FigmaSnapshotScreenRow.irJson}) so design-to-code (#755)
   * can consume the tokens from the STORED snapshot without re-deriving them (the structural style
   * fields they come from are pruned out of the lean per-screen IR). OPTIONAL + additive: a record
   * without `tokens` (an older snapshot) is still valid and code-gen emits an empty token table. NOT
   * part of any integrity hash — design tokens are non-identity design metadata, so adding them does
   * not change the drift hash (#735). Design content (no token/secret/outbound URL reaches this shape).
   */
  readonly tokens?: unknown;
  /** Durable numeric operational metrics (#760), safe to expose and reload with the snapshot. */
  readonly metrics?: FigmaSnapshotMetrics;
  /** Separate integrity hashes for optional hash-neutral artifacts (`links`/`tokens`) when present. */
  readonly artifactHashes?: FigmaSnapshotArtifactHashes;
  readonly integrityHash: string;
  readonly redactionSummary: FigmaSnapshotRedactionSummary;
}

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>([
  "figmaSnapshotSchemaVersion",
  "runId",
  "provenance",
  "screens",
  "skippedScreens",
  "links",
  "tokens",
  "metrics",
  "artifactHashes",
  "integrityHash",
  "redactionSummary",
]);

const ALLOWED_ARTIFACT_HASH_KEYS: ReadonlySet<string> = new Set<string>([
  "links",
  "tokens",
  "metrics",
]);

const ALLOWED_METRICS_KEYS: ReadonlySet<string> = new Set<string>([
  "reductionRatio",
  "screenCount",
  "renderCount",
  "designTokenCount",
  "augmentation",
  "navGraph",
  "a11y",
]);
const ALLOWED_AUGMENTATION_KEYS: ReadonlySet<string> = new Set<string>([
  "deterministic",
  "modelAugmented",
  "modelAugmentedShare",
]);
const ALLOWED_NAV_GRAPH_KEYS: ReadonlySet<string> = new Set<string>(["screens", "transitions"]);
const ALLOWED_A11Y_KEYS: ReadonlySet<string> = new Set<string>(["findings"]);
const REQUIRED_METRIC_KEYS = [
  "reductionRatio",
  "screenCount",
  "renderCount",
  "designTokenCount",
] as const;

export interface FigmaSnapshotValidationResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

function validateArtifactHashes(value: unknown): FigmaSnapshotValidationResult | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "artifactHashes must be an object" };
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_ARTIFACT_HASH_KEYS.has(key)) {
      return { ok: false, reason: `unknown artifactHashes key: ${key}` };
    }
  }
  return undefined;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function keysAllowed(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateObjectNumbers(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): FigmaSnapshotValidationResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: `${label} must be an object` };
  }
  const record = value as Record<string, unknown>;
  if (!keysAllowed(record, allowed)) {
    return { ok: false, reason: `${label} has unknown keys` };
  }
  for (const key of required) {
    if (!finiteNumber(record[key]))
      return { ok: false, reason: `${label}.${key} must be a number` };
  }
  return undefined;
}

function validateRequiredNumbers(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): FigmaSnapshotValidationResult | undefined {
  for (const key of keys) {
    if (!finiteNumber(record[key]))
      return { ok: false, reason: `${label}.${key} must be a number` };
  }
  return undefined;
}

function validateOptionalNumberObject(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): FigmaSnapshotValidationResult | undefined {
  if (record[key] === undefined) return undefined;
  return validateObjectNumbers(record[key], allowed, required, `metrics.${key}`);
}

function validateMetrics(value: unknown): FigmaSnapshotValidationResult | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "metrics must be an object" };
  }
  const metrics = value as Record<string, unknown>;
  if (!keysAllowed(metrics, ALLOWED_METRICS_KEYS)) {
    return { ok: false, reason: "metrics has unknown keys" };
  }
  const required = validateRequiredNumbers(metrics, REQUIRED_METRIC_KEYS, "metrics");
  if (required !== undefined) return required;
  const aug = validateObjectNumbers(
    metrics.augmentation,
    ALLOWED_AUGMENTATION_KEYS,
    ["deterministic", "modelAugmented", "modelAugmentedShare"],
    "metrics.augmentation",
  );
  if (aug !== undefined) return aug;
  return (
    validateOptionalNumberObject(metrics, "navGraph", ALLOWED_NAV_GRAPH_KEYS, [
      "screens",
      "transitions",
    ]) ?? validateOptionalNumberObject(metrics, "a11y", ALLOWED_A11Y_KEYS, ["findings"])
  );
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
  const artifactHashesValidation = validateArtifactHashes(record.artifactHashes);
  if (artifactHashesValidation !== undefined) return artifactHashesValidation;
  const metricsValidation = validateMetrics(record.metrics);
  if (metricsValidation !== undefined) return metricsValidation;
  return { ok: true, reason: undefined };
}
