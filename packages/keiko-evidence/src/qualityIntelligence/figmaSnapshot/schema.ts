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
  | "render-screen-cap-exceeded"
  | "render-fetch-failed"
  | `render-fetch-failed:${string}`
  | "render-empty"
  | "render-invalid-png"
  | "render-budget-exceeded"
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

/** A screen whose structural Screen-IR is persisted but whose PNG render is absent. */
export interface FigmaSnapshotStructuralScreenRow {
  readonly screenId: string;
  /** Why the screen has no render side-file. Mirrors the matching skippedScreens row. */
  readonly reason: FigmaSnapshotSkipReason;
  /** Opaque serialised Screen-IR (#752). Design content — kept, not redacted away. */
  readonly irJson: unknown;
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

interface FigmaSnapshotAugmentationMetrics {
  readonly deterministic: number;
  readonly modelAugmented: number;
  readonly modelAugmentedShare: number;
}

interface FigmaSnapshotNavGraphMetrics {
  readonly screens: number;
  readonly transitions: number;
}

interface FigmaSnapshotA11yMetrics {
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

/** Body-free completeness telemetry from the scoped acquisition. */
export interface FigmaSnapshotCoverage {
  readonly screenCount: number;
  readonly screensDeepFetched: number;
  readonly screensTruncated: number;
  readonly nodeCount: number;
  readonly fetchCount: number;
  readonly capped: boolean;
}

export interface FigmaSnapshotRecord {
  readonly figmaSnapshotSchemaVersion: typeof FIGMA_SNAPSHOT_SCHEMA_VERSION;
  readonly runId: string;
  readonly provenance: FigmaSnapshotProvenanceRow;
  readonly screens: readonly FigmaSnapshotScreenRow[];
  readonly skippedScreens: readonly FigmaSnapshotSkippedScreenRow[];
  /**
   * Structural IR for screens without a PNG render. Optional for older snapshots. New snapshots
   * write one row for each skipped screen whose IR was available, so downstream QI can still use
   * the JSON even when rendering is capped or degraded.
   */
  readonly structuralScreens?: readonly FigmaSnapshotStructuralScreenRow[];
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
  readonly coverage?: FigmaSnapshotCoverage;
  /** Separate integrity hashes for optional hash-neutral artifacts (`links`/`tokens`) when present. */
  readonly artifactHashes?: FigmaSnapshotArtifactHashes;
  /** Complete stored-record hash. Older records have only their drift and artifact hashes. */
  readonly contentHash?: string;
  readonly integrityHash: string;
  readonly redactionSummary: FigmaSnapshotRedactionSummary;
}

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>([
  "figmaSnapshotSchemaVersion",
  "runId",
  "provenance",
  "screens",
  "skippedScreens",
  "structuralScreens",
  "links",
  "tokens",
  "metrics",
  "coverage",
  "artifactHashes",
  "contentHash",
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
const COVERAGE_COUNT_KEYS = [
  "screenCount",
  "screensDeepFetched",
  "screensTruncated",
  "nodeCount",
  "fetchCount",
] as const;
const ALLOWED_COVERAGE_KEYS = new Set<string>([...COVERAGE_COUNT_KEYS, "capped"]);

export interface FigmaSnapshotValidationResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

function validateArtifactHashes(value: unknown): FigmaSnapshotValidationResult | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "artifactHashes must be an object" };
  }
  for (const [key, hash] of Object.entries(value)) {
    if (!ALLOWED_ARTIFACT_HASH_KEYS.has(key)) {
      return { ok: false, reason: `unknown artifactHashes key: ${key}` };
    }
    if (!isSha256(hash)) return { ok: false, reason: "invalid artifact hash" };
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

function validateScreenCollections(
  record: Record<string, unknown>,
): FigmaSnapshotValidationResult | undefined {
  if (!Array.isArray(record.screens) || !Array.isArray(record.skippedScreens)) {
    return { ok: false, reason: "screens and skippedScreens must be arrays" };
  }
  if (record.structuralScreens !== undefined && !Array.isArray(record.structuralScreens)) {
    return { ok: false, reason: "structuralScreens must be an array" };
  }
  if (!record.screens.every(isRenderedScreen) || !record.skippedScreens.every(isSkippedScreen)) {
    return { ok: false, reason: "invalid rendered or skipped screen" };
  }
  if (
    Array.isArray(record.structuralScreens) &&
    !record.structuralScreens.every(isStructuralScreen)
  ) {
    return { ok: false, reason: "invalid structural screen" };
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalCoverage(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isObject(value) &&
    keysAllowed(value, ALLOWED_COVERAGE_KEYS) &&
    typeof value.capped === "boolean" &&
    COVERAGE_COUNT_KEYS.every((key) => isNonNegativeInteger(value[key]))
  );
}

const SIDE_FILE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u;

export function isFigmaSnapshotImageRef(value: unknown): value is FigmaSnapshotImageRef {
  return (
    isObject(value) &&
    value.mimeType === "image/png" &&
    typeof value.relativePath === "string" &&
    SIDE_FILE_NAME_PATTERN.test(value.relativePath) &&
    isSha256(value.sha256) &&
    isNonNegativeInteger(value.byteLength)
  );
}

function isRenderedScreen(value: unknown): boolean {
  return (
    isObject(value) &&
    isNonEmptyString(value.screenId) &&
    Object.hasOwn(value, "irJson") &&
    isSha256(value.integrityHash) &&
    isFigmaSnapshotImageRef(value.image)
  );
}

function isSkippedScreen(value: unknown): value is Record<string, unknown> {
  return isObject(value) && isNonEmptyString(value.screenId) && isNonEmptyString(value.reason);
}

function isStructuralScreen(value: unknown): boolean {
  return isSkippedScreen(value) && Object.hasOwn(value, "irJson") && isSha256(value.integrityHash);
}

function isLink(value: unknown): boolean {
  return (
    isObject(value) &&
    isNonEmptyString(value.sourceNodeId) &&
    isNonEmptyString(value.trigger) &&
    isNonEmptyString(value.targetNodeId)
  );
}

export function isFigmaSnapshotProvenance(value: unknown): value is FigmaSnapshotProvenanceRow {
  return (
    isObject(value) &&
    isNonEmptyString(value.fileKey) &&
    isNonEmptyString(value.nodeId) &&
    // Records written before field validation existed carry any string here; it is provenance
    // metadata only, so an empty one keeps an existing record readable.
    (value.version === undefined || typeof value.version === "string") &&
    isNonEmptyString(value.fetchedAt) &&
    Number.isFinite(Date.parse(value.fetchedAt))
  );
}

function isRedactionSummary(value: unknown): boolean {
  return (
    isObject(value) &&
    isNonNegativeInteger(value.totalStringsScanned) &&
    isNonNegativeInteger(value.stringsRedacted) &&
    isObject(value.patternsMatched) &&
    Object.values(value.patternsMatched).every(isNonNegativeInteger)
  );
}

function validateSnapshotMetadata(
  record: Record<string, unknown>,
): FigmaSnapshotValidationResult | undefined {
  if (!isNonEmptyString(record.runId) || !isFigmaSnapshotProvenance(record.provenance)) {
    return { ok: false, reason: "invalid snapshot identity or provenance" };
  }
  if (
    !isSha256(record.integrityHash) ||
    (record.contentHash !== undefined && !isSha256(record.contentHash))
  ) {
    return { ok: false, reason: "invalid snapshot hash" };
  }
  if (!isRedactionSummary(record.redactionSummary))
    return { ok: false, reason: "invalid redaction summary" };
  if (record.links !== undefined && (!Array.isArray(record.links) || !record.links.every(isLink))) {
    return { ok: false, reason: "invalid links" };
  }
  return undefined;
}

// The store verifies the hash values and disk-side identity after checking the record shape.
export function validateFigmaSnapshotRecord(value: unknown): FigmaSnapshotValidationResult {
  if (!isObject(value)) {
    return { ok: false, reason: "record is not an object" };
  }
  const record = value;
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
  const screenCollectionsValidation = validateScreenCollections(record);
  if (screenCollectionsValidation !== undefined) return screenCollectionsValidation;
  const artifactHashesValidation = validateArtifactHashes(record.artifactHashes);
  if (artifactHashesValidation !== undefined) return artifactHashesValidation;
  const metricsValidation = validateMetrics(record.metrics);
  if (metricsValidation !== undefined) return metricsValidation;
  if (!isOptionalCoverage(record.coverage)) {
    return { ok: false, reason: "invalid snapshot coverage" };
  }
  return validateSnapshotMetadata(record) ?? { ok: true, reason: undefined };
}
