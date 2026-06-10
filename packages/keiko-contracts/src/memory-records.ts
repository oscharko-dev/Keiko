// Memory record contracts for the Governed Enterprise Memory Vault (Epic #204, Issue
// #205). Split from `memory.ts` to keep each file under the 400-LOC budget. Pure types
// only — no IO, no clock reads, no randomness. Leaf-package rule (ADR-0019 direction 1):
// no `@oscharko-dev/keiko-*` imports.
//
// Foundational invariants encoded structurally:
//  1. `MemoryRecord.scope` is the discriminated scope coordinate from `MemoryScope`.
//     A record without a concrete scope coordinate cannot be constructed, so two records
//     at "different scopes" are NEVER structurally equal — the discriminator owns identity.
//  2. `MemoryRecord.provenance` is REQUIRED on every durable memory. There is no optional
//     escape hatch. The capture layer (#207) MUST attach provenance before the record can
//     be persisted.
//  3. `MemoryRecord.sensitivity` lives on the provenance envelope because sensitivity is
//     intrinsic to the SOURCE of the memory, not a downstream label. A record cannot be
//     re-classified by mutating a separate field; sensitivity changes require a
//     supersession.
//  4. Timestamps are epoch milliseconds (number). JSON-friendly and Date-free so the type
//     surface is browser-safe and round-trip-stable.

import type {
  ConversationId,
  EvidenceManifestId,
  MemoryEdgeId,
  MemoryEdgeKind,
  MemoryId,
  MemoryScope,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  MemoryType,
  WorkflowRunId,
} from "./memory.js";

// ─── Model identity (completion model, not embedding model) ───────────────────
// When a memory was authored or transformed with model assistance (e.g. a consolidation
// pass that merged two episodic records into one semantic fact), the model identity is
// pinned here so a future re-validation can reason about model-version drift.
//
// Distinct from `EmbeddingModelIdentity` (local-knowledge): no vector fields. A memory
// record may still be later embedded by the retrieval layer (#210) — that embedding-model
// identity belongs to the retrieval index, not to the memory itself.
export interface MemoryModelIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly modelRevision?: string;
}

// ─── Provenance ───────────────────────────────────────────────────────────────
// Every durable memory carries one of these. The capture layer attaches it; consolidation
// merges them when collapsing records; audit reads it; retrieval never strips it.
//
// `confidence` is a calibrated [0, 1] number. The validator rejects NaN, Infinity, and
// out-of-range values so downstream rankers can multiply confidences without checking.
//
// `capturedAt` is epoch ms. A separate `validityInterval` on the record (below) describes
// when the FACT is valid; `capturedAt` describes when the OBSERVATION was made. Conflating
// these is the most common modeling mistake in temporally-aware memory systems; the names
// are deliberate so a reader is forced to disambiguate.
export interface MemoryProvenance {
  readonly sourceKind: MemorySourceKind;
  readonly sourceConversationId?: ConversationId;
  readonly sourceWorkflowRunId?: WorkflowRunId;
  readonly sourceEvidenceManifestId?: EvidenceManifestId;
  readonly capturedAt: number;
  readonly modelIdentity?: MemoryModelIdentity;
  readonly confidence: number;
  readonly sensitivity: MemorySensitivity;
  // Optional free-form rationale the reviewer or capture heuristic wrote when proposing
  // the memory. Bounded length is enforced at the validator boundary; the type only pins
  // the shape. Carrying rationale here (and NOT inside `body`) keeps the searchable body
  // free of meta-commentary.
  readonly captureRationale?: string;
}

// ─── Validity interval ────────────────────────────────────────────────────────
// `validFrom` is when the underlying fact began holding; `validUntil` is when it stops.
// Both are epoch ms. `validUntil: undefined` means "no scheduled expiry" — the retrieval
// and consolidation layers MAY still flag the memory as stale via the
// `staleReason` field on the record (e.g. when its source workflow was rejected).
export interface MemoryValidityInterval {
  readonly validFrom: number;
  readonly validUntil?: number;
}

// ─── Retention hint ───────────────────────────────────────────────────────────
// Optional signal from capture or consolidation to the retention/forgetting layer (#214).
// `policyKey` is an opaque string keyed against the retention policy table the privacy
// layer maintains; this contract pins only the carrier shape so policy evolution does not
// require a contract version bump.
export interface MemoryRetentionHint {
  readonly policyKey: string;
  readonly retainUntil?: number;
  readonly notes?: string;
}

// ─── Memory record ────────────────────────────────────────────────────────────
// The central durable contract. Distinguished from chat history (transient, no
// provenance), connected-context KnowledgeCapsules (document-derived, no
// scope-coordinate, no status lifecycle), and local-knowledge records (document chunks,
// no provenance.confidence) by the combination of (scope coordinate + provenance +
// status). The discriminator helper `isMemoryRecord` in memory-record-validation.ts pins
// this distinction at runtime; the structural shape pins it at compile time.
export interface MemoryRecord {
  readonly id: MemoryId;
  readonly schemaVersion: "1";
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  // The substantive content of the memory. Free-form short string (length budget enforced
  // by the validator). Sensitive content is governed by `provenance.sensitivity`; the
  // capture layer is responsible for keeping the body within the sensitivity contract.
  readonly body: string;
  // Optional structured payload. Discriminated by `payload.kind` so future structured
  // memory types (e.g. tabular preference grids) can be added without widening `body`.
  // Kept narrow at this layer: only "string-list" and "key-value" are pinned; richer
  // payloads are deferred to a future contract version.
  readonly payload?: MemoryStructuredPayload;
  readonly provenance: MemoryProvenance;
  readonly validity: MemoryValidityInterval;
  readonly status: MemoryStatus;
  readonly pinned: boolean;
  // Optional reason a memory is currently flagged as stale (set by consolidation or
  // conflict resolution). Independent of the validity interval: a memory can still be
  // within `validFrom..validUntil` and yet be flagged stale (e.g. its source workflow was
  // later marked invalid). Retrieval is expected to deprioritize stale records.
  readonly staleReason?: string;
  readonly retentionHint?: MemoryRetentionHint;
  // Optional human-readable tags. The validator rejects NUL bytes and empty entries.
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── Structured payload ───────────────────────────────────────────────────────
// Discriminated union so future kinds (e.g. "key-value-typed", "ordered-rule-set") can be
// added without breaking existing readers. Each kind carries only the fields it needs.
export type MemoryStructuredPayload =
  | {
      readonly kind: "string-list";
      readonly items: readonly string[];
    }
  | {
      readonly kind: "key-value";
      readonly entries: readonly { readonly key: string; readonly value: string }[];
    };

export type MemoryStructuredPayloadKind = MemoryStructuredPayload["kind"];

export const MEMORY_STRUCTURED_PAYLOAD_KINDS: readonly MemoryStructuredPayloadKind[] = [
  "string-list",
  "key-value",
] as const;

// ─── Edges between records ────────────────────────────────────────────────────
// Edges live in their own table at the storage layer (#206). At this contract layer they
// are first-class so retrieval (#210) and consolidation (#208) can reason about the graph
// without dipping into storage-internal shapes.
//
// `provenanceSummary` is an optional short string the consolidation or conflict-resolution
// layer attaches when emitting the edge. It is intentionally NOT a full `MemoryProvenance`:
// edges inherit lineage from their endpoint records, so duplicating the full envelope
// would invite drift.
export interface MemoryEdge {
  readonly id: MemoryEdgeId;
  readonly schemaVersion: "1";
  readonly fromMemoryId: MemoryId;
  readonly toMemoryId: MemoryId;
  readonly kind: MemoryEdgeKind;
  readonly createdAt: number;
  readonly confidence?: number;
  readonly provenanceSummary?: string;
}
