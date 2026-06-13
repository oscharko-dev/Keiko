// Public type contracts for the Governed Enterprise Memory Vault (Epic #204, Issue #205).
// Pure types and pure value-emitting frozen const tables only — no IO, no clock reads,
// no hashing, no randomness, no filesystem, no network. Leaf-package rule
// (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports may appear in this module.
//
// The `MEMORY_SCHEMA_VERSION` discriminant follows the same evolution rule as
// `CONNECTED_CONTEXT_SCHEMA_VERSION` and `LOCAL_KNOWLEDGE_SCHEMA_VERSION`: a breaking
// change introduces a NEW literal member rather than mutating "1". Downstream packages
// (storage #206, capture #207, consolidation #208, retrieval #210, ...) pin against this
// literal so a schema break cannot silently propagate.
//
// Cross-cutting invariants (epic §Architecture Invariants):
//  1. Memory is scoped to a concrete coordinate (user / workspace / project / workflow /
//     global). There is no implicit cross-scope visibility — a record at scope kind X is
//     never visible at scope kind Y unless an explicit operation moves it.
//  2. Every durable memory carries provenance and a sensitivity class. The capture and
//     audit layers MUST honour the sensitivity contract; this module pins the type so
//     the obligation is non-bypassable at the type level.
//  3. The status lifecycle is a directed graph; illegal transitions are rejected by the
//     pure validator in memory-validation.ts. The transition matrix lives here so every
//     reader and writer pins against the same source of truth.

// ─── Schema version ───────────────────────────────────────────────────────────
export const MEMORY_SCHEMA_VERSION = "1" as const;

// ─── Branded IDs ──────────────────────────────────────────────────────────────
// Nominal branding via a phantom `unique symbol` property. The brand carrier never lands
// at runtime — only the compiler reads it — so values survive JSON round-trips intact.
// Each ID kind is its own brand so a `UserId` is not assignable to a `ProjectId`, etc.,
// and storage/UI layers cannot collapse two scope coordinates by accident.
declare const MemoryIdBrand: unique symbol;
declare const MemoryProposalIdBrand: unique symbol;
declare const MemoryEdgeIdBrand: unique symbol;
declare const MemoryAuditRecordIdBrand: unique symbol;
declare const MemoryReviewerIdBrand: unique symbol;
declare const UserIdBrand: unique symbol;
declare const WorkspaceIdBrand: unique symbol;
declare const ProjectIdBrand: unique symbol;
declare const WorkflowDefinitionIdBrand: unique symbol;
declare const ConversationIdBrand: unique symbol;
declare const WorkflowRunIdBrand: unique symbol;
declare const EvidenceManifestIdBrand: unique symbol;

export type MemoryId = string & { readonly [MemoryIdBrand]: true };
export type MemoryProposalId = string & { readonly [MemoryProposalIdBrand]: true };
export type MemoryEdgeId = string & { readonly [MemoryEdgeIdBrand]: true };
export type MemoryAuditRecordId = string & { readonly [MemoryAuditRecordIdBrand]: true };
export type MemoryReviewerId = string & { readonly [MemoryReviewerIdBrand]: true };
export type UserId = string & { readonly [UserIdBrand]: true };
export type WorkspaceId = string & { readonly [WorkspaceIdBrand]: true };
export type ProjectId = string & { readonly [ProjectIdBrand]: true };
export type WorkflowDefinitionId = string & { readonly [WorkflowDefinitionIdBrand]: true };
export type ConversationId = string & { readonly [ConversationIdBrand]: true };
export type WorkflowRunId = string & { readonly [WorkflowRunIdBrand]: true };
export type EvidenceManifestId = string & { readonly [EvidenceManifestIdBrand]: true };

// ─── Memory scope ─────────────────────────────────────────────────────────────
// A memory's scope is a concrete coordinate, not a label. Storing only the kind would let
// two records appear identical when they actually belong to different users or projects.
// The discriminated union forces every durable memory to commit to one specific scope
// instance, so cross-scope leakage is unrepresentable in the type system.
export type MemoryScopeKind = "user" | "workspace" | "project" | "workflow" | "global";

export const MEMORY_SCOPE_KINDS: readonly MemoryScopeKind[] = [
  "user",
  "workspace",
  "project",
  "workflow",
  "global",
] as const;

export type MemoryScope =
  | { readonly kind: "user"; readonly userId: UserId }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "workflow"; readonly workflowDefinitionId: WorkflowDefinitionId }
  | { readonly kind: "global" };

// ─── Memory type ──────────────────────────────────────────────────────────────
// "pinned" appears in BOTH the type union AND as a `pinned: boolean` flag on the record.
// A record is born with one type (episodic / semantic-fact / preference / etc.); pinning
// is an orthogonal lifecycle decision that elevates retrieval priority without
// rewriting the record's classification. The type "pinned" is reserved for memories whose
// PRIMARY semantic role is "this is a fixed reference" (e.g. a hand-curated rule the user
// always wants applied). The boolean flag is for elevating ANY other type.
export type MemoryType =
  | "episodic"
  | "semantic-fact"
  | "procedural"
  | "preference"
  | "correction"
  | "decision"
  | "negative"
  | "pinned";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "episodic",
  "semantic-fact",
  "procedural",
  "preference",
  "correction",
  "decision",
  "negative",
  "pinned",
] as const;

// ─── Sensitivity ──────────────────────────────────────────────────────────────
// Capture (#207) and audit (#214) MUST honour the sensitivity contract:
//  - "public":       safe for evidence persistence and MemoriaViva display.
//  - "confidential": requires explicit user approval before persistence; redacted from
//                    audit ledger summaries by default.
//  - "restricted":   rejected by default; capture policy in #207 may further refine.
export type MemorySensitivity = "public" | "confidential" | "restricted";

export const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = [
  "public",
  "confidential",
  "restricted",
] as const;

// ─── Status lifecycle ─────────────────────────────────────────────────────────
// Every memory record carries a status. The transition matrix below is the single source
// of truth; the validator in memory-validation.ts rejects illegal transitions and reports
// the offending pair so the caller can present a precise error.
export type MemoryStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "superseded"
  | "archived"
  | "forgotten"
  | "conflicted"
  | "expired";

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "archived",
  "forgotten",
  "conflicted",
  "expired",
] as const;

// Allowed transitions. Read as: from-state → set of legal next-states.
//
// Design notes (encoded so future readers do not have to reverse-engineer):
//  - "rejected" and "forgotten" are absorbing for normal operation (no outbound edges).
//    "forgotten" is the destructive-delete terminus required by #209.
//  - "superseded" can become "archived" (e.g. when its replacement is itself archived
//    in a batch cleanup) but cannot return to "accepted" — supersession is monotonic.
//  - "conflicted" and "expired" can be rehabilitated back to "accepted" once the
//    conflict-resolution job (#209) or a re-validation pass clears the condition.
//  - "archived" can be restored to "accepted" — archival is non-destructive.
//  - A "proposed" memory can also reach "expired" if its capture window elapses before
//    review (proposal TTL is enforced by #207, not by this contract).
export const MEMORY_STATUS_TRANSITIONS: Readonly<Record<MemoryStatus, readonly MemoryStatus[]>> = {
  proposed: ["accepted", "rejected", "expired"],
  accepted: ["superseded", "archived", "forgotten", "conflicted", "expired"],
  rejected: [],
  superseded: ["archived", "forgotten"],
  archived: ["accepted", "forgotten"],
  forgotten: [],
  conflicted: ["accepted", "superseded", "archived", "forgotten"],
  expired: ["accepted", "archived", "forgotten"],
} as const;

// ─── Provenance source kinds ──────────────────────────────────────────────────
// Pinned vocabulary so capture (#207), consolidation (#208), and audit (#214) cannot
// invent new source kinds out-of-band. New source kinds require a contract version bump.
export type MemorySourceKind =
  | "explicit-user-instruction"
  | "accepted-correction"
  | "workflow-outcome"
  | "consolidation"
  | "system-default";

export const MEMORY_SOURCE_KINDS: readonly MemorySourceKind[] = [
  "explicit-user-instruction",
  "accepted-correction",
  "workflow-outcome",
  "consolidation",
  "system-default",
] as const;

// ─── Edge kinds ───────────────────────────────────────────────────────────────
// The retrieval layer (#210) uses these edges to expand context; the consolidation layer
// (#208) emits them when merging records. "temporal-precedes" is the ordering edge that
// lets a retrieval surface "X happened before Y" without requiring a clock at this layer.
export type MemoryEdgeKind =
  | "related"
  | "derived-from"
  | "supersedes"
  | "corrects"
  | "conflicts-with"
  | "temporal-precedes";

export const MEMORY_EDGE_KINDS: readonly MemoryEdgeKind[] = [
  "related",
  "derived-from",
  "supersedes",
  "corrects",
  "conflicts-with",
  "temporal-precedes",
] as const;

// ─── Audit action kinds ───────────────────────────────────────────────────────
// MemoryAuditRecord (defined in memory-operations.ts) discriminates on these. Kept here
// alongside the other vocabularies so a single import target carries the whole enumeration
// surface.
export type MemoryAuditActionKind =
  | "proposed"
  | "accepted"
  | "rejected"
  | "updated"
  | "superseded"
  | "pinned"
  | "unpinned"
  | "archived"
  | "forgotten"
  | "retrieved";

export const MEMORY_AUDIT_ACTION_KINDS: readonly MemoryAuditActionKind[] = [
  "proposed",
  "accepted",
  "rejected",
  "updated",
  "superseded",
  "pinned",
  "unpinned",
  "archived",
  "forgotten",
  "retrieved",
] as const;
