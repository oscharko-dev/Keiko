# Epic #532 — Relationship-Engine Gap Analysis

Status: Wave 1 deliverable for [issue #533](https://github.com/oscharko-dev/Keiko/issues/533) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [adr-candidates.md](adr-candidates.md).

Audit date: 2026-06-06.

Historical note: this document captures the Wave 1 gap analysis before the implementation issues landed. On current `dev`, open choices recorded here are superseded where later documents adopted a final decision; see [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md), [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md), and the later `docs/relationship-engine/*` implementation docs.

## Scope

This document enumerates every `new-capability-gap` and `generalize-port` row in the [reuse matrix](reuse-matrix.md) — the work that cannot be served by adopting an existing surface unchanged. For each, the analysis records:

1. what the gap is (precise contract surface needed);
2. why no existing subsystem can be safely generalized;
3. the smallest possible new surface that closes the gap;
4. the security and evidence invariants the new surface must preserve.

The same reuse-first thesis from [audit.md](audit.md) applies: every gap below is bounded to a contract addition or a pure helper. No new package, no new dependency, no new persistence backend, no new credential surface.

## Gap 1 — Cross-domain endpoint reference type (`RelationshipEndpoint`)

### The gap

The relationship engine needs to model an edge whose source and target may be a `MemoryId`, a `KnowledgeCapsuleId`, a `CapsuleSetId`, a `WorkflowRunId`, an `EvidenceManifestId`, or a workspace path. None of the three existing graph models can carry such a polymorphic endpoint because each is typed to a single endpoint kind:

- `MemoryEdge` carries `fromMemoryId`/`toMemoryId: MemoryId` ([`packages/keiko-contracts/src/memory-records.ts:165`](../../packages/keiko-contracts/src/memory-records.ts)).
- `ConnectorEdge` carries `ConnectorNodeRef { nodeId, kind }` where `kind` is the closed set `"files-window" | "local-knowledge" | "conversation-center"` ([`packages/keiko-contracts/src/local-knowledge.ts:204`](../../packages/keiko-contracts/src/local-knowledge.ts)).
- Workspace `Connection { a, b }` carries opaque `AppWindow.id` strings ([`packages/keiko-ui/src/app/components/desktop/windows/types.ts:22`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts)).

### Why no existing subsystem can be safely generalized

Generalizing `MemoryEdge` would weaken its `MemoryEdgeId` branding (a per-vault identity) and break the foreign-key contract in [`schema.ts:71`](../../packages/keiko-memory-vault/src/schema.ts) (`REFERENCES memories(id) ON DELETE CASCADE`). Generalizing `ConnectorEdge` would force the connector graph to accept memory or evidence endpoints it does not own. Generalizing workspace `Connection` is ruled out by ADR-0026 and by the per-record analysis in [audit.md](audit.md) §"Existing graph model that cannot be safely generalized".

### Smallest new surface

A discriminated union in `keiko-contracts`:

```
type RelationshipEndpoint =
  | { readonly kind: "memory"; readonly id: MemoryId }
  | { readonly kind: "capsule"; readonly id: KnowledgeCapsuleId }
  | { readonly kind: "capsule-set"; readonly id: CapsuleSetId }
  | { readonly kind: "workflow-run"; readonly id: WorkflowRunId }
  | { readonly kind: "evidence-run"; readonly id: EvidenceManifestId }
  | { readonly kind: "workspace-path"; readonly relPath: string };
```

All five existing id types already live in `keiko-contracts` (`MemoryId`, `KnowledgeCapsuleId`, `CapsuleSetId`, `WorkflowRunId`, `EvidenceManifestId`). The sixth case (`workspace-path`) carries the relative path string only; an `assertContainedRealPath` resolution happens at the relationship-engine boundary, not in the contract layer.

### Invariants the new surface must preserve

- Endpoint references are _opaque_: the relationship contract MUST NOT widen any existing id branded type.
- `workspace-path` endpoints MUST pass [`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)'s `assertContainedRealPath` and the [`DEFAULT_DENY_PATTERNS`](../../packages/keiko-workspace/src/ignore.ts) gate before any read or write.
- Endpoint references MUST NOT carry endpoint _content_. Body-free invariant from [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts) applies to the relationship contracts too.

## Gap 2 — Cross-domain endpoint resolver port

### The gap

SQLite foreign keys cannot span databases. When a relationship references a memory in `keiko-memory-vault`'s SQLite database, an evidence run in `keiko-evidence`'s file store, or a workflow run in `keiko-workflows`'s ledger, FK enforcement is structurally impossible. The engine still needs to answer "is endpoint X live?" and "did endpoint X just become unavailable?".

### Why no existing subsystem can be safely generalized

Each owning package has its own concept of "live":

- `keiko-memory-vault` tombstones on hard delete ([`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts), `ON DELETE CASCADE` for edges).
- `keiko-local-knowledge` has `source-lifecycle.ts` and `capsule-lifecycle.ts` running their own state machines.
- `keiko-evidence` has retention with `DEFAULT_RETENTION: maxRuns: 50` ([`packages/keiko-contracts/src/evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)).
- `keiko-workspace` resolves availability per-`realpath`.

A single "live?" function would either duplicate every domain's lifecycle or break the [ADR-0019](../adr/ADR-0019-modular-package-architecture.md) direction rules.

### Smallest new surface

A port in `keiko-contracts`, mirroring the [`EvidenceStore`](../../packages/keiko-contracts/src/evidence.ts) port pattern:

```
interface RelationshipEndpointResolver {
  readonly isLive: (endpoint: RelationshipEndpoint) => Promise<EndpointLiveness>;
}

type EndpointLiveness =
  | { readonly status: "live" }
  | { readonly status: "tombstoned"; readonly tombstonedAt: number; readonly reason?: string }
  | { readonly status: "retired"; readonly retiredAt: number; readonly reason?: string }
  | { readonly status: "unavailable"; readonly reason: string };
```

Each owning package exposes its own resolver implementation (no shared "is-live" code). The relationship engine composes them at the boundary.

### Invariants the new surface must preserve

- Resolvers MUST NOT return endpoint content. `EndpointLiveness` carries timestamps and short rationale strings only.
- Resolvers MUST honour the body-free audit invariant from [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts) and [`memory-operations.ts:288`](../../packages/keiko-contracts/src/memory-operations.ts).
- Resolvers MUST be side-effect-free in respect of the owning domain. They MUST NOT resurrect, hide, or mutate the underlying record.
- A resolver implementation that touches the filesystem MUST go through `assertContainedRealPath`.

## Gap 3 — `RelationshipPolicyDecision` composed result

### The gap

A relationship mutation has to satisfy each endpoint's owning-package policy plus the cross-domain authority rules from [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md). The result must be a single typed decision the BFF returns, with one structured reason per failure so the UI can render an inspector view.

### Why no existing subsystem can be safely generalized

`TerminalCommandDecision { allowed; reason? }` ([`packages/keiko-tools/src/terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts)) covers the shape but not the composition. Each domain's policy already returns its own decision; no surface combines them.

### Smallest new surface

A typed composed result in `keiko-contracts`:

```
interface RelationshipPolicyDecision {
  readonly allowed: boolean;
  readonly reasons: readonly RelationshipPolicyReason[];
}

interface RelationshipPolicyReason {
  readonly endpoint: "source" | "target" | "kind" | "scope";
  readonly code: RelationshipPolicyCode;
  readonly summary: string;
}

type RelationshipPolicyCode =
  | "endpoint-tombstoned"
  | "endpoint-retired"
  | "endpoint-unavailable"
  | "kind-incompatible"
  | "scope-mismatch"
  | "authority-insufficient"
  | "path-not-contained"
  | "denied-by-deny-list";
```

`summary` is a short audit-side rationale, redacted before persistence.

### Invariants the new surface must preserve

- The decision is a _pure function_ over the relationship record, the endpoint-resolver liveness reports, the compatibility matrix, and the descriptor authority fields. No model calls, no file reads, no network calls inside the policy evaluator.
- Decisions persisted to the audit ledger flow through `createAuditRedactor` and `deepRedactStrings` ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts), line 114).
- Relationship existence MUST NOT be treated as authorization (issue #533 stop condition). The policy evaluator's role is gatekeeping mutation, not authorising downstream access.

## Gap 4 — `Relationship` record + `RelationshipKind` + lifecycle

### The gap

A first-class `Relationship` record with `id`, source/target endpoints, kind, scope, lifecycle (`proposed | accepted | archived | superseded | retracted`), `createdAt`, `updatedAt`, optional `confidence`, optional bounded `summary` string.

### Why no existing subsystem can be safely generalized

`MemoryEdge` lacks scope, lifecycle, and the polymorphic endpoint; `ConnectorEdge` lacks scope, lifecycle, and confidence; workspace `Connection` lacks everything beyond the visual link.

### Smallest new surface

A single contract in `keiko-contracts`:

```
type RelationshipId = string & { readonly __brand: "RelationshipId" };

type RelationshipKind =
  | "depends-on"
  | "supersedes"
  | "derived-from"
  | "evidences"
  | "applies-to"
  | "conflicts-with"
  | "related";

interface Relationship {
  readonly id: RelationshipId;
  readonly schemaVersion: "1";
  readonly kind: RelationshipKind;
  readonly source: RelationshipEndpoint;
  readonly target: RelationshipEndpoint;
  readonly scope: MemoryScope;
  readonly lifecycle: RelationshipLifecycle;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly confidence?: number;
  readonly summary?: string;
}

type RelationshipLifecycle =
  | "proposed"
  | "accepted"
  | "archived"
  | "superseded"
  | "retracted";
```

`MemoryScope` is reused from [`packages/keiko-contracts/src/memory.ts`](../../packages/keiko-contracts/src/memory.ts) so the scope vocabulary stays consistent.

### Invariants the new surface must preserve

- Closed `RelationshipKind` set with a companion `RELATIONSHIP_KINDS` readonly array — the established Keiko convention (`MEMORY_EDGE_KINDS`).
- `schemaVersion` is the literal `"1"`, the established pattern across `keiko-contracts`.
- The optional `summary` field is bounded by the validator (no raw bodies, no token-bearing strings, no FS paths outside the relative-path form covered by `assertContainedRealPath`).
- The discriminated-union `RelationshipEndpoint` is opaque; the relationship record never embeds endpoint content.

## Gap 5 — Relationship table + per-database hosting decision

### The gap

A SQLite table that holds `Relationship` records. The hosting question is open: a new SQLite file (e.g., `~/.keiko/relationships.db`), a new table in the memory vault DB, a new table in the UI persistence DB, or a JSON ledger like `keiko-evidence`.

### Why no existing subsystem can be safely generalized

- Hosting in the memory vault DB would couple cross-domain relationships to vault retention and scope semantics.
- Hosting in the UI persistence DB would make relationships UI-durable, conflating session-scoped persistence with durable, audit-bearing records.
- Hosting in evidence-store JSON ledger would make per-row queries (e.g., "all relationships whose endpoint is memory X") O(N).

### Smallest new surface

A new SQLite database in a separate file, owned by a new leaf consumer module (placement TBD between `keiko-contracts` consumer in `keiko-server`, or a new sibling under an existing direction-allowed package). The table convention follows `memory_edges`:

```
CREATE TABLE relationships (
  id TEXT NOT NULL PRIMARY KEY,
  schema_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_coordinate TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confidence REAL,
  summary TEXT
) STRICT;

CREATE INDEX idx_relationships_source ON relationships(source_kind, source_id);
CREATE INDEX idx_relationships_target ON relationships(target_kind, target_id);
CREATE INDEX idx_relationships_scope ON relationships(scope_kind, scope_coordinate, kind);
CREATE INDEX idx_relationships_lifecycle ON relationships(lifecycle, updated_at);
```

The hosting choice itself is recorded by `ADR-0032` (see [adr-candidates.md](adr-candidates.md)).

### Invariants the new surface must preserve

- STRICT mode, deterministic indexes, schema evolution via `PRAGMA user_version`.
- No FK across databases; liveness comes from the endpoint-resolver port (Gap 2).
- `node:sqlite` is activated via `--experimental-sqlite` at the same three sites already documented in [`docs/workspace/518-architecture-blueprint.md`](../workspace/518-architecture-blueprint.md) and exercised by the existing `keiko-server` / `keiko-memory-vault` stores.
- Atomic writes; corrupt-DB quarantine pattern reused from [`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts) and [`packages/keiko-memory-vault/src/db.ts`](../../packages/keiko-memory-vault/src/db.ts) (`.corrupt.<iso>` rename).
- Realpath-contained file location, mirroring the [`EvidenceStore`](../../packages/keiko-evidence/src/store.ts) atomic-file convention.
- Relationship records persisted to this database flow through `createAuditRedactor` on write.

## Gap 6 — Activity stream event family (`relationship:*`)

### The gap

The UI needs a privacy-aware activity feed that surfaces structural relationship changes in near-real time. No existing event family covers cross-domain relationship activity.

### Why no existing subsystem can be safely generalized

- `MemoryAuditEvent` is memory-only and emits at the vault boundary.
- `BaseWorkflowEvent` is workflow-run-scoped.
- The vault `EventSink emit({ kind: "edge:inserted", edge })` ([`packages/keiko-memory-vault/src/vault.ts:238`](../../packages/keiko-memory-vault/src/vault.ts)) is the right shape but the wrong scope.

### Smallest new surface

A new event-kind family in `keiko-contracts`:

```
type RelationshipActivityKind =
  | "relationship:proposed"
  | "relationship:accepted"
  | "relationship:rejected"
  | "relationship:retracted"
  | "relationship:superseded"
  | "relationship:archived"
  | "relationship:impacted";

interface RelationshipActivityEvent {
  readonly schemaVersion: "1";
  readonly kind: RelationshipActivityKind;
  readonly relationshipId: RelationshipId;
  readonly occurredAt: number;
  readonly scope: MemoryScope;
  readonly summary?: string;
}
```

The BFF SSE route enumerates each kind by name so the UI subscribes per-kind, matching the existing `EventSource.addEventListener(...)` pattern in [`packages/keiko-ui/src/lib/useSSE.ts`](../../packages/keiko-ui/src/lib/useSSE.ts).

### Invariants the new surface must preserve

- Body-free: events MUST NOT carry endpoint content, memory bodies, file content, evidence excerpts, or token-bearing strings.
- The summary field flows through `createAuditRedactor` at emit time.
- Activity surfaces visible to a viewer MUST be scoped: a viewer sees only the activity their scope covers, mirroring [connected-context-privacy.md](../connected-context-privacy.md) and the `MemoryScope` discriminator.

## Gap 7 — Audit-event embedding in `EvidenceManifest`

### The gap

Durable, redacted, retention-bound audit records for relationship mutations. The natural home is a new optional section on `EvidenceManifest`.

### Why no existing subsystem can be safely generalized

`EvidenceManifest` is the canonical ledger envelope ([`packages/keiko-contracts/src/evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts)). It already has optional sections (`browser?`, `connectedContext?`, `verification?`). Adding a new section is the established pattern; introducing a parallel audit ledger would duplicate the redaction + retention + atomic-write apparatus.

### Smallest new surface

```
interface EvidenceRelationshipAuditEntry {
  readonly schemaVersion: "1";
  readonly relationshipId: RelationshipId;
  readonly kind: RelationshipActivityKind;
  readonly source: RelationshipEndpoint;
  readonly target: RelationshipEndpoint;
  readonly scope: MemoryScope;
  readonly initiatorSurface: MemoryAuditInitiatorSurface;
  readonly initiatorReviewerId?: MemoryReviewerId;
  readonly occurredAt: number;
  readonly summary: string;
}

interface EvidenceRelationshipAudit {
  readonly schemaVersion: "1";
  readonly entries: readonly EvidenceRelationshipAuditEntry[];
}

// In EvidenceManifest:
readonly relationships?: EvidenceRelationshipAudit | undefined;
```

`MemoryAuditInitiatorSurface` and `MemoryReviewerId` are reused from [`memory-operations.ts`](../../packages/keiko-contracts/src/memory-operations.ts).

### Invariants the new surface must preserve

- Body-free invariant from [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts).
- Persistence flows through `deepRedactStrings` at the persist boundary — the same second-barrier pattern `keiko-evidence` already applies.
- `evidenceSchemaVersion` is bumped per `ADR-0033` (see [adr-candidates.md](adr-candidates.md)); existing readers receive a typed schema-mismatch error rather than silent data corruption.
- Retention: relationship audit entries inherit the run's retention (`DEFAULT_RETENTION: maxRuns: 50`); they do not pin runs from eviction.

## Gap 8 — Bounded impact-analysis primitive

### The gap

`analyzeImpact(relationshipId, budget): ImpactReport` — given a relationship, list the endpoints whose visible state would change if the relationship were retracted, archived, or its endpoint became unavailable. Bounded by an explicit budget so worst-case cost is deterministic.

### Why no existing subsystem can be safely generalized

`graphProximityScore` ([`packages/keiko-memory-retrieval/src/graph.ts:22`](../../packages/keiko-memory-retrieval/src/graph.ts)) is the only bounded, deterministic graph primitive in the codebase and is memory-only. `importGraph` ([`packages/keiko-workspace/src/importGraph.ts`](../../packages/keiko-workspace/src/importGraph.ts)) is FS-only. A naive cross-domain BFS would be unbounded; an unbounded analysis on a relationship store is the dominant correctness risk for #542.

### Smallest new surface

```
interface ImpactBudget {
  readonly maxDepth: number;      // default 1 (single hop, matching graphProximityScore)
  readonly maxNodes: number;      // hard cap; default 256
  readonly maxRelationships: number; // hard cap; default 1024
}

interface ImpactReport {
  readonly relationshipId: RelationshipId;
  readonly impactedEndpoints: readonly RelationshipEndpoint[];
  readonly impactedRelationshipIds: readonly RelationshipId[];
  readonly depthReached: number;
  readonly truncated: boolean;
  readonly truncationReason?: "max-depth" | "max-nodes" | "max-relationships";
}
```

The implementation is a pure function over the in-memory edge-index view. Single-hop default mirrors `graphProximityScore`.

### Invariants the new surface must preserve

- Bounded traversal; explicit `truncated` flag rather than throwing.
- Pure function; no IO, no model calls, no shell execution.
- Body-free; reports do not embed endpoint content.

## Gap 9 — Cross-domain availability/health check

### The gap

A health endpoint that lists relationships whose endpoint is currently `tombstoned`, `retired`, or `unavailable`. Useful to the UI inspector (#540) and to operators (#542).

### Why no existing subsystem can be safely generalized

Each domain's lifecycle status is owned by the domain. No cross-domain "is this id live?" surface exists.

### Smallest new surface

A pure function over the relationship store + the endpoint-resolver port (Gap 2):

```
interface RelationshipHealthReport {
  readonly checkedAt: number;
  readonly total: number;
  readonly entries: readonly RelationshipHealthEntry[];
}

interface RelationshipHealthEntry {
  readonly relationshipId: RelationshipId;
  readonly sourceLiveness: EndpointLiveness;
  readonly targetLiveness: EndpointLiveness;
}
```

Page-able via `(limit, cursor)`; the implementation walks the relationship table and asks each resolver. No write-side effect.

### Invariants the new surface must preserve

- Read-only.
- Body-free.
- Cost-bounded: caller passes `limit`; default cap derived from `maxRuns: 50` precedent (e.g., `limit: 256`).
- Redaction applied to any summary string returned in the report.

## Gap 10 — New `WindowType` entries for the relationship inspector and controlled graph view

### The gap

Two new UI surfaces: an inspector panel that renders a single relationship's metadata and policy decision, and a controlled graph view that renders the subgraph reachable from a focused endpoint.

### Why no existing subsystem can be safely generalized

ADR-0026 locks the workspace substrate; a parallel canvas/graph substrate is rejected. ADR-0029 prescribes the extension contract: a new `WindowType` enum entry, a typed `WindowTypeDef` value, and a `registerWindowRender` binding.

### Smallest new surface

Two enum entries in [`packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts`](../../packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts):

```
"relationships"            // controlled graph view of the scope's relationships
"relationship-inspector"   // single-relationship inspector panel
```

Each entry declares the closed enums from ADR-0029:

- `trustBoundary: ["ui", "memory", "evidence"]` (no `"model"`, no `"tool"`, no `"network"`)
- `authority: "read-only"` for the graph view; `"user"` or `"user-confirm"` for any inspector action that mutates
- `persistence: "transient"` for the graph view; `"durable.ui"` for the inspector's last-viewed-relationship-id (id only, never the relationship body)
- `lifecycle: ["empty", "live", "error"]` for the graph view; an inspector-specific subset for the inspector panel

### Invariants the new surface must preserve

- The descriptor validator in ADR-0029 §2 refuses inconsistent declarations; the new entries must pass it.
- Reuse `ConnectionsLayer` and `connector-graph.tsx` patterns — WCAG 2.2 AA, ≥30×30 hit targets, `aria-live` error alerts, focus rings.
- No new pointer-gesture surface; commands routed through the existing command palette.
- No new persistence surface; the inspector's last-viewed id uses the existing `node:sqlite` UI persistence layer (#62).

## Cross-cutting invariants for every gap above

These re-state the invariants harvested in [audit.md](audit.md) §"Security and evidence invariants" so the gap-analysis is self-contained.

1. Redaction goes through `createAuditRedactor` + `deepRedactStrings` only ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts), line 114). No new redactor.
2. Audit records are body-free ([`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts), [`memory-operations.ts:288`](../../packages/keiko-contracts/src/memory-operations.ts)).
3. UI surfaces flow through [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)'s five rules.
4. Tombstoned/retired/unavailable endpoints surface as such; the engine MUST NOT resurrect their content.
5. Workspace paths pass `assertContainedRealPath` and the `DEFAULT_DENY_PATTERNS` gate.
6. No model-gateway bypass; no shell execution outside `keiko-tools` terminal policy.
7. Schema evolution via `PRAGMA user_version`.
8. No new third-party dependency. No new credential surface. No new persistence backend.

## References

- [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [adr-candidates.md](adr-candidates.md)
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
