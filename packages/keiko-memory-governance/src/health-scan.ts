// Memoria Viva structural health scan (Issue #2129) — periodic, read-only consistency check over the
// memory graph. PURE: same records + edges + nowMs + policy => byte-identical findings. No clock
// reads, no IO, no randomness, no mutation — the caller (BFF route handler) loads records and edges
// from the vault and passes them in; this module never calls back into storage. Findings are advisory
// only, exactly like the existing conflict ReviewItems: consolidation and explicit human review remain
// the only paths that change memory status, content, or edges. This module never proposes or applies a
// remediation — it only surfaces findings, matching the "always operator-reviewed, never auto-merge"
// contract this package and keiko-memory-consolidation already document at every mutation site (see
// e.g. conflicts.ts's "the engine never auto-merges" and this file's own buildConflictTransitions,
// which only ever runs after an explicit ConflictResolution the caller supplies). Neither ADR-0116
// (realtime voice recall) nor ADR-0117 (type-aware decay) covers structural health-checking — this
// module fills the gap Issue #2129 identified without claiming either ADR as its origin.
//
// Cross-package note: keiko-memory-governance may depend ONLY on contracts + security
// (dependency-cruiser ADR-0019 direction rules 3h/3i/3j pin keiko-memory-consolidation and
// keiko-memory-retrieval as sibling leaves, not importable here). So this module does not reuse
// keiko-memory-consolidation's clustering/conflict engine or keiko-memory-retrieval's graph-proximity
// score. Instead it reuses THIS package's own `detectConflictPair` and text-similarity/partition
// helpers (./conflict.js) for the dangling-review-item and missing-cross-reference detectors.
//
// "Dangling review item" operational definition: consolidation's ReviewItems are never persisted (they
// live only in the server's in-memory per-job registry — see memory-consolidation-registry.ts), so
// there is no durable "first surfaced at" timestamp to compare against a window. This module re-derives
// the conflict signal ON DEMAND against the CURRENT record set and uses `min(updatedAt)` across the
// conflicting pair as the "how long has this structurally existed unresolved" proxy — arguably more
// useful than a job-relative age, since it does not reset just because a scan happened to run recently.
//
// Cost bounding (security-triage review, #2129): the caller (a synchronous GET handler, no job/queue
// indirection unlike consolidation) has no cancellation hook, so this module bounds work in TWO
// independent, deterministic layers instead: `maxRecordsPerScan` caps the total record set, and
// `maxRecordsPerPartition` independently caps EACH (scope, type) partition before the O(n^2) passes —
// otherwise a single densely-populated partition alone could still reach the full global cap.

import { MEMORY_HEALTH_SCAN_REASON_MAX_CHARS } from "@oscharko-dev/keiko-contracts";
import type {
  MemoryEdge,
  MemoryId,
  MemoryRecord,
  MemoryStatus,
  MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";

import { detectConflictPair, jaccardSimilarity, scopeCoordinateKey } from "./conflict.js";

const DAY_MS = 864e5;

export type HealthScanFindingKind =
  "orphan-memory" | "missing-cross-reference" | "stale-not-archived" | "dangling-review-item";

// Redacted memory reference: identity + classification only, never body/tags/payload (AC6).
export interface HealthScanMemoryRef {
  readonly memoryId: MemoryId;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
}

export interface HealthScanFinding {
  readonly id: string;
  readonly kind: HealthScanFindingKind;
  // 1 member for orphan-memory / stale-not-archived; 2 for missing-cross-reference /
  // dangling-review-item (the compared pair).
  readonly memories: readonly HealthScanMemoryRef[];
  // Bounded, template-built from enum values, scores, thresholds, and day-counts only — NEVER from
  // record.body/tags/payload (AC6).
  readonly reason: string;
  readonly detectedAt: number;
}

export interface MemoryHealthScanPolicy {
  readonly crossReferenceSimilarityThreshold: number;
  readonly staleWindowMs: number;
  readonly danglingWindowMs: number;
  readonly maxRecordsPerScan: number;
  readonly maxRecordsPerPartition: number;
}

// crossReferenceSimilarityThreshold sits between this package's own conflict-detection floor (0.4)
// and dedup ceiling (0.85, see conflict.ts) — high enough to skip incidental phrasing overlap, low
// enough to catch genuinely related-but-unlinked memories.
export const MEMORY_HEALTH_SCAN_DEFAULTS: MemoryHealthScanPolicy = {
  crossReferenceSimilarityThreshold: 0.55,
  staleWindowMs: 30 * DAY_MS,
  danglingWindowMs: 14 * DAY_MS,
  // Hard CPU budget for the O(n^2) pairwise passes, mirroring consolidation's maxRecordsPerRun.
  maxRecordsPerScan: 1000,
  // maxRecordsPerScan bounds the TOTAL record set, not any single (scope, type) partition — one
  // partition alone could otherwise still reach the full cap, i.e. up to ~500K pairwise comparisons
  // PER O(n^2) detector, synchronously, inside a single GET handler with no cancellation hook (unlike
  // keiko-memory-consolidation's cancellationSignal). Bounding each partition independently keeps the
  // worst case predictable regardless of how records cluster across scopes/types. 200 records caps a
  // single partition at ~20K pairs per detector — security-triage finding #2129-F1.
  maxRecordsPerPartition: 200,
};

export interface HealthScanOptions {
  readonly nowMs: number;
  readonly newFindingId: () => string;
  readonly policy?: Partial<MemoryHealthScanPolicy>;
}

export interface MemoryHealthScanResult {
  readonly findings: readonly HealthScanFinding[];
  readonly recordsInspected: number;
  readonly truncated: boolean;
}

// Shared shape for the two O(n^2), partition-bounded detectors — `truncated` reports whether ANY
// (scope, type) partition exceeded `maxRecordsPerPartition` and was itself truncated.
export interface HealthScanCategoryResult {
  readonly findings: readonly HealthScanFinding[];
  readonly truncated: boolean;
}

function toRef(record: MemoryRecord): HealthScanMemoryRef {
  return { memoryId: record.id, type: record.type, status: record.status };
}

// Every reason string here is template-built from enum values, scores, thresholds, and day-counts —
// never from record.body/tags/payload (AC6) — so this bound is a defensive backstop, not a normal-path
// truncation. Enforced (not just declared) so the "bounded reason string" claim has a real code path,
// not only a construction-time assumption. Exported for direct unit testing.
export function boundedReason(reason: string): string {
  return reason.length <= MEMORY_HEALTH_SCAN_REASON_MAX_CHARS
    ? reason
    : reason.slice(0, MEMORY_HEALTH_SCAN_REASON_MAX_CHARS);
}

function boundRecords(
  records: readonly MemoryRecord[],
  maxRecordsPerScan: number,
): { readonly bounded: readonly MemoryRecord[]; readonly truncated: boolean } {
  if (records.length <= maxRecordsPerScan) return { bounded: records, truncated: false };
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  return { bounded: sorted.slice(0, maxRecordsPerScan), truncated: true };
}

function sortedById(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}

interface PartitionResult {
  readonly partitions: readonly (readonly MemoryRecord[])[];
  readonly truncated: boolean;
}

// Partitions by (scope, type) — the same visibility invariant every pairwise memory scan in this
// codebase honours — and independently bounds EACH partition to `maxRecordsPerPartition` so one
// densely-populated scope/type combination cannot alone reach the O(n^2) worst case (see
// MEMORY_HEALTH_SCAN_DEFAULTS.maxRecordsPerPartition doc comment).
function partitionByScopeAndType(
  records: readonly MemoryRecord[],
  maxRecordsPerPartition: number,
): PartitionResult {
  const raw = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = `${scopeCoordinateKey(record.scope)}|type:${record.type}`;
    const bucket = raw.get(key);
    if (bucket === undefined) raw.set(key, [record]);
    else bucket.push(record);
  }
  let truncated = false;
  const partitions: (readonly MemoryRecord[])[] = [];
  for (const bucket of raw.values()) {
    if (bucket.length <= maxRecordsPerPartition) {
      partitions.push(bucket);
      continue;
    }
    truncated = true;
    partitions.push(sortedById(bucket).slice(0, maxRecordsPerPartition));
  }
  return { partitions, truncated };
}

// ─── Orphan memories ────────────────────────────────────────────────────────────
// An `accepted` record with zero MemoryEdge connections of any kind (incoming or outgoing, any edge
// kind) — nothing links it into the graph for retrieval-time graph-proximity boosting or human
// navigation. Not inherently an error; a genuinely standalone fact is legitimate. Advisory only.
export function findOrphanMemories(
  records: readonly MemoryRecord[],
  edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  nowMs: number,
  newFindingId: () => string,
): readonly HealthScanFinding[] {
  const findings: HealthScanFinding[] = [];
  for (const record of records) {
    if (record.status !== "accepted") continue;
    const edges = edgesByMemory.get(record.id);
    if (edges !== undefined && edges.length > 0) continue;
    findings.push({
      id: newFindingId(),
      kind: "orphan-memory",
      memories: [toRef(record)],
      reason: boundedReason("accepted memory has zero edges of any kind"),
      detectedAt: nowMs,
    });
  }
  return findings;
}

// ─── Missing cross-references ────────────────────────────────────────────────────
// Two `accepted` records whose body similarity exceeds the configured threshold but that have no
// edge between them. Partitioned by (scope, type) — the same visibility invariant every other
// pairwise memory scan in this codebase honours (cross-scope/cross-type pairs are never compared).
function hasEdgeBetween(
  edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  a: MemoryId,
  b: MemoryId,
): boolean {
  const edges = edgesByMemory.get(a);
  if (edges === undefined) return false;
  return edges.some((edge) => edge.fromMemoryId === b || edge.toMemoryId === b);
}

function crossReferenceFinding(
  a: MemoryRecord,
  b: MemoryRecord,
  score: number,
  threshold: number,
  nowMs: number,
  newFindingId: () => string,
): HealthScanFinding {
  return {
    id: newFindingId(),
    kind: "missing-cross-reference",
    memories: [toRef(a), toRef(b)],
    reason: boundedReason(
      `similarity ${score.toFixed(2)} >= threshold ${threshold.toFixed(2)}, no edge between records`,
    ),
    detectedAt: nowMs,
  };
}

function evaluateCrossReferencePair(
  a: MemoryRecord | undefined,
  b: MemoryRecord | undefined,
  edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  threshold: number,
  nowMs: number,
  newFindingId: () => string,
): HealthScanFinding | null {
  if (a === undefined || b === undefined) return null;
  if (hasEdgeBetween(edgesByMemory, a.id, b.id)) return null;
  const score = jaccardSimilarity(a.body, b.body);
  if (score < threshold) return null;
  return crossReferenceFinding(a, b, score, threshold, nowMs, newFindingId);
}

function missingCrossReferencesInPartition(
  partition: readonly MemoryRecord[],
  edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  threshold: number,
  nowMs: number,
  newFindingId: () => string,
): readonly HealthScanFinding[] {
  const findings: HealthScanFinding[] = [];
  const sorted = sortedById(partition);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const finding = evaluateCrossReferencePair(
        sorted[i],
        sorted[j],
        edgesByMemory,
        threshold,
        nowMs,
        newFindingId,
      );
      if (finding !== null) findings.push(finding);
    }
  }
  return findings;
}

export function findMissingCrossReferences(
  records: readonly MemoryRecord[],
  edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  threshold: number,
  nowMs: number,
  newFindingId: () => string,
  maxRecordsPerPartition: number = MEMORY_HEALTH_SCAN_DEFAULTS.maxRecordsPerPartition,
): HealthScanCategoryResult {
  const accepted = records.filter((record) => record.status === "accepted");
  const { partitions, truncated } = partitionByScopeAndType(accepted, maxRecordsPerPartition);
  const findings: HealthScanFinding[] = [];
  for (const partition of partitions) {
    findings.push(
      ...missingCrossReferencesInPartition(
        partition,
        edgesByMemory,
        threshold,
        nowMs,
        newFindingId,
      ),
    );
  }
  return { findings, truncated };
}

// ─── Stale-but-not-archived ───────────────────────────────────────────────────────
// A `superseded` or `conflicted` record whose status has not changed for longer than the configured
// window — it should have been archived or resolved through the governed review flow but wasn't.
// `updatedAt` is the record's general last-touch timestamp; every status transition in this subsystem
// is written through a governed builder that bumps `updatedAt`, so it is a faithful proxy for "time
// since this status was set" absent a dedicated per-status-transition timestamp.
const STALE_STATUSES: ReadonlySet<MemoryStatus> = new Set(["superseded", "conflicted"]);

export function findStaleNotArchived(
  records: readonly MemoryRecord[],
  nowMs: number,
  staleWindowMs: number,
  newFindingId: () => string,
): readonly HealthScanFinding[] {
  const findings: HealthScanFinding[] = [];
  for (const record of records) {
    if (!STALE_STATUSES.has(record.status)) continue;
    const ageMs = nowMs - record.updatedAt;
    if (ageMs < staleWindowMs) continue;
    const ageDays = Math.floor(ageMs / DAY_MS).toString();
    const windowDays = Math.floor(staleWindowMs / DAY_MS).toString();
    findings.push({
      id: newFindingId(),
      kind: "stale-not-archived",
      memories: [toRef(record)],
      reason: boundedReason(
        `status "${record.status}" unchanged for ${ageDays}d (window ${windowDays}d)`,
      ),
      detectedAt: nowMs,
    });
  }
  return findings;
}

// ─── Dangling review items ─────────────────────────────────────────────────────────
// Re-derives the SAME pairwise conflict signal `detectConflictPair` already uses for live single-pair
// checks (this package's own function — see conflict.ts), scanned across all `accepted`/`proposed`
// pairs. See module header for why `min(updatedAt)` stands in for a "first surfaced at" timestamp.
const DANGLING_STATUSES: ReadonlySet<MemoryStatus> = new Set(["accepted", "proposed"]);

function danglingFinding(
  a: MemoryRecord,
  b: MemoryRecord,
  reasonCode: string,
  windowMs: number,
  ageMs: number,
  nowMs: number,
  newFindingId: () => string,
): HealthScanFinding {
  const ageDays = Math.floor(ageMs / DAY_MS).toString();
  const windowDays = Math.floor(windowMs / DAY_MS).toString();
  return {
    id: newFindingId(),
    kind: "dangling-review-item",
    memories: [toRef(a), toRef(b)],
    reason: boundedReason(`unresolved "${reasonCode}" for ${ageDays}d (window ${windowDays}d)`),
    detectedAt: nowMs,
  };
}

function evaluateDanglingPair(
  a: MemoryRecord | undefined,
  b: MemoryRecord | undefined,
  windowMs: number,
  nowMs: number,
  newFindingId: () => string,
): HealthScanFinding | null {
  if (a === undefined || b === undefined) return null;
  const pair = detectConflictPair(a, b);
  if (!pair.hasConflict) return null;
  const ageMs = nowMs - Math.min(a.updatedAt, b.updatedAt);
  if (ageMs < windowMs) return null;
  return danglingFinding(a, b, pair.reason ?? "conflict", windowMs, ageMs, nowMs, newFindingId);
}

function danglingReviewItemsInPartition(
  partition: readonly MemoryRecord[],
  windowMs: number,
  nowMs: number,
  newFindingId: () => string,
): readonly HealthScanFinding[] {
  const findings: HealthScanFinding[] = [];
  const sorted = sortedById(partition);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const finding = evaluateDanglingPair(sorted[i], sorted[j], windowMs, nowMs, newFindingId);
      if (finding !== null) findings.push(finding);
    }
  }
  return findings;
}

export function findDanglingReviewItems(
  records: readonly MemoryRecord[],
  windowMs: number,
  nowMs: number,
  newFindingId: () => string,
  maxRecordsPerPartition: number = MEMORY_HEALTH_SCAN_DEFAULTS.maxRecordsPerPartition,
): HealthScanCategoryResult {
  const reviewable = records.filter((record) => DANGLING_STATUSES.has(record.status));
  const { partitions, truncated } = partitionByScopeAndType(reviewable, maxRecordsPerPartition);
  const findings: HealthScanFinding[] = [];
  for (const partition of partitions) {
    findings.push(...danglingReviewItemsInPartition(partition, windowMs, nowMs, newFindingId));
  }
  return { findings, truncated };
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────────
function compareFindings(a: HealthScanFinding, b: HealthScanFinding): number {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  const aFirst = a.memories[0]?.memoryId ?? "";
  const bFirst = b.memories[0]?.memoryId ?? "";
  if (aFirst !== bFirst) return aFirst.localeCompare(bFirst);
  return a.id.localeCompare(b.id);
}

// Public entry. Deterministic: same records + edges + nowMs + policy => byte-identical output. Never
// mutates `records` or `edgesByMemory`, never calls storage — the caller surfaces `findings` for
// human review only; no auto-remediation path exists in this module (AC5).
export function scanMemoryHealth(
  records: readonly MemoryRecord[],
  edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  options: HealthScanOptions,
): MemoryHealthScanResult {
  const policy: MemoryHealthScanPolicy = { ...MEMORY_HEALTH_SCAN_DEFAULTS, ...options.policy };
  const { bounded, truncated: globalTruncated } = boundRecords(records, policy.maxRecordsPerScan);
  const { nowMs, newFindingId } = options;
  const crossReferences = findMissingCrossReferences(
    bounded,
    edgesByMemory,
    policy.crossReferenceSimilarityThreshold,
    nowMs,
    newFindingId,
    policy.maxRecordsPerPartition,
  );
  const danglingReviewItems = findDanglingReviewItems(
    bounded,
    policy.danglingWindowMs,
    nowMs,
    newFindingId,
    policy.maxRecordsPerPartition,
  );
  const findings = [
    ...findOrphanMemories(bounded, edgesByMemory, nowMs, newFindingId),
    ...crossReferences.findings,
    ...findStaleNotArchived(bounded, nowMs, policy.staleWindowMs, newFindingId),
    ...danglingReviewItems.findings,
  ].sort(compareFindings);
  const truncated = globalTruncated || crossReferences.truncated || danglingReviewItems.truncated;
  return { findings, recordsInspected: bounded.length, truncated };
}
