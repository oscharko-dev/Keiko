// Canonical comparators used to make consolidation output byte-stable across input shuffles.
// Every output array in `ConsolidationResult` MUST be sorted by one of these comparators so a
// caller diffing two runs sees structural changes, not input-order noise.

import type { MemoryEdge, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import type { ReviewItem, StaleFlag } from "./types.js";

// Re-export the shared partition-key projection so this package's callers (dedupe.ts and
// conflicts.ts) keep their existing local import path unchanged. The canonical definition
// lives in @oscharko-dev/keiko-contracts/memory (#2906 KEIKO-0546); consolidation must not
// re-implement it. `export ... from` (Sonar S3512) is a direct pass-through and avoids the
// intermediate local binding of the value import above.
export { scopeCoordinateKey } from "@oscharko-dev/keiko-contracts/memory";

// Three-way comparator returning -1 / 0 / +1. Keeps sort callbacks lint-clean and
// total-order-correct (a < b < c implies cmp(a, c) === -1).
function cmpOrdered<T extends string | number>(a: T, b: T): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function cmpString(a: string, b: string): number {
  return cmpOrdered(a, b);
}

function cmpNumber(a: number, b: number): number {
  return cmpOrdered(a, b);
}

// Records inside a duplicate cluster: oldest first; id as tiebreak. Stable across input shuffle.
export function compareRecordsByAge(a: MemoryRecord, b: MemoryRecord): number {
  return cmpNumber(a.createdAt, b.createdAt) || cmpString(a.id, b.id);
}

// Records competing for a bounded CPU work window: newest first; id as tiebreak. Deliberately the
// mirror of compareRecordsByAge, which answers a different question — which member of an
// already-formed duplicate cluster is the canonical one. Selecting a work window with the
// canonical-member comparator kept the window pinned to the oldest records forever, so nothing
// newly captured was ever inspected once a vault outgrew the cap.
export function compareRecordsByRecency(a: MemoryRecord, b: MemoryRecord): number {
  return cmpNumber(b.createdAt, a.createdAt) || cmpString(a.id, b.id);
}

// Edges are sorted by (kind, fromMemoryId, toMemoryId, id).
export function compareEdges(a: MemoryEdge, b: MemoryEdge): number {
  return (
    cmpString(a.kind, b.kind) ||
    cmpString(a.fromMemoryId, b.fromMemoryId) ||
    cmpString(a.toMemoryId, b.toMemoryId) ||
    cmpString(a.id, b.id)
  );
}

// Stale flags sorted by (memoryId, reason). One memory may have multiple reasons; keeping
// the secondary key on reason gives a stable view in test snapshots.
export function compareStaleFlags(a: StaleFlag, b: StaleFlag): number {
  return cmpString(a.memoryId, b.memoryId) || cmpString(a.reason, b.reason);
}

// Review items sorted by (reason, related-id-list joined, id). The id-list join produces a
// stable per-item canonical key; sorting by reason groups multi-way duplicates ahead of
// conflict pairs in display.
export function compareReviewItems(a: ReviewItem, b: ReviewItem): number {
  return (
    cmpString(a.reason, b.reason) ||
    cmpString(a.relatedMemoryIds.join(","), b.relatedMemoryIds.join(",")) ||
    cmpString(a.id, b.id)
  );
}
