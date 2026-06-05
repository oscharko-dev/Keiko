// Retrieval-suppression predicate.
//
// MUST stay in sync with @oscharko-dev/keiko-memory-governance/src/suppression.ts.
// Duplicated by design (per Issue #210 brief) so this package depends ONLY on
// keiko-contracts and keiko-security — see ADR-0019 direction rule 3j. A future refactor
// MAY extract a shared helper into a fourth "contracts-adjacent" package; until then a
// drift between the two implementations is a correctness bug and any change here must be
// mirrored there.
//
// The semantics map the discriminated MemoryStatus enum to a suppression reason and
// additionally apply two derived rules:
//   - validity.validUntil <= nowMs                              => "expired"
//   - provenance.confidence <= staleConfidenceThreshold         => "stale-low-confidence"
//
// The threshold default of 0.3 matches consolidation (#208) and governance (#209) so the
// three layers agree on what counts as low-confidence. The comparison is `<=` so a record
// exactly at the threshold is suppressed.
//
// A future widening of MemoryStatus surfaces as an exhaustiveness compile error here
// (the `never` branch in statusSuppression).

import type { MemoryRecord, MemoryStatus } from "@oscharko-dev/keiko-contracts/memory";

import { RetrievalError } from "./errors.js";

export type SuppressionReason =
  | "archived"
  | "forgotten"
  | "conflicted"
  | "expired"
  | "rejected"
  | "stale-low-confidence";

export interface SuppressionResult {
  readonly suppressed: boolean;
  readonly reason?: SuppressionReason;
}

const NOT_SUPPRESSED: SuppressionResult = { suppressed: false } as const;

function isFiniteInRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function assertValidThreshold(staleConfidenceThreshold: number): void {
  if (isFiniteInRange(staleConfidenceThreshold, 0, 1)) return;
  throw new RetrievalError(
    "invalid-threshold",
    `staleConfidenceThreshold must be a finite number in [0, 1] (got ${String(staleConfidenceThreshold)})`,
  );
}

function statusSuppression(status: MemoryStatus): SuppressionResult | null {
  switch (status) {
    case "archived":
      return { suppressed: true, reason: "archived" };
    case "forgotten":
      return { suppressed: true, reason: "forgotten" };
    case "conflicted":
      return { suppressed: true, reason: "conflicted" };
    case "rejected":
      return { suppressed: true, reason: "rejected" };
    case "expired":
      // Validity-based "expired" is checked separately so an explicit `expired` status
      // carries the same surface reason whether the retrieval index pinned it via status
      // or derived it from the validity window.
      return { suppressed: true, reason: "expired" };
    case "proposed":
    case "accepted":
    case "superseded":
      return null;
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return null;
    }
  }
}

function validitySuppression(memory: MemoryRecord, nowMs: number): SuppressionResult | null {
  if (memory.validity.validUntil === undefined) return null;
  if (memory.validity.validUntil > nowMs) return null;
  return { suppressed: true, reason: "expired" };
}

function confidenceSuppression(memory: MemoryRecord, threshold: number): SuppressionResult | null {
  if (memory.provenance.confidence > threshold) return null;
  return { suppressed: true, reason: "stale-low-confidence" };
}

export function isMemorySuppressed(
  memory: MemoryRecord,
  nowMs: number,
  staleConfidenceThreshold: number,
): SuppressionResult {
  assertValidThreshold(staleConfidenceThreshold);
  const byStatus = statusSuppression(memory.status);
  if (byStatus !== null) return byStatus;
  const byValidity = validitySuppression(memory, nowMs);
  if (byValidity !== null) return byValidity;
  const byConfidence = confidenceSuppression(memory, staleConfidenceThreshold);
  if (byConfidence !== null) return byConfidence;
  return NOT_SUPPRESSED;
}
