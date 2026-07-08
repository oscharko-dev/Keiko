// Browser-safe BFF wire shapes for memory consolidation jobs (Epic #204 / Issue #208).
//
// The pure consolidation engine owns the algorithmic domain model. These interfaces own the HTTP
// projection consumed by MemoriaViva and produced by keiko-server, so the UI does not duplicate
// partial copies of review evidence, conflict counters, or job lifecycle fields.

import type { MemoryId, MemoryScope, MemoryStatus, MemoryType } from "./memory.js";
import type { MemoryEdge } from "./memory-records.js";
import type { MemoryUpdate } from "./memory-operations.js";

export type MemoryConsolidationJobStateWire =
  "queued" | "running" | "completed" | "failed" | "canceled" | "skipped";

export type MemoryConsolidationStaleReasonWire = "expired" | "low-confidence" | "aged-out";

export interface MemoryConsolidationStaleFlagWire {
  readonly memoryId: MemoryId;
  readonly reason: MemoryConsolidationStaleReasonWire;
  readonly detectedAt: number;
}

export type MemoryConsolidationReviewReasonWire =
  "duplicate-review" | "multi-way-duplicate" | "potential-conflict";

export type MemoryConsolidationProposedActionWire =
  | { readonly kind: "merge"; readonly winner: MemoryId; readonly losers: readonly MemoryId[] }
  | { readonly kind: "supersede"; readonly newer: MemoryId; readonly older: MemoryId };

export type MemoryConsolidationEvidenceKindWire =
  | "lexical-similarity"
  | "semantic-similarity"
  | "negation-polarity"
  | "value-replacement"
  | "summary-union";

export interface MemoryConsolidationEvidenceWire {
  readonly kind: MemoryConsolidationEvidenceKindWire;
  readonly memoryIds: readonly MemoryId[];
  readonly score?: number;
  readonly threshold?: number;
  readonly detail?: string;
}

// Optional, advisory-only annotation (Issue #2130 / ADR-0120). Populated exclusively by a
// keiko-server enrichment pass after consolidation completes; absent unless the operator opts in
// via `KEIKO_MEMORY_CONFLICT_ADVISORY=1` and the underlying model call succeeds. Never changes
// `proposedAction` or any reviewer-facing behavior — display only.
export interface MemoryConsolidationSuggestedResolutionWire {
  readonly recommendedWinnerId: MemoryId;
  readonly rationale: string;
}

export interface MemoryConsolidationReviewItemWire {
  readonly id: string;
  readonly reason: MemoryConsolidationReviewReasonWire;
  readonly relatedMemoryIds: readonly MemoryId[];
  readonly sourceMemoryIds?: readonly MemoryId[];
  readonly proposedAction?: MemoryConsolidationProposedActionWire;
  readonly evidence?: readonly MemoryConsolidationEvidenceWire[];
  readonly proposedEdges?: readonly MemoryEdge[];
  readonly detectedAt: number;
  readonly suggestedResolution?: MemoryConsolidationSuggestedResolutionWire;
}

export interface MemoryConsolidationSummaryStatusWire {
  readonly kind: "not-configured" | "configured";
  readonly updatesProposed: number;
  readonly skippedMergeClusters: number;
  readonly fallbacksUsed: number;
}

export interface MemoryConsolidationResultWire {
  readonly state: "completed" | "canceled" | "skipped" | "failed";
  readonly edgesProposed: readonly MemoryEdge[];
  readonly updatesProposed: readonly MemoryUpdate[];
  readonly summaryStatus: MemoryConsolidationSummaryStatusWire;
  readonly staleFlags: readonly MemoryConsolidationStaleFlagWire[];
  readonly reviewItems: readonly MemoryConsolidationReviewItemWire[];
  readonly clustersInspected: number;
  readonly conflictPairsDetected: number;
  readonly recordsInspected: number;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface MemoryConsolidationJobWire {
  readonly id: string;
  readonly state: MemoryConsolidationJobStateWire;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly result?: MemoryConsolidationResultWire;
  readonly error?: string;
}

export interface MemoryConsolidationJobSelectionWire {
  readonly scopes: readonly MemoryScope[];
  readonly types?: readonly MemoryType[];
  readonly statuses?: readonly MemoryStatus[];
  readonly includeExpired: boolean;
}

export interface MemoryConsolidationJobSettingsWire {
  readonly jaccardThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
  readonly maxRecordsPerRun: number;
}

export interface MemoryConsolidationJobEnvelopeWire {
  readonly job: MemoryConsolidationJobWire;
  readonly createdAt: number;
  readonly selection: MemoryConsolidationJobSelectionWire;
  readonly settings: MemoryConsolidationJobSettingsWire;
  readonly memoryCount: number;
  readonly cancelRequested: boolean;
}

export interface MemoryConsolidationJobResponseWire {
  readonly job: MemoryConsolidationJobEnvelopeWire;
}
