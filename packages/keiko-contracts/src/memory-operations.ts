// Operation envelopes for the Governed Enterprise Memory Vault (Epic #204, Issue #205).
// Pure types only — no IO, no clock, no randomness. Leaf-package rule (ADR-0019 direction
// 1): no `@oscharko-dev/keiko-*` imports.
//
// Each operation carries the minimum data the next layer needs to evaluate it. The
// validation layer (memory-validation.ts) checks structural well-formedness, status
// transition legality, and provenance presence; authorization, persistence, and
// side-effects belong to downstream packages and are explicitly out of scope here.
//
// Audit invariant: `MemoryAuditRecord` MUST NOT carry raw memory content. It references
// affected memories by ID and pins a short, non-secret rationale string. This keeps the
// audit ledger redaction-safe and lets the audit boundary (#214) ship audit summaries
// across the wire without re-redacting.

import type {
  MemoryAuditActionKind,
  MemoryAuditRecordId,
  MemoryEdgeId,
  MemoryEdgeKind,
  MemoryId,
  MemoryProposalId,
  MemoryReviewerId,
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
} from "./memory.js";
import type {
  MemoryProvenance,
  MemoryRetentionHint,
  MemoryStructuredPayload,
  MemoryValidityInterval,
} from "./memory-records.js";

// ─── Proposal ─────────────────────────────────────────────────────────────────
// A candidate memory that has been captured but not yet reviewed. The capture layer
// (#207) emits these; the conversation center (#212) or Memory Center UI (#211) presents
// them; the user accepts or rejects.
//
// The proposal carries the FULL prospective record body, payload, scope, type, and
// provenance — it must contain enough information for the reviewer to make a decision
// without dipping into another store.
export interface MemoryProposal {
  readonly schemaVersion: "1";
  readonly proposalId: MemoryProposalId;
  readonly proposedAt: number;
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly body: string;
  readonly payload?: MemoryStructuredPayload;
  readonly tags: readonly string[];
  readonly provenance: MemoryProvenance;
  readonly validity: MemoryValidityInterval;
  readonly retentionHint?: MemoryRetentionHint;
  // Initial status MUST be the literal "proposed". Pinning to the literal makes accidental
  // construction of a pre-accepted proposal a compile error.
  readonly initialStatus: "proposed";
  // Optional capture-side hint about why this proposal exists, surfaced verbatim to the
  // reviewer. Capped by the validator.
  readonly captureReason?: string;
}

// ─── Acceptance ───────────────────────────────────────────────────────────────
// Accepts a proposal and assigns a freshly-minted MemoryId. The mint happens at the
// storage layer (#206); this envelope only carries the inputs. `acceptedAt` is supplied
// by the caller (typically the BFF route handler that owns the clock) — keeping it here
// rather than implicit lets the audit ledger record the exact decision moment.
export interface MemoryAcceptance {
  readonly schemaVersion: "1";
  readonly proposalId: MemoryProposalId;
  readonly mintedMemoryId: MemoryId;
  readonly reviewerId: MemoryReviewerId;
  readonly acceptedAt: number;
  // Optional per-acceptance overrides: a reviewer may edit the body, sensitivity, or
  // validity before accepting. When present, these REPLACE the proposal's values for the
  // persisted record.
  readonly bodyOverride?: string;
  readonly sensitivityOverride?: MemorySensitivity;
  readonly validityOverride?: MemoryValidityInterval;
  readonly reviewerNote?: string;
}

// ─── Rejection ────────────────────────────────────────────────────────────────
export interface MemoryRejection {
  readonly schemaVersion: "1";
  readonly proposalId: MemoryProposalId;
  readonly reviewerId: MemoryReviewerId;
  readonly rejectedAt: number;
  readonly reason: string;
}

// ─── Update ───────────────────────────────────────────────────────────────────
// Edits an accepted memory. The storage layer (#206) is required to preserve audit trail
// by emitting a `supersedes` edge from the OLD record's tombstone to the NEW record. This
// envelope pins the new content; the supersession bookkeeping belongs to storage.
//
// All editable fields are optional so a partial update is expressible; the validator
// rejects an update that changes nothing (no field provided), since a no-op update would
// generate a misleading audit entry.
export interface MemoryUpdate {
  readonly schemaVersion: "1";
  readonly memoryId: MemoryId;
  readonly reviewerId: MemoryReviewerId;
  readonly updatedAt: number;
  readonly bodyPatch?: string;
  readonly payloadPatch?: MemoryStructuredPayload;
  readonly tagsPatch?: readonly string[];
  readonly validityPatch?: MemoryValidityInterval;
  readonly sensitivityPatch?: MemorySensitivity;
  readonly retentionHintPatch?: MemoryRetentionHint;
  readonly reviewerNote?: string;
}

// ─── Supersession ─────────────────────────────────────────────────────────────
// Explicit `oldMemoryId → newMemoryId` transition with an edge of kind `supersedes`.
// Distinct from `MemoryUpdate`: an update authors a NEW version of the same record;
// supersession declares that one DIFFERENT record replaces another (e.g. consolidation
// merging two separate decisions into one).
export interface MemorySupersession {
  readonly schemaVersion: "1";
  readonly oldMemoryId: MemoryId;
  readonly newMemoryId: MemoryId;
  readonly reviewerId: MemoryReviewerId;
  readonly supersededAt: number;
  readonly reason: string;
  readonly edgeKind: "supersedes";
}

// ─── Pin / unpin ──────────────────────────────────────────────────────────────
// Pinning flips the `MemoryRecord.pinned` flag. It does NOT change the record's `type`.
// (See the design note in memory.ts: the `pinned` type is reserved for memories whose
// PRIMARY role is a fixed reference; the pinned flag elevates any other type.)
export interface MemoryPin {
  readonly schemaVersion: "1";
  readonly memoryId: MemoryId;
  readonly reviewerId: MemoryReviewerId;
  readonly pinnedAt: number;
  readonly reason?: string;
}

export interface MemoryUnpin {
  readonly schemaVersion: "1";
  readonly memoryId: MemoryId;
  readonly reviewerId: MemoryReviewerId;
  readonly unpinnedAt: number;
  readonly reason?: string;
}

// ─── Archive ──────────────────────────────────────────────────────────────────
// Non-destructive: the record is removed from active retrieval but remains readable in
// the Memory Center for restoration. Status transitions `accepted → archived`.
export interface MemoryArchive {
  readonly schemaVersion: "1";
  readonly memoryId: MemoryId;
  readonly reviewerId: MemoryReviewerId;
  readonly archivedAt: number;
  readonly reason?: string;
}

// ─── Forget ───────────────────────────────────────────────────────────────────
// Destructive delete. The storage layer is required to preserve an audit tombstone that
// records ONLY: the original MemoryId, the original scope (for governance reporting),
// the original status at deletion time, the reviewer, and the deletion timestamp. No
// body, no payload, no provenance content. The `MemoryAuditRecord` carries the
// scope and reason; this envelope pins the inputs.
export interface MemoryForget {
  readonly schemaVersion: "1";
  readonly memoryId: MemoryId;
  readonly reviewerId: MemoryReviewerId;
  readonly forgottenAt: number;
  readonly reason: string;
  // Whether the user has acknowledged the destructive nature. The BFF layer is required
  // to refuse a forget operation where this flag is `false`. Pinning it on the contract
  // keeps the obligation non-bypassable at the type level.
  readonly userAcknowledgedDestructive: true;
}

// ─── Retrieval request ────────────────────────────────────────────────────────
// Scoped query envelope. Retrieval (#210) layers ranking, embedding, and assembly on top.
// At this contract layer we pin only what the request CARRIES, not how it is processed.
export interface MemoryRetrievalRequest {
  readonly schemaVersion: "1";
  readonly requestedAt: number;
  // The set of scope coordinates the caller is authorized to read. A request that omits
  // a scope coordinate cannot retrieve memories at that scope. This is the type-level
  // anchor for the cross-scope visibility invariant: a request with no `scopes` cannot
  // retrieve any memory at all.
  readonly scopes: readonly MemoryScope[];
  readonly typeFilter?: readonly MemoryType[];
  readonly statusFilter?: readonly MemoryStatus[];
  readonly textQuery?: string;
  readonly tagsFilter?: readonly string[];
  // Optional budget hints. The retrieval layer is free to interpret these, but the values
  // pinned here let the caller bound a query without dipping into a separate config.
  readonly maxResults?: number;
  readonly maxBodyChars?: number;
  // Whether to include archived and superseded records. Defaults at the retrieval layer.
  readonly includeArchived?: boolean;
  readonly includeSuperseded?: boolean;
}

// ─── Audit action discriminator ───────────────────────────────────────────────
// One audit record per accepted operation. The discriminator pins which IDs and fields
// are required so the audit ledger reader does not have to inspect a free-form payload.
//
// Invariant: an audit action MUST NOT carry raw memory body, payload, or provenance
// content. References are by ID only; rationale strings are short and validated.
export type MemoryAuditAction =
  | {
      readonly kind: "proposed";
      readonly proposalId: MemoryProposalId;
      readonly scope: MemoryScope;
    }
  | {
      readonly kind: "accepted";
      readonly proposalId: MemoryProposalId;
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    }
  | { readonly kind: "rejected"; readonly proposalId: MemoryProposalId; readonly reason: string }
  | {
      readonly kind: "updated";
      readonly memoryId: MemoryId;
      readonly fieldsChanged: readonly MemoryUpdateField[];
    }
  | {
      readonly kind: "superseded";
      readonly oldMemoryId: MemoryId;
      readonly newMemoryId: MemoryId;
      readonly edgeId: MemoryEdgeId;
      readonly edgeKind: MemoryEdgeKind;
    }
  | { readonly kind: "pinned"; readonly memoryId: MemoryId }
  | { readonly kind: "unpinned"; readonly memoryId: MemoryId }
  | { readonly kind: "archived"; readonly memoryId: MemoryId }
  | {
      readonly kind: "forgotten";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
      readonly reason: string;
    }
  | {
      readonly kind: "retrieved";
      readonly scopes: readonly MemoryScope[];
      readonly matchedMemoryIds: readonly MemoryId[];
    };

// Enumeration of fields an update may touch — kept as a closed string union so an audit
// reader can render a diff summary without a free-form key.
export type MemoryUpdateField =
  | "body"
  | "payload"
  | "tags"
  | "validity"
  | "sensitivity"
  | "retentionHint";

export const MEMORY_UPDATE_FIELDS: readonly MemoryUpdateField[] = [
  "body",
  "payload",
  "tags",
  "validity",
  "sensitivity",
  "retentionHint",
] as const;

// ─── Audit record envelope ────────────────────────────────────────────────────
// Persisted by the audit layer (#214). Carries the action discriminator + minimum
// metadata. `initiatorSurface` lets the audit reader distinguish a Memory Center action
// from an automated consolidation pass without re-deriving from the action kind.
export type MemoryAuditInitiatorSurface =
  | "memory-center"
  | "conversation-center"
  | "workflow"
  | "consolidation"
  | "retention"
  | "system";

export const MEMORY_AUDIT_INITIATOR_SURFACES: readonly MemoryAuditInitiatorSurface[] = [
  "memory-center",
  "conversation-center",
  "workflow",
  "consolidation",
  "retention",
  "system",
] as const;

export interface MemoryAuditRecord {
  readonly id: MemoryAuditRecordId;
  readonly schemaVersion: "1";
  readonly actionKind: MemoryAuditActionKind;
  readonly action: MemoryAuditAction;
  readonly initiatorSurface: MemoryAuditInitiatorSurface;
  readonly initiatorReviewerId?: MemoryReviewerId;
  readonly occurredAt: number;
  // Short audit-side rationale. Bounded by the validator. NEVER carries raw memory
  // content; the invariant is pinned in the validator and in the audit-layer #214 tests.
  readonly summary: string;
}
