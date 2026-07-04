// Stale-memory detection. Pure function; deterministic; never mutates input.
//
// Three independent reasons may fire per record (a record can be both "expired" AND
// "low-confidence" simultaneously — each produces its own StaleFlag). The full set per record
// is enumerated so the caller can route each reason to a distinct review surface.
//
// Pinned-exemption invariant: a pinned record NEVER produces a StaleFlag, regardless of
// validity, confidence, or age. This is an Epic #204 hard rule — pinning is the user's
// explicit "never auto-degrade this" signal.
//
// Terminal-status skip: records in `rejected` or `forgotten` are skipped entirely — they have
// no active lifecycle for consolidation to touch. `archived` and `superseded` records are NOT
// skipped here: archival is reversible (status transitions allow `archived → accepted`), and a
// stale flag on a superseded record may still inform the audit trail. Trading false-positives
// for absent signal is the safer default; the caller filters by status if needed.

import type { MemoryRecord, MemoryStatus } from "@oscharko-dev/keiko-contracts/memory";

import { STALE_ACCESS_REINFORCEMENT_COUNT_DEFAULT } from "./_constants.js";
import { compareStaleFlags } from "./_ordering.js";
import type { ConsolidationAccessStat, StaleFlag, StaleReason } from "./types.js";

export interface StaleOptions {
  readonly nowMs: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly accessStatsFor?: (memoryId: MemoryRecord["id"]) => ConsolidationAccessStat | undefined;
  readonly staleAccessReinforcementCount?: number;
}

// Records in these statuses are skipped entirely: they have no consolidation work to do.
// `conflicted` and `proposed` are included because they are pending human review — emitting
// stale flags for records the reviewer hasn't accepted yet would produce false signal.
const SKIPPED_STATUSES = new Set<MemoryStatus>(["rejected", "forgotten", "conflicted", "proposed"]);

function isExpired(record: MemoryRecord, nowMs: number): boolean {
  const { validUntil } = record.validity;
  return validUntil !== undefined && validUntil <= nowMs;
}

function isLowConfidence(record: MemoryRecord, threshold: number): boolean {
  return record.provenance.confidence <= threshold;
}

function isAgedOut(record: MemoryRecord, nowMs: number, maxAgeMs: number): boolean {
  return record.updatedAt + maxAgeMs <= nowMs;
}

function isReinforcedAgainstAge(record: MemoryRecord, options: StaleOptions): boolean {
  const stats = options.accessStatsFor?.(record.id);
  if (stats === undefined) return false;
  const minCount =
    options.staleAccessReinforcementCount ?? STALE_ACCESS_REINFORCEMENT_COUNT_DEFAULT;
  if (stats.accessCount >= minCount) return true;
  return (
    stats.lastAccessedAt !== undefined && stats.lastAccessedAt + options.maxAgeMs > options.nowMs
  );
}

function collectReasonsFor(record: MemoryRecord, options: StaleOptions): readonly StaleReason[] {
  const reasons: StaleReason[] = [];
  if (isExpired(record, options.nowMs)) reasons.push("expired");
  if (isLowConfidence(record, options.staleConfidenceThreshold)) reasons.push("low-confidence");
  if (
    isAgedOut(record, options.nowMs, options.maxAgeMs) &&
    !isReinforcedAgainstAge(record, options)
  ) {
    reasons.push("aged-out");
  }
  return reasons;
}

// Public entry. Returns flags sorted by (memoryId ASC, reason ASC) for byte-stable output.
export function findStaleMemories(
  records: readonly MemoryRecord[],
  options: StaleOptions,
): readonly StaleFlag[] {
  const flags: StaleFlag[] = [];
  for (const record of records) {
    if (record.pinned) continue;
    if (SKIPPED_STATUSES.has(record.status)) continue;
    for (const reason of collectReasonsFor(record, options)) {
      flags.push({ memoryId: record.id, reason, detectedAt: options.nowMs });
    }
  }
  return flags.sort(compareStaleFlags);
}
