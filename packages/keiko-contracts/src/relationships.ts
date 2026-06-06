// Public type contracts for the Keiko relationship engine (Epic #532, Issue #538).
//
// Pure types and frozen constant tables only — no IO, no clock reads, no hashing, no
// randomness, no filesystem access. Leaf-package rule (ADR-0019 direction 1): no
// `@oscharko-dev/keiko-*` imports may appear in this module. The schemaVersion discriminant
// follows the same evolution rule as MEMORY_AUDIT_EVENT_SCHEMA_VERSION and
// LOCAL_KNOWLEDGE_SCHEMA_VERSION: a breaking change introduces a NEW literal member rather
// than mutating "1".
//
// Foundations: docs/relationship-engine/taxonomy.md (object kinds, relationship types,
// per-type metadata), docs/relationship-engine/compatibility-matrix.md (source × target
// pairs), docs/relationship-engine/denial-reasons.md (the 18-code catalog and resolution
// order), docs/relationship-engine/lifecycle.md (the 7-state machine), and
// docs/relationship-engine/activity-state.md (the 9 transient activity states derived from
// existing event streams — durable on the lifecycle column, never persisted on their own).
//
// The relationship record is BODY-FREE by construction (taxonomy.md §12, audit-events.md
// §8.3). The `metadata` bag is a `Readonly<Record<string, unknown>>` so callers may attach
// non-sensitive structural hints; the deterministic validator (relationships-validation.ts)
// rejects forbidden keys outright so a client never accidentally smuggles a prompt or
// document excerpt past the redactor.

// ─── Schema version ───────────────────────────────────────────────────────────
export const RELATIONSHIP_SCHEMA_VERSION = "1" as const;

// ─── Object kinds ─────────────────────────────────────────────────────────────
// Closed enumeration of the 14 object kinds a relationship endpoint may carry. The order
// of this tuple matches the column order of compatibility-matrix.md §2 (alphabetical,
// ignoring the forward-looking suffix) so test fixtures can iterate deterministically.
export const RELATIONSHIP_OBJECT_KINDS = [
  "agent",
  "capsule",
  "capsule-set",
  "chat",
  "connector",
  "data-source",
  "evidence-run",
  "mcp-tool",
  "memory",
  "patch-proposal",
  "skill",
  "tool",
  "workflow-run",
  "workspace-path",
] as const;

export type RelationshipObjectKind = (typeof RELATIONSHIP_OBJECT_KINDS)[number];

// Kinds the relationship engine accepts TODAY. Forward-looking kinds (agent, connector,
// data-source, skill, mcp-tool) are members of RELATIONSHIP_OBJECT_KINDS so the schema is
// stable when their owning registries land (taxonomy.md §4.2), but the validator rejects
// proposals naming them with `denied/object-kind-not-yet-supported`.
export const RELATIONSHIP_SUPPORTED_OBJECT_KINDS = [
  "capsule",
  "capsule-set",
  "chat",
  "evidence-run",
  "memory",
  "patch-proposal",
  "tool",
  "workflow-run",
  "workspace-path",
] as const;

export type RelationshipSupportedObjectKind = (typeof RELATIONSHIP_SUPPORTED_OBJECT_KINDS)[number];

// ─── Relationship types ───────────────────────────────────────────────────────
// Closed enumeration of the seven relationship types (taxonomy.md §5.8). Order matches
// the taxonomy's section ordering so reviewers can cross-walk the table.
export const RELATIONSHIP_TYPES = [
  "reads-context",
  "proposes-patch",
  "uses-tool",
  "starts-workflow",
  "produces-evidence",
  "references-document",
  "depends-on",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

// ─── Lifecycle states ─────────────────────────────────────────────────────────
// Closed enumeration of durable lifecycle states (lifecycle.md §1; taxonomy.md §6.1).
export const RELATIONSHIP_LIFECYCLE_STATES = [
  "draft",
  "active",
  "archived",
  "superseded",
  "revoked",
  "blocked",
  "stale",
] as const;

export type RelationshipLifecycleState = (typeof RELATIONSHIP_LIFECYCLE_STATES)[number];

// ─── Activity states (transient, in-memory derived) ───────────────────────────
// The nine transient activity states from activity-state.md §2. These are NOT persisted
// on the relationship record; the lifecycle column is durable, this enumeration powers
// the inspector / graph overlays only. Surfaced here so downstream UI code can pin
// against a stable closed set in `@oscharko-dev/keiko-contracts`.
export const RELATIONSHIP_ACTIVITY_STATES = [
  "inactive",
  "queued",
  "active",
  "processing",
  "completed",
  "failed",
  "blocked",
  "degraded",
  "high-throughput",
] as const;

export type RelationshipActivityState = (typeof RELATIONSHIP_ACTIVITY_STATES)[number];

// ─── Denial codes ─────────────────────────────────────────────────────────────
// Closed enumeration of the 18 denial codes (denial-reasons.md §"Catalog"). Tuple order
// matches the normative "Resolution order" so the validator and reviewers can keep the
// two views in lock-step. Adding a new code follows the additive-evolution rule from
// taxonomy.md §3.2 (append, document in denial-reasons.md, slot into resolution order).
export const RELATIONSHIP_DENIAL_CODES = [
  "denied/non-existent-source",
  "denied/non-existent-target",
  "denied/object-kind-not-yet-supported",
  "denied/source-kind-not-allowed",
  "denied/target-kind-not-allowed",
  "denied/kind-incompatible",
  "denied/cardinality-exceeded",
  "denied/cycle-forbidden",
  "denied/cross-workspace",
  "denied/path-not-contained",
  "denied/denied-by-deny-list",
  "denied/lifecycle-illegal-transition",
  "denied/endpoint-tombstoned",
  "denied/endpoint-retired",
  "denied/endpoint-unavailable",
  "denied/payload-content-not-permitted",
  "denied/authority-insufficient",
  "denied/schema-version-unsupported",
] as const;

export type RelationshipDenialCode = (typeof RELATIONSHIP_DENIAL_CODES)[number];

// ─── Per-type definition table ────────────────────────────────────────────────
// Cardinality strings follow the convention in taxonomy.md §7 / lifecycle.md §3. The
// table is the single source of truth for the validator's `validSourceKinds` /
// `validTargetKinds` checks; the compatibility matrix file is the human-readable view of
// the same data.
export type RelationshipCardinality = "1:1" | "1:N" | "N:1" | "N:N";
export type RelationshipDirection = "directed" | "undirected";
export type RelationshipEvidenceRelevance = "none" | "reference" | "produces";

export interface RelationshipTypeLifecycleFlags {
  readonly creatable: boolean;
  readonly immutable: boolean;
  readonly reconnectable: boolean;
  readonly deletable: boolean;
  readonly archivable: boolean;
}

export interface RelationshipTypeDefinition {
  readonly id: RelationshipType;
  readonly displayName: string;
  readonly semantics: string;
  readonly validSourceKinds: readonly RelationshipObjectKind[];
  readonly validTargetKinds: readonly RelationshipObjectKind[];
  readonly cardinality: RelationshipCardinality;
  readonly direction: RelationshipDirection;
  readonly lifecycle: RelationshipTypeLifecycleFlags;
  readonly auditEventOnMutation: boolean;
  readonly evidenceRelevance: RelationshipEvidenceRelevance;
  readonly ownerPackage: string;
  readonly trustBoundary: string;
}

// The seven definitions (taxonomy.md §5.1 — §5.7). Kept verbose so a future reader does
// not need to round-trip through the markdown to understand the contract.
export const RELATIONSHIP_TYPE_DEFINITIONS: Readonly<
  Record<RelationshipType, RelationshipTypeDefinition>
> = {
  "reads-context": {
    id: "reads-context",
    displayName: "reads context",
    semantics:
      "A consumer endpoint reads the contextual content of the target at a specific point in time.",
    validSourceKinds: ["workflow-run", "chat"],
    validTargetKinds: [
      "memory",
      "capsule",
      "capsule-set",
      "evidence-run",
      "workspace-path",
      "connector",
      "data-source",
    ],
    cardinality: "N:N",
    direction: "directed",
    lifecycle: {
      creatable: true,
      immutable: true,
      reconnectable: false,
      deletable: false,
      archivable: true,
    },
    auditEventOnMutation: true,
    evidenceRelevance: "reference",
    ownerPackage: "@oscharko-dev/keiko-workflows",
    trustBoundary: "per-endpoint",
  },
  "proposes-patch": {
    id: "proposes-patch",
    displayName: "proposes patch",
    semantics:
      "A workflow run proposes a patch against one or more workspace paths. The relationship records the proposal; diff content stays in the harness PatchProposedEvent.",
    validSourceKinds: ["workflow-run"],
    validTargetKinds: ["workspace-path", "patch-proposal"],
    cardinality: "1:N",
    direction: "directed",
    lifecycle: {
      creatable: true,
      immutable: true,
      reconnectable: false,
      deletable: true,
      archivable: true,
    },
    auditEventOnMutation: true,
    evidenceRelevance: "reference",
    ownerPackage: "@oscharko-dev/keiko-workflows",
    trustBoundary: "fs",
  },
  "uses-tool": {
    id: "uses-tool",
    displayName: "uses tool",
    semantics:
      "A workflow run uses a registered tool. Per-call arguments and results remain in the harness ToolCallRequest / ToolCallResult envelopes.",
    validSourceKinds: ["workflow-run"],
    validTargetKinds: ["tool", "mcp-tool"],
    cardinality: "N:N",
    direction: "directed",
    lifecycle: {
      creatable: true,
      immutable: true,
      reconnectable: false,
      deletable: false,
      archivable: true,
    },
    auditEventOnMutation: true,
    evidenceRelevance: "reference",
    ownerPackage: "@oscharko-dev/keiko-workflows",
    trustBoundary: "tool",
  },
  "starts-workflow": {
    id: "starts-workflow",
    displayName: "starts workflow",
    semantics:
      "A chat or a parent workflow run initiates a workflow run. The relationship records the origin; run identity belongs to the workflow ledger.",
    validSourceKinds: ["chat", "workflow-run"],
    validTargetKinds: ["workflow-run"],
    // The exported cardinality is source-centric for UI display and contract summaries:
    // one chat / parent run may start many runs over time. The validator still enforces
    // the target-side 1:1 invariant separately via startsWorkflowForTarget.
    cardinality: "1:N",
    direction: "directed",
    lifecycle: {
      creatable: true,
      immutable: true,
      reconnectable: false,
      deletable: false,
      archivable: true,
    },
    auditEventOnMutation: true,
    evidenceRelevance: "reference",
    ownerPackage: "@oscharko-dev/keiko-workflows",
    trustBoundary: "per-endpoint",
  },
  "produces-evidence": {
    id: "produces-evidence",
    displayName: "produces evidence",
    semantics:
      "A workflow run produces exactly one durable evidence-run record. If a run produces no evidence, no relationship is recorded.",
    validSourceKinds: ["workflow-run"],
    validTargetKinds: ["evidence-run"],
    cardinality: "1:1",
    direction: "directed",
    lifecycle: {
      creatable: true,
      immutable: true,
      reconnectable: false,
      deletable: false,
      archivable: true,
    },
    auditEventOnMutation: true,
    evidenceRelevance: "produces",
    ownerPackage: "@oscharko-dev/keiko-evidence",
    trustBoundary: "evidence",
  },
  "references-document": {
    id: "references-document",
    displayName: "references document",
    semantics:
      "A chat or workflow run holds a structural pointer to a document (workspace file or local-knowledge capsule). Distinct from reads-context: a reference is structural, a read is an event.",
    validSourceKinds: ["chat", "workflow-run"],
    validTargetKinds: ["workspace-path", "capsule", "capsule-set"],
    cardinality: "N:N",
    direction: "directed",
    lifecycle: {
      creatable: true,
      immutable: false,
      reconnectable: true,
      deletable: true,
      archivable: true,
    },
    auditEventOnMutation: true,
    evidenceRelevance: "reference",
    ownerPackage: "@oscharko-dev/keiko-workflows",
    trustBoundary: "per-endpoint",
  },
  "depends-on": {
    id: "depends-on",
    displayName: "depends on",
    semantics:
      "A capsule, capsule-set, workflow run, or memory depends on another. Used by impact analysis (#542). Self-loops and direct two-edge cycles are forbidden at validation time; transitive cycle detection is deferred to impact traversal.",
    validSourceKinds: ["capsule", "capsule-set", "workflow-run", "memory"],
    validTargetKinds: [
      "capsule",
      "capsule-set",
      "workflow-run",
      "memory",
      "evidence-run",
      "workspace-path",
    ],
    cardinality: "N:N",
    direction: "directed",
    lifecycle: {
      creatable: true,
      immutable: false,
      reconnectable: true,
      deletable: true,
      archivable: true,
    },
    auditEventOnMutation: true,
    evidenceRelevance: "reference",
    ownerPackage: "@oscharko-dev/keiko-contracts",
    trustBoundary: "per-endpoint",
  },
} as const;

// ─── Endpoint + record shapes ─────────────────────────────────────────────────
// An ObjectReference is the opaque triple the relationship engine knows about each
// endpoint. The engine NEVER owns the underlying id — it references it. Endpoint-content
// is the owner's responsibility (per taxonomy.md §2 / §11). The `workspaceId` field is
// the scope check anchor used by `denied/cross-workspace`.
export interface ObjectReference {
  readonly kind: RelationshipObjectKind;
  readonly id: string;
  readonly workspaceId: string;
}

// The full relationship record. Storage fields match storage.md §3.1. Timestamps are
// ISO-8601 strings (per the issue's deliverable shape); the storage layer in #535 will
// transform to/from INTEGER epoch-ms in the SQL row. Etag is a monotonic integer used
// by the API layer for optimistic concurrency (#539).
//
// `metadata` is OPTIONAL and strictly bounded by the validator: any key matching a
// FORBIDDEN substring (audit-events.md §8.3) is rejected with
// `denied/payload-content-not-permitted` so a client cannot accidentally smuggle a
// prompt or document excerpt past the redactor.
export interface Relationship {
  readonly id: string;
  readonly schemaVersion: typeof RELATIONSHIP_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly source: ObjectReference;
  readonly target: ObjectReference;
  readonly type: RelationshipType;
  readonly lifecycleState: RelationshipLifecycleState;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly etag: number;
}

// Optional context for the validator. The pure validator is content-free without context;
// every check that needs more than the proposal itself is gated on the presence of the
// corresponding context field. Storage-only codes (etag-conflict, etc.) and codes that
// require live endpoint resolution (tombstoned / retired / unavailable / path-not-
// contained / denied-by-deny-list / authority-insufficient) are emitted ONLY when the
// caller supplies the relevant context — keeping the validator pure.
export interface RelationshipCardinalityCounts {
  // Existing count of `produces-evidence` relationships for the proposal's source workflow
  // run. The validator rejects with `denied/cardinality-exceeded` if this is >= 1.
  readonly producesEvidenceForSource?: number;

  // Existing count of `starts-workflow` relationships pointing AT the proposal's target
  // workflow run. The validator rejects with `denied/cardinality-exceeded` if this is
  // >= 1 (each workflow run has exactly one origin per taxonomy.md §5.4 / §7).
  readonly startsWorkflowForTarget?: number;
}

// Endpoint liveness reported by the resolver port at the API edge. The validator does
// not call the resolver — the API layer (#539) passes the resolver's result here so the
// pure validator can fold it into the resolution order without doing IO.
export type RelationshipEndpointStatus =
  | "live"
  | "tombstoned"
  | "retired"
  | "unavailable"
  | "missing";

export interface RelationshipEndpointResolverResult {
  readonly source: RelationshipEndpointStatus;
  readonly target: RelationshipEndpointStatus;
}

export interface RelationshipValidationContext {
  // Optional previous lifecycle state for transition validation. When provided, the
  // validator enforces lifecycle.md §2's transition table.
  readonly previousLifecycleState?: RelationshipLifecycleState;

  // Optional cardinality snapshot for the bounded 1:1 checks. The API layer (#539)
  // queries the relationship store for these counts BEFORE invoking the validator.
  readonly cardinalityCounts?: RelationshipCardinalityCounts;

  // Optional endpoint-liveness snapshot from the resolver port. Same pre-call pattern as
  // cardinalityCounts: the API layer composes the resolver, the validator stays pure.
  readonly endpointResolver?: RelationshipEndpointResolverResult;
}

// A single validation error. `field` names the offending field on the input (e.g.
// "source.kind", "metadata.prompt") so the UI inspector can render one panel per
// failure. `message` is short, deterministic, machine-readable (mirrors the
// local-knowledge-validation.ts pattern). Internal-detailed; the API layer redacts to
// the user-facing message catalog in denial-reasons.md before responding.
export interface RelationshipValidationError {
  readonly code: RelationshipDenialCode;
  readonly field?: string;
  readonly message: string;
}

// ─── Forbidden-payload key list ───────────────────────────────────────────────
// The deterministic validator rejects any metadata key whose lowercase form contains
// one of these substrings. The list mirrors audit-events.md §8.3 (raw prompts, model
// output text, document content, tool stdout/stderr, patch bodies, secrets, credentials)
// reduced to the smallest set of token-substrings a payload object would carry. The
// redactor at `packages/keiko-security/src/redaction.ts` runs at the persist boundary;
// this list lets the validator reject upstream so the operator sees the rejection
// rather than a silent redaction (denial-reasons.md `denied/payload-content-not-permitted`).
//
// Case-insensitive substring match: e.g. "promptText" → matches "prompt", "ApiKey" →
// matches "apikey", "rawDocumentContent" → matches "documentcontent".
export const RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS = [
  "prompt",
  "documentcontent",
  "filecontent",
  "toolstdout",
  "toolstderr",
  "secret",
  "credential",
  "apikey",
  "password",
  "token",
] as const;

export type RelationshipForbiddenMetadataKeySubstring =
  (typeof RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS)[number];
