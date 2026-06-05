// Canonical comparators used to make consolidation output byte-stable across input shuffles.
// Every output array in `ConsolidationResult` MUST be sorted by one of these comparators so a
// caller diffing two runs sees structural changes, not input-order noise.

import type { MemoryEdge, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import type { ReviewItem, StaleFlag } from "./types.js";

// Canonical coordinate string for a memory scope. Distinct kinds prefix-disambiguate so a
// userId equal to a workspaceId cannot collide. Mirrors the private helper in
// keiko-contracts/src/memory-retrieval-validation.ts. Not exported from contracts, so a
// near-duplicate is unavoidable here — pin via a comment so future readers know to keep
// the two in sync if a new scope kind lands.
export function scopeCoordinateKey(scope: MemoryRecord["scope"]): string {
  switch (scope.kind) {
    case "global":
      return "global:";
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
  }
}

// Three-way comparator returning -1 / 0 / +1. Keeps sort callbacks lint-clean and
// total-order-correct (a < b < c implies cmp(a, c) === -1).
function cmpString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function cmpNumber(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Records inside a duplicate cluster: oldest first; id as tiebreak. Stable across input shuffle.
export function compareRecordsByAge(a: MemoryRecord, b: MemoryRecord): number {
  return cmpNumber(a.createdAt, b.createdAt) || cmpString(a.id, b.id);
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
