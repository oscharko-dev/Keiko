// Deterministic, versioned, rebuildable per-segment manifests of the Activity Log (#3531).
//
// A manifest is safe metadata DERIVED from one sealed segment — never a second log, never a copy of
// an event body. It lets `keiko support query` and selective export prove, without opening a
// segment's body, that the segment cannot hold what a query asks for: the time range, the process /
// sequence ranges, the registered categories, operations, error kinds and failure classes, the loss
// and integrity counts, and a Bloom filter over the correlation keys (`c:<correlationId>` and
// `p:<parentCorrelationId>`), which stores hash bits only. An `incidentId` or `defectFingerprint` is
// listed only when a registered operation that declares that field carries it; a sealed segment is
// never touched to add one.
//
// DETERMINISM. Every value is a pure function of the segment's bytes and this build's Activity Log
// catalog: no clock, path, host, or build-time value enters it, keys are emitted in one fixed order,
// every list is sorted, and the digest is SHA-256 over the canonical JSON of everything else. Deleting
// the store and rebuilding it from the same sealed segments therefore reproduces every manifest byte
// for byte (for the same schema version and catalog), and a stored manifest is accepted only when it
// re-serializes to exactly its own bytes and its digest matches.
//
// STORE. `<stateDir>/activity-log-manifests/manifest-<segmentId>.json`, owner-private, written and
// removed only through the keiko-security safe-artifact primitives, and only by the query, rebuild
// and export commands — never by the Activity Log writer. It holds at most one manifest per retained
// sealed segment (each at most MAX_SEGMENT_MANIFEST_BYTES); every pass removes the manifests whose
// segment retention deleted, so the store follows the log's own bound. A missing, torn, stale or
// foreign-catalog manifest is simply rebuilt.

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_CATEGORIES,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogOperationSchema,
  isActivityLogErrorKind,
  isDefectFingerprint,
  isSupportIncidentId,
  type ActivityLogCompletenessState,
  type ActivityLogLossState,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  SafeArtifactFileError,
  openSafeArtifactFile,
  removeSafeArtifactFile,
} from "@oscharko-dev/keiko-security/fs-hardening";
import {
  ACTIVITY_LOG_EVIDENCE_INTEGRITY,
  emptyEvidenceCounts,
  evidenceSummary,
  incrementEvidence,
  lineSequenceAnomalies,
  type ActivityLogEvidenceClassification,
  type ActivityLogTextLine,
  type LineClassification,
  type MutableEvidenceCounts,
  type ParsedLine,
  type ProcessSequenceAnomaly,
  type SequenceState,
} from "./support-analyze.js";
import {
  ACTIVITY_LOG_MANIFEST_DIRECTORY_NAME,
  parseSegmentManifestFileName,
  segmentManifestFileName,
} from "./support-segment-manifest-names.js";

export const SEGMENT_MANIFEST_KIND = "keiko.activity-log.segment-manifest";
export const SEGMENT_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_SEGMENT_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_PROCESSES = 16;
const MAX_LIFECYCLE_REFERENCES = 64;
const MAX_FILTER_KEYS = 131_072;
const MAX_FILTER_BYTES = 128 * 1024;
const MIN_FILTER_BITS = 64;
const FILTER_BITS_PER_KEY = 10;
export const SEGMENT_MANIFEST_FILTER_HASHES = 7;

export interface SegmentManifestCount {
  readonly name: string;
  readonly count: number;
}

export interface SegmentManifestProcess {
  readonly pid: number;
  readonly instanceId: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly lineCount: number;
}

export interface SegmentManifestSequenceAnomalies {
  readonly gap: number;
  readonly duplicate: number;
  readonly decreasing: number;
  readonly reset: number;
}

export interface SegmentManifestEvidence {
  readonly classification: ActivityLogEvidenceClassification;
  readonly supportedLineCount: number;
  readonly legacyLineCount: number;
  readonly unsupportedLineCount: number;
  readonly corruptLineCount: number;
  readonly truncatedLineCount: number;
  readonly incompleteLineCount: number;
  readonly sequenceAnomalies: SegmentManifestSequenceAnomalies;
  readonly completeness: ActivityLogCompletenessState;
  readonly loss: ActivityLogLossState;
}

export interface SegmentManifestCorrelationFilter {
  // Saturated: too many distinct keys to filter; the segment may contain any correlation.
  readonly saturated: boolean;
  readonly distinctKeyCount: number;
  readonly bits: number;
  readonly hashes: number;
  readonly data: string;
}

export interface SegmentManifest {
  readonly kind: typeof SEGMENT_MANIFEST_KIND;
  readonly schemaVersion: typeof SEGMENT_MANIFEST_SCHEMA_VERSION;
  readonly segmentId: string;
  readonly catalog: {
    readonly registryVersion: number;
    readonly schemaDigest: string;
    readonly catalogDigest: string;
  };
  readonly segment: {
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly lineCount: number;
    readonly terminated: boolean;
  };
  readonly time: { readonly firstTs: string; readonly lastTs: string } | null;
  readonly processes: {
    readonly complete: boolean;
    readonly entries: readonly SegmentManifestProcess[];
  };
  readonly evidence: SegmentManifestEvidence;
  readonly categories: readonly SegmentManifestCount[];
  readonly ops: readonly SegmentManifestCount[];
  readonly errorKinds: readonly SegmentManifestCount[];
  readonly failureClasses: readonly SegmentManifestCount[];
  readonly unregisteredOpLineCount: number;
  readonly uncorrelatedLineCount: number;
  readonly lossLineCount: number;
  readonly lifecycleReferences: {
    readonly complete: boolean;
    readonly incidentIds: readonly string[];
    readonly defectFingerprints: readonly string[];
  };
  readonly correlations: SegmentManifestCorrelationFilter;
  readonly digest: string;
}

// ─── Correlation keys and the Bloom filter ─────────────────────────────────────────────────────

export function correlationKey(correlationId: string): string {
  return `c:${correlationId}`;
}

export function parentCorrelationKey(parentCorrelationId: string): string {
  return `p:${parentCorrelationId}`;
}

/** The two 32-bit hashes one key contributes; computed once per key and reused per segment. */
export type FilterKeyHashes = readonly [number, number];

export function filterKeyHashes(key: string): FilterKeyHashes {
  const digest = createHash("sha256").update(key, "utf8").digest();
  return [digest.readUInt32BE(0), (digest.readUInt32BE(4) | 1) >>> 0];
}

function filterBitIndex(hashes: FilterKeyHashes, round: number, bits: number): number {
  return (hashes[0] + round * hashes[1]) % bits;
}

function filterBitCount(keyCount: number): number {
  const bits = Math.ceil((keyCount * FILTER_BITS_PER_KEY) / 8) * 8;
  return Math.min(Math.max(bits, MIN_FILTER_BITS), MAX_FILTER_BYTES * 8);
}

function buildCorrelationFilter(
  keys: ReadonlySet<string> | undefined,
): SegmentManifestCorrelationFilter {
  if (keys === undefined) {
    return { saturated: true, distinctKeyCount: 0, bits: 0, hashes: 0, data: "" };
  }
  const bits = filterBitCount(keys.size);
  const bytes = Buffer.alloc(bits / 8);
  for (const key of [...keys].sort(compareText)) {
    const hashes = filterKeyHashes(key);
    for (let round = 0; round < SEGMENT_MANIFEST_FILTER_HASHES; round += 1) {
      const index = filterBitIndex(hashes, round, bits);
      bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
    }
  }
  return {
    saturated: false,
    distinctKeyCount: keys.size,
    bits,
    hashes: SEGMENT_MANIFEST_FILTER_HASHES,
    data: bytes.toString("base64"),
  };
}

/** A manifest with its filter decoded once, as every query pass consults it. */
export interface LoadedSegmentManifest {
  readonly manifest: SegmentManifest;
  readonly filter: Buffer;
}

export function loadSegmentManifest(manifest: SegmentManifest): LoadedSegmentManifest {
  return { manifest, filter: Buffer.from(manifest.correlations.data, "base64") };
}

/** False only when the filter proves the segment holds none of `keys`; never a false negative. */
export function manifestMayContainAnyKey(
  loaded: LoadedSegmentManifest,
  keys: readonly FilterKeyHashes[],
): boolean {
  const { correlations } = loaded.manifest;
  if (correlations.saturated) return true;
  return keys.some((hashes) => {
    for (let round = 0; round < correlations.hashes; round += 1) {
      const index = filterBitIndex(hashes, round, correlations.bits);
      if (((loaded.filter[index >> 3] ?? 0) & (1 << (index & 7))) === 0) return false;
    }
    return true;
  });
}

// ─── Building one manifest from a segment's lines ──────────────────────────────────────────────

// Code-unit order: the same on every host and locale, which `localeCompare` is not.
export function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function knownCorrelation(value: string | undefined): value is string {
  return value !== undefined && value !== ACTIVITY_LOG_UNKNOWN_CORRELATION_ID;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts(map: ReadonlyMap<string, number>): readonly SegmentManifestCount[] {
  return [...map.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, count]) => ({ name, count }));
}

interface MutableProcess {
  pid: number;
  instanceId: string;
  firstSeq: number;
  lastSeq: number;
  lineCount: number;
}

const CATEGORY_SET: ReadonlySet<string> = new Set(ACTIVITY_LOG_CATEGORIES);

function lineIdentity(
  parsed: ParsedLine,
): { pid: number; instanceId: string; seq: number } | undefined {
  const { pid, instanceId, seq } = parsed.view;
  return parsed.hasFullIdentity &&
    pid !== undefined &&
    instanceId !== undefined &&
    seq !== undefined
    ? { pid, instanceId, seq }
    : undefined;
}

/** Accumulates one segment's manifest in bounded memory while its lines stream past once. */
export class SegmentManifestBuilder {
  private readonly hash = createHash("sha256");
  private sizeBytes = 0;
  private lineCount = 0;
  private terminated = true;
  private readonly counts: MutableEvidenceCounts = emptyEvidenceCounts();
  private readonly anomalyCounts = { gap: 0, duplicate: 0, decreasing: 0, reset: 0 };
  // At most one representative of each kind reaches the shared classification rule.
  private readonly representativeAnomalies = new Map<string, ProcessSequenceAnomaly>();
  private readonly sequenceStates = new Map<string, SequenceState>();
  private firstTs: string | undefined;
  private lastTs: string | undefined;
  private readonly processes = new Map<string, MutableProcess>();
  private processesOverflow = false;
  private readonly categories = new Map<string, number>();
  private readonly ops = new Map<string, number>();
  private readonly errorKinds = new Map<string, number>();
  private readonly failureClasses = new Map<string, number>();
  private unregisteredOpLineCount = 0;
  private uncorrelatedLineCount = 0;
  private lossLineCount = 0;
  private readonly incidentIds = new Set<string>();
  private readonly defectFingerprints = new Set<string>();
  private referencesOverflow = false;
  private filterKeys: Set<string> | undefined = new Set<string>();

  public constructor(private readonly segmentId: string) {}

  /** Every raw byte of the segment, in order: the digest covers the bytes, not the decoding. */
  public observeChunk(chunk: Uint8Array): void {
    this.hash.update(chunk);
    this.sizeBytes += chunk.length;
  }

  public observeLine(line: ActivityLogTextLine, classification: LineClassification): void {
    this.lineCount += 1;
    if (!line.terminated) this.terminated = false;
    if (classification.kind === "section") return;
    incrementEvidence(this.counts, classification.evidence);
    if (classification.kind === "line") this.observeParsed(classification.parsed);
  }

  private observeParsed(parsed: ParsedLine): void {
    const { view } = parsed;
    if (this.firstTs === undefined || view.ts < this.firstTs) this.firstTs = view.ts;
    if (this.lastTs === undefined || view.ts > this.lastTs) this.lastTs = view.ts;
    this.observeProcess(parsed);
    if (CATEGORY_SET.has(view.category)) increment(this.categories, view.category);
    if (isActivityLogErrorKind(view.errorKind)) increment(this.errorKinds, view.errorKind);
    this.observeRegistration(parsed);
    this.observeCorrelation(parsed);
  }

  private observeProcess(parsed: ParsedLine): void {
    const identity = lineIdentity(parsed);
    if (identity === undefined) return;
    const key = `${String(identity.pid)}:${identity.instanceId}`;
    const state = this.sequenceStates.get(key) ?? { seen: new Set<number>(), previous: 0 };
    this.sequenceStates.set(key, state);
    for (const anomaly of lineSequenceAnomalies(parsed, state)) {
      this.anomalyCounts[anomaly.kind] += 1;
      const representative = anomaly.kind === "gap" ? "gap" : "other";
      if (!this.representativeAnomalies.has(representative)) {
        this.representativeAnomalies.set(representative, anomaly);
      }
    }
    const existing = this.processes.get(key);
    if (existing !== undefined) {
      existing.firstSeq = Math.min(existing.firstSeq, identity.seq);
      existing.lastSeq = Math.max(existing.lastSeq, identity.seq);
      existing.lineCount += 1;
    } else if (this.processes.size < MAX_MANIFEST_PROCESSES) {
      this.processes.set(key, {
        ...identity,
        firstSeq: identity.seq,
        lastSeq: identity.seq,
        lineCount: 1,
      });
    } else {
      this.processesOverflow = true;
    }
  }

  private observeRegistration(parsed: ParsedLine): void {
    const registration = activityLogOperationSchema(parsed.view.op);
    if (registration === undefined) {
      this.unregisteredOpLineCount += 1;
      return;
    }
    increment(this.ops, registration.op);
    for (const failureClass of registration.failureClasses) {
      increment(this.failureClasses, failureClass);
    }
    if (registration.lifecycle === "loss") this.lossLineCount += 1;
    const fields = parsed.view.extra;
    if (registration.fields.incidentId !== undefined && isSupportIncidentId(fields?.incidentId)) {
      this.addReference(this.incidentIds, fields.incidentId);
    }
    if (
      registration.fields.defectFingerprint !== undefined &&
      isDefectFingerprint(fields?.defectFingerprint)
    ) {
      this.addReference(this.defectFingerprints, fields.defectFingerprint);
    }
  }

  private addReference(target: Set<string>, value: string): void {
    if (target.has(value)) return;
    if (target.size >= MAX_LIFECYCLE_REFERENCES) {
      this.referencesOverflow = true;
      return;
    }
    target.add(value);
  }

  private observeCorrelation(parsed: ParsedLine): void {
    if (knownCorrelation(parsed.correlationId)) this.addKey(correlationKey(parsed.correlationId));
    else this.uncorrelatedLineCount += 1;
    const parent = parsed.view.parentCorrelationId;
    if (knownCorrelation(parent)) this.addKey(parentCorrelationKey(parent));
  }

  private addKey(key: string): void {
    if (this.filterKeys === undefined || this.filterKeys.has(key)) return;
    if (this.filterKeys.size >= MAX_FILTER_KEYS) {
      this.filterKeys = undefined;
      return;
    }
    this.filterKeys.add(key);
  }

  private evidence(): SegmentManifestEvidence {
    const classification = evidenceSummary(this.counts, [
      ...this.representativeAnomalies.values(),
    ]).classification;
    const integrity = ACTIVITY_LOG_EVIDENCE_INTEGRITY[classification];
    return {
      classification,
      supportedLineCount: this.counts.supported,
      legacyLineCount: this.counts.legacy,
      unsupportedLineCount: this.counts.unsupported,
      corruptLineCount: this.counts.corrupt,
      truncatedLineCount: this.counts.truncated,
      incompleteLineCount: this.counts.incomplete,
      sequenceAnomalies: { ...this.anomalyCounts },
      completeness: integrity.completeness,
      loss: integrity.loss,
    };
  }

  private processList(): SegmentManifest["processes"] {
    if (this.processesOverflow) return { complete: false, entries: [] };
    const entries = [...this.processes.values()]
      .map((entry) => ({ ...entry }))
      .sort(
        (left, right) => left.pid - right.pid || compareText(left.instanceId, right.instanceId),
      );
    return { complete: true, entries };
  }

  public finish(): SegmentManifest {
    return withDigest({
      kind: SEGMENT_MANIFEST_KIND,
      schemaVersion: SEGMENT_MANIFEST_SCHEMA_VERSION,
      segmentId: this.segmentId,
      catalog: {
        registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
        schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
        catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
      },
      segment: {
        sizeBytes: this.sizeBytes,
        sha256: this.hash.digest("hex"),
        lineCount: this.lineCount,
        terminated: this.terminated,
      },
      time:
        this.firstTs === undefined || this.lastTs === undefined
          ? null
          : { firstTs: this.firstTs, lastTs: this.lastTs },
      processes: this.processList(),
      evidence: this.evidence(),
      categories: sortedCounts(this.categories),
      ops: sortedCounts(this.ops),
      errorKinds: sortedCounts(this.errorKinds),
      failureClasses: sortedCounts(this.failureClasses),
      unregisteredOpLineCount: this.unregisteredOpLineCount,
      uncorrelatedLineCount: this.uncorrelatedLineCount,
      lossLineCount: this.lossLineCount,
      lifecycleReferences: {
        complete: !this.referencesOverflow,
        incidentIds: [...this.incidentIds].sort(compareText),
        defectFingerprints: [...this.defectFingerprints].sort(compareText),
      },
      correlations: buildCorrelationFilter(this.filterKeys),
    });
  }
}

// ─── Canonical serialization and fail-closed parsing ───────────────────────────────────────────

type SegmentManifestBody = Omit<SegmentManifest, "digest">;

function countList(values: readonly SegmentManifestCount[]): readonly SegmentManifestCount[] {
  return values.map(({ name, count }) => ({ name, count }));
}

// Re-creates every object in the one canonical key order; the digest and the stored bytes are both
// taken over this form, so a reordered or padded file never validates.
function canonicalProcesses(value: SegmentManifest["processes"]): SegmentManifest["processes"] {
  return {
    complete: value.complete,
    entries: value.entries.map((entry) => ({
      pid: entry.pid,
      instanceId: entry.instanceId,
      firstSeq: entry.firstSeq,
      lastSeq: entry.lastSeq,
      lineCount: entry.lineCount,
    })),
  };
}

function canonicalEvidence(evidence: SegmentManifestEvidence): SegmentManifestEvidence {
  return {
    classification: evidence.classification,
    supportedLineCount: evidence.supportedLineCount,
    legacyLineCount: evidence.legacyLineCount,
    unsupportedLineCount: evidence.unsupportedLineCount,
    corruptLineCount: evidence.corruptLineCount,
    truncatedLineCount: evidence.truncatedLineCount,
    incompleteLineCount: evidence.incompleteLineCount,
    sequenceAnomalies: {
      gap: evidence.sequenceAnomalies.gap,
      duplicate: evidence.sequenceAnomalies.duplicate,
      decreasing: evidence.sequenceAnomalies.decreasing,
      reset: evidence.sequenceAnomalies.reset,
    },
    completeness: evidence.completeness,
    loss: evidence.loss,
  };
}

function canonicalBody(value: SegmentManifestBody): SegmentManifestBody {
  return {
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    segmentId: value.segmentId,
    catalog: {
      registryVersion: value.catalog.registryVersion,
      schemaDigest: value.catalog.schemaDigest,
      catalogDigest: value.catalog.catalogDigest,
    },
    segment: {
      sizeBytes: value.segment.sizeBytes,
      sha256: value.segment.sha256,
      lineCount: value.segment.lineCount,
      terminated: value.segment.terminated,
    },
    time: value.time === null ? null : { firstTs: value.time.firstTs, lastTs: value.time.lastTs },
    processes: canonicalProcesses(value.processes),
    evidence: canonicalEvidence(value.evidence),
    categories: countList(value.categories),
    ops: countList(value.ops),
    errorKinds: countList(value.errorKinds),
    failureClasses: countList(value.failureClasses),
    unregisteredOpLineCount: value.unregisteredOpLineCount,
    uncorrelatedLineCount: value.uncorrelatedLineCount,
    lossLineCount: value.lossLineCount,
    lifecycleReferences: {
      complete: value.lifecycleReferences.complete,
      incidentIds: [...value.lifecycleReferences.incidentIds],
      defectFingerprints: [...value.lifecycleReferences.defectFingerprints],
    },
    correlations: {
      saturated: value.correlations.saturated,
      distinctKeyCount: value.correlations.distinctKeyCount,
      bits: value.correlations.bits,
      hashes: value.correlations.hashes,
      data: value.correlations.data,
    },
  };
}

function bodyDigest(body: SegmentManifestBody): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalBody(body)), "utf8")
    .digest("hex");
}

function withDigest(body: SegmentManifestBody): SegmentManifest {
  return { ...canonicalBody(body), digest: bodyDigest(body) };
}

/** The one stored form: canonical JSON of the body, then the digest, then a newline. */
export function serializeSegmentManifest(manifest: SegmentManifest): string {
  return `${JSON.stringify({ ...canonicalBody(manifest), digest: manifest.digest })}\n`;
}

type Plain = Readonly<Record<string, unknown>>;

function isPlain(value: unknown): value is Plain {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[a-f0-9]+$/u.test(value);
}

function isCountEntry(value: unknown): boolean {
  return isPlain(value) && typeof value.name === "string" && isCount(value.count);
}

function isCountArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isCountEntry);
}

function isStringArray(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= MAX_LIFECYCLE_REFERENCES && value.every(valid);
}

function isProcessEntry(value: unknown): boolean {
  return (
    isPlain(value) &&
    isCount(value.pid) &&
    typeof value.instanceId === "string" &&
    isCount(value.firstSeq) &&
    isCount(value.lastSeq) &&
    isCount(value.lineCount)
  );
}

function validSegmentFacts(value: Plain): boolean {
  const segment = value.segment;
  return (
    isPlain(segment) &&
    isCount(segment.sizeBytes) &&
    isHex(segment.sha256, 64) &&
    isCount(segment.lineCount) &&
    typeof segment.terminated === "boolean"
  );
}

function validTime(value: unknown): boolean {
  return (
    value === null ||
    (isPlain(value) && typeof value.firstTs === "string" && typeof value.lastTs === "string")
  );
}

function validProcesses(value: unknown): boolean {
  return (
    isPlain(value) &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.entries) &&
    value.entries.length <= MAX_MANIFEST_PROCESSES &&
    value.entries.every(isProcessEntry)
  );
}

const EVIDENCE_COUNT_KEYS = [
  "supportedLineCount",
  "legacyLineCount",
  "unsupportedLineCount",
  "corruptLineCount",
  "truncatedLineCount",
  "incompleteLineCount",
] as const;

function validEvidence(value: unknown): boolean {
  if (!isPlain(value) || typeof value.classification !== "string") return false;
  if (!(value.classification in ACTIVITY_LOG_EVIDENCE_INTEGRITY)) return false;
  const anomalies = value.sequenceAnomalies;
  return (
    EVIDENCE_COUNT_KEYS.every((key) => isCount(value[key])) &&
    isPlain(anomalies) &&
    ["gap", "duplicate", "decreasing", "reset"].every((key) => isCount(anomalies[key])) &&
    typeof value.completeness === "string" &&
    typeof value.loss === "string"
  );
}

// A saturated filter has no bits; any other is whole bytes inside the bounds.
function validFilterBits(bits: unknown, saturated: boolean): bits is number {
  if (!isCount(bits) || bits % 8 !== 0 || bits > MAX_FILTER_BYTES * 8) return false;
  return saturated || bits >= MIN_FILTER_BITS;
}

// The bit array must be exactly `bits / 8` bytes of canonical base64: a short array would read as
// zeros and could prune a segment that holds the key.
function validFilterData(data: unknown, bits: number): boolean {
  if (typeof data !== "string") return false;
  const bytes = Buffer.from(data, "base64");
  return bytes.length === bits / 8 && bytes.toString("base64") === data;
}

function validFilter(value: unknown): boolean {
  return (
    isPlain(value) &&
    typeof value.saturated === "boolean" &&
    isCount(value.distinctKeyCount) &&
    validFilterBits(value.bits, value.saturated) &&
    isCount(value.hashes) &&
    value.hashes <= 16 &&
    (value.saturated || value.hashes > 0) &&
    validFilterData(value.data, value.bits)
  );
}

function validReferences(value: unknown): boolean {
  return (
    isPlain(value) &&
    typeof value.complete === "boolean" &&
    isStringArray(value.incidentIds, isSupportIncidentId) &&
    isStringArray(value.defectFingerprints, isDefectFingerprint)
  );
}

function validLists(value: Plain): boolean {
  return (
    isCountArray(value.categories) &&
    isCountArray(value.ops) &&
    isCountArray(value.errorKinds) &&
    isCountArray(value.failureClasses) &&
    isCount(value.unregisteredOpLineCount) &&
    isCount(value.uncorrelatedLineCount) &&
    isCount(value.lossLineCount)
  );
}

function validHeader(value: Plain, segmentId: string): boolean {
  const catalog = value.catalog;
  return (
    value.kind === SEGMENT_MANIFEST_KIND &&
    value.schemaVersion === SEGMENT_MANIFEST_SCHEMA_VERSION &&
    value.segmentId === segmentId &&
    isPlain(catalog) &&
    isCount(catalog.registryVersion) &&
    isHex(catalog.schemaDigest, 64) &&
    isHex(catalog.catalogDigest, 64) &&
    isHex(value.digest, 64)
  );
}

function isManifestShape(value: unknown, segmentId: string): value is SegmentManifest {
  return (
    isPlain(value) &&
    validHeader(value, segmentId) &&
    validSegmentFacts(value) &&
    validTime(value.time) &&
    validProcesses(value.processes) &&
    validEvidence(value.evidence) &&
    validLists(value) &&
    validReferences(value.lifecycleReferences) &&
    validFilter(value.correlations)
  );
}

/**
 * Parses one stored manifest for `segmentId`. Anything that is not exactly the canonical bytes of
 * a well-formed manifest with a matching digest is `undefined` — and is then rebuilt, never trusted.
 */
export function parseSegmentManifest(text: string, segmentId: string): SegmentManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isManifestShape(value, segmentId)) return undefined;
  if (bodyDigest(value) !== value.digest) return undefined;
  return serializeSegmentManifest(value) === text ? value : undefined;
}

/** True when the manifest was derived by this build's catalog (a new catalog reclassifies lines). */
export function manifestMatchesCatalog(manifest: SegmentManifest): boolean {
  return (
    manifest.catalog.registryVersion === ACTIVITY_LOG_REGISTRY_VERSION &&
    manifest.catalog.schemaDigest === ACTIVITY_LOG_SCHEMA_DIGEST &&
    manifest.catalog.catalogDigest === ACTIVITY_LOG_CATALOG_DIGEST
  );
}

// ─── The owner-private store ───────────────────────────────────────────────────────────────────

const ARTIFACT_CLASS = "manifest";

export function segmentManifestDirectory(stateDir: string): string {
  return join(stateDir, ACTIVITY_LOG_MANIFEST_DIRECTORY_NAME);
}

/** Creates the owner-private store when absent; `undefined` when it cannot exist (read-only). */
export function ensureSegmentManifestDirectory(stateDir: string): string | undefined {
  const directory = segmentManifestDirectory(stateDir);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return lstatSync(directory).isDirectory() ? directory : undefined;
  } catch {
    return undefined;
  }
}

function readBoundedDescriptor(descriptor: number): string | undefined {
  const size = fstatSync(descriptor).size;
  if (size <= 0 || size > MAX_SEGMENT_MANIFEST_BYTES) return undefined;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, offset, size - offset, offset);
    if (count <= 0) return undefined;
    offset += count;
  }
  return buffer.toString("utf8");
}

/** The stored manifest of `segmentId`, or `undefined` when absent, unreadable or invalid. */
export function readStoredSegmentManifest(
  directory: string,
  segmentId: string,
): SegmentManifest | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSafeArtifactFile(join(directory, segmentManifestFileName(segmentId)), {
      artifactClass: ARTIFACT_CLASS,
      mode: "read",
      trustedRoot: directory,
    });
    const text = readBoundedDescriptor(descriptor);
    return text === undefined ? undefined : parseSegmentManifest(text, segmentId);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAll(descriptor: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(descriptor, payload, offset, payload.length - offset);
    if (written <= 0) throw new SafeArtifactFileError(ARTIFACT_CLASS, "write-failed");
    offset += written;
  }
}

function removeIfPresent(directory: string, name: string): void {
  try {
    removeSafeArtifactFile(join(directory, name), {
      artifactClass: ARTIFACT_CLASS,
      trustedRoot: directory,
    });
  } catch (error) {
    // Only an absent name is fine; any other refusal (a link, a foreign owner) must surface.
    if (manifestNameExists(directory, name)) throw error;
  }
}

// Only ENOENT reads as absent; every other lstat failure propagates.
function manifestNameExists(directory: string, name: string): boolean {
  return lstatSync(join(directory, name), { throwIfNoEntry: false }) !== undefined;
}

/**
 * Publishes `manifest`, replacing an invalid predecessor through the guarded removal. Returns the
 * bytes written; throws the closed safe-artifact failure when the store refuses the write.
 */
export function writeStoredSegmentManifest(directory: string, manifest: SegmentManifest): number {
  const payload = Buffer.from(serializeSegmentManifest(manifest), "utf8");
  if (payload.length > MAX_SEGMENT_MANIFEST_BYTES) {
    throw new SafeArtifactFileError(ARTIFACT_CLASS, "invalid-publication");
  }
  const name = segmentManifestFileName(manifest.segmentId);
  removeIfPresent(directory, name);
  const descriptor = openSafeArtifactFile(join(directory, name), {
    artifactClass: ARTIFACT_CLASS,
    mode: "exclusive-create",
    trustedRoot: directory,
  });
  try {
    writeAll(descriptor, payload);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return payload.length;
}

/** True when a manifest name exists for `segmentId`, valid or not (lstat; absence is false). */
export function storedSegmentManifestExists(directory: string, segmentId: string): boolean {
  return manifestNameExists(directory, segmentManifestFileName(segmentId));
}

/** Every closed-grammar manifest name in the store, with the segment id it names. */
export function listStoredSegmentManifests(
  directory: string,
): readonly { readonly name: string; readonly segmentId: string }[] {
  // The store was just created by `ensureSegmentManifestDirectory`: a listing failure propagates.
  const entries: { name: string; segmentId: string }[] = [];
  for (const name of [...readdirSync(directory)].sort(compareText)) {
    const segmentId = parseSegmentManifestFileName(name);
    if (segmentId !== undefined) entries.push({ name, segmentId });
  }
  return entries;
}

/** Removes one closed-grammar manifest; throws the closed refusal of the guarded removal. */
export function removeStoredSegmentManifest(directory: string, name: string): void {
  removeIfPresent(directory, name);
}
