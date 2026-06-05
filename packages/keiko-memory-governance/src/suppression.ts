// Retrieval-suppression predicate.
//
// isMemorySuppressedFromRetrieval is a pure function consumed by the retrieval layer
// (#210) to filter result sets. It maps the discriminated MemoryStatus enum to a
// suppression reason and also applies two derived rules:
//
//   - validity.validUntil <= nowMs   →   "expired"   (regardless of status)
//   - provenance.confidence <= staleConfidenceThreshold  →  "stale-low-confidence"
//
// Default staleConfidenceThreshold is 0.3 — same conservative floor consolidation uses
// (#208 _constants.ts STALE_CONFIDENCE_DEFAULT 0.3) so the two layers agree on what
// counts as low-confidence. The threshold is a `<=` comparison: a record exactly at
// the threshold is suppressed.
//
// The contracts MemoryStatus enum is the single source of truth: every legal status
// branches to a deterministic suppression decision. A future widening of MemoryStatus
// surfaces as an exhaustiveness compile error here.

import type { MemoryRecord, MemoryStatus } from "@oscharko-dev/keiko-contracts/memory";

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

export interface SuppressionOptions {
  readonly staleConfidenceThreshold?: number;
}

const DEFAULT_STALE_CONFIDENCE_THRESHOLD = 0.3;

const NOT_SUPPRESSED: SuppressionResult = { suppressed: false } as const;

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
      // Validity-based "expired" is checked separately below so an explicit `expired`
      // status carries the same surface reason whether the retrieval index pinned it via
      // status or derived it from the validity window.
      return { suppressed: true, reason: "expired" };
    case "proposed":
    case "accepted":
    case "superseded":
      // proposed/accepted/superseded are pass-through here. Superseded records are still
      // readable in audit views; the retrieval layer applies its own includeSuperseded
      // toggle on top of this predicate. proposed records are visible to the Memory
      // Center review queue.
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

export function isMemorySuppressedFromRetrieval(
  memory: MemoryRecord,
  nowMs: number,
  options: SuppressionOptions = {},
): SuppressionResult {
  const byStatus = statusSuppression(memory.status);
  if (byStatus !== null) return byStatus;
  const byValidity = validitySuppression(memory, nowMs);
  if (byValidity !== null) return byValidity;
  const threshold = options.staleConfidenceThreshold ?? DEFAULT_STALE_CONFIDENCE_THRESHOLD;
  const byConfidence = confidenceSuppression(memory, threshold);
  if (byConfidence !== null) return byConfidence;
  return NOT_SUPPRESSED;
}
