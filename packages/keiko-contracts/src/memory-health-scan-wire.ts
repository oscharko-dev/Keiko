// Browser-safe BFF wire shapes for the Memoria Viva health-scan (Issue #2129).
//
// The pure health-scan engine (`@oscharko-dev/keiko-memory-governance`) owns the algorithmic domain
// model. These interfaces own the HTTP projection consumed by MemoriaViva and produced by
// keiko-server, mirroring the `memory-consolidation-wire.ts` pattern: IDs, a closed finding-kind enum,
// and a bounded reason string only — never raw memory body or payload, consistent with
// `MemoryAuditRecord`'s redaction contract (no free-form content, references by ID only).

import type { MemoryId, MemoryStatus, MemoryType } from "./memory.js";

// Matches MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS (memory-audit-events.ts) so every bounded-reason
// surface in the memory subsystem shares one budget.
export const MEMORY_HEALTH_SCAN_REASON_MAX_CHARS = 240;

export type MemoryHealthScanFindingKindWire =
  "orphan-memory" | "missing-cross-reference" | "stale-not-archived" | "dangling-review-item";

export const MEMORY_HEALTH_SCAN_FINDING_KINDS: readonly MemoryHealthScanFindingKindWire[] = [
  "orphan-memory",
  "missing-cross-reference",
  "stale-not-archived",
  "dangling-review-item",
] as const;

// Redacted memory reference: identity + classification only, never body/tags/payload.
export interface MemoryHealthScanMemoryRefWire {
  readonly memoryId: MemoryId;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
}

export interface MemoryHealthScanFindingWire {
  readonly id: string;
  readonly kind: MemoryHealthScanFindingKindWire;
  // 1 member for orphan-memory / stale-not-archived; 2 for missing-cross-reference /
  // dangling-review-item (the compared pair).
  readonly memories: readonly MemoryHealthScanMemoryRefWire[];
  readonly reason: string;
  readonly detectedAt: number;
}

export interface MemoryHealthScanResultWire {
  readonly findings: readonly MemoryHealthScanFindingWire[];
  readonly recordsInspected: number;
  readonly truncated: boolean;
}
