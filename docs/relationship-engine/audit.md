# Epic #532 — Existing-Pattern Audit for the Semantic Relationship Engine

Status: Wave 1 deliverable for [issue #533](https://github.com/oscharko-dev/Keiko/issues/533) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532).

Audit date: 2026-06-06. Companion documents: [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md).

## Purpose

This document maps the proposed semantic relationship engine (Relationship, RelationshipType, RelationshipPolicy, RelationshipActivity, RelationshipAuditEvent, ImpactAnalysis, Visualization) onto the Keiko surfaces that already exist. The output is the reuse plan that constrains issues #534 (taxonomy), #535 (policy/API/storage), #536 (audit/activity model), and #537 (UI blueprint) so they extend existing subsystems rather than build a second incompatible graph.

The audit is documentation only. No package code, ADR, README, test, or workflow file is modified.

## Reuse-first thesis

Keiko already ships every primitive the relationship engine names, distributed across `keiko-memory-vault`, `keiko-contracts`, `keiko-local-knowledge`, `keiko-ui`, `keiko-evidence`, `keiko-security`, `keiko-workspace`, `keiko-tools`, `keiko-model-gateway`, and `keiko-workflows`. The same conclusion that closed issue [#529](https://github.com/oscharko-dev/Keiko/issues/529) — "the substrate already exists, parallel substrates violate the reuse gate" — applies to the relationship engine.

Specifically:

- A typed first-class graph contract (`MemoryEdge`, `MemoryEdgeKind`) and a persistent, foreign-key-enforced edge table already exist in `keiko-memory-vault` ([`src/edges.ts`](../../packages/keiko-memory-vault/src/edges.ts), [`src/schema.ts:68`](../../packages/keiko-memory-vault/src/schema.ts)).
- A separate, narrower graph contract for the connector surface (`ConnectorGraphState`, `ConnectorNode`, `ConnectorEdge`) exists in `keiko-contracts` ([`src/local-knowledge.ts:209`](../../packages/keiko-contracts/src/local-knowledge.ts)).
- A workspace-level "connection" surface (`Connection { a, b }`) exists in the UI ([`packages/keiko-ui/src/app/components/desktop/windows/types.ts:22`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts), renderer in [`windows/ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx)).
- An object registry with declarative `trustBoundary`, `authority`, and `persistence` fields is approved in [ADR-0029](../adr/ADR-0029-workspace-object-registry.md).
- An audit-event vocabulary, redaction layer, and run-ledger contract are shipped in `keiko-contracts` ([`memory-audit-events.ts`](../../packages/keiko-contracts/src/memory-audit-events.ts), [`memory-operations.ts:288`](../../packages/keiko-contracts/src/memory-operations.ts)) and `keiko-evidence` ([`src/types.ts`](../../packages/keiko-evidence/src/types.ts), [`src/build.ts`](../../packages/keiko-evidence/src/build.ts)).
- A redactor and secret-pattern set live in `keiko-security` ([`src/redaction.ts:50`](../../packages/keiko-security/src/redaction.ts), [`src/secrets.ts`](../../packages/keiko-security/src/secrets.ts)).
- Visualization surfaces for graphs exist as the connector-graph view ([`local-knowledge/connector-graph.tsx`](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx)) and the workspace `ConnectionsLayer`.

The relationship engine therefore must be assembled by **adopting** these surfaces unchanged where their semantics fit, **extending** them with a contract addition where their shape is close, and **generalizing through a port** where two existing graph models cannot be unified without breaking package boundaries.

## Methodology

For each relationship-engine concept the audit:

1. enumerates the existing Keiko subsystems whose semantics overlap, with `package/path:line` citations;
2. records what the subsystem provides today;
3. records what it cannot supply (missing fields, scope mismatch, package-boundary block);
4. recommends a reuse mode (adopt-unchanged, extend-with-contract, generalize-port, new-capability-gap) for that concept.

The disposition flows into [reuse-matrix.md](reuse-matrix.md); gaps flow into [gap-analysis.md](gap-analysis.md); decisions requiring an ADR flow into [adr-candidates.md](adr-candidates.md).

### Packages inspected

| Package                                    | Surfaces inspected                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@oscharko-dev/keiko-contracts`            | `memory.ts`, `memory-records.ts`, `memory-operations.ts`, `memory-audit-events.ts`, `local-knowledge.ts`, `local-knowledge-validation.ts`, `evidence.ts`, `workflow-descriptor.ts`, `workflow-handoff.ts`, `bff-wire.ts`, `boundary.test.ts` |
| `@oscharko-dev/keiko-memory-vault`         | `edges.ts`, `schema.ts`, `vault.ts`, `validate.ts`, `redact-record.ts`, `tombstones.ts`                                                                                                                                                      |
| `@oscharko-dev/keiko-memory-governance`    | `retention.ts`, `correction.ts`, `conflict.ts`, `status-ops.ts`, `suppression.ts`, `forget.ts`                                                                                                                                               |
| `@oscharko-dev/keiko-memory-capture`       | `capture.ts`, `policy.ts`, `intent-explicit.ts`, `intent-workflow.ts`                                                                                                                                                                        |
| `@oscharko-dev/keiko-memory-retrieval`     | `graph.ts`, `relevance.ts`, `recency.ts`, `ranking.ts`, `retrieve.ts`                                                                                                                                                                        |
| `@oscharko-dev/keiko-memory-consolidation` | (consolidation emits superseding edges; consumed via vault)                                                                                                                                                                                  |
| `@oscharko-dev/keiko-local-knowledge`      | `discovery/`, `retrieval/`, `composition.ts`, `capsule-lifecycle.ts`, `source-lifecycle.ts`                                                                                                                                                  |
| `@oscharko-dev/keiko-evidence`             | `types.ts`, `build.ts`, `persist.ts`, `store.ts`, `retention.ts`, `redaction.ts`, `connected-context-evidence.ts`, `workflow-evidence.ts`                                                                                                    |
| `@oscharko-dev/keiko-security`             | `redaction.ts`, `secrets.ts`, `hashing.ts`, `runid.ts`                                                                                                                                                                                       |
| `@oscharko-dev/keiko-workspace`            | `realpath.ts`, `ignore.ts`, `discovery.ts`, `paths.ts`, `index.ts`                                                                                                                                                                           |
| `@oscharko-dev/keiko-tools`                | `registry.ts`, `terminal-policy.ts`, `patch.ts`, `sandbox.ts`, `schemas.ts`                                                                                                                                                                  |
| `@oscharko-dev/keiko-model-gateway`        | `types.ts`, `capabilities.ts`, `config.ts`, `model-selection.ts`                                                                                                                                                                             |
| `@oscharko-dev/keiko-workflows`            | `workflow-descriptor` (via contracts), workflow-handoff                                                                                                                                                                                      |
| `@oscharko-dev/keiko-ui`                   | `components/desktop/Workspace.tsx`, `windows/WindowsRegistry.ts`, `windows/ConnectionsLayer.tsx`, `windows/connectionUtils.ts`, `windows/types.ts`, `local-knowledge/connector-graph.tsx`, `local-knowledge/connector-graph-state.ts`        |

Companion documents already inspected: [`docs/workspace/518-canvas-graph-deferral.md`](../workspace/518-canvas-graph-deferral.md), [`docs/workspace/518-architecture-blueprint.md`](../workspace/518-architecture-blueprint.md), [`docs/workspace/518-reference-analysis.md`](../workspace/518-reference-analysis.md), [`docs/adr/ADR-0026-workspace-substrate.md`](../adr/ADR-0026-workspace-substrate.md), [`docs/adr/ADR-0027-workspace-state-ownership.md`](../adr/ADR-0027-workspace-state-ownership.md), [`docs/adr/ADR-0029-workspace-object-registry.md`](../adr/ADR-0029-workspace-object-registry.md), [`docs/adr/ADR-0030-workspace-security-evidence.md`](../adr/ADR-0030-workspace-security-evidence.md), [`docs/connected-context-privacy.md`](../connected-context-privacy.md), [`docs/security-and-audit-boundaries.md`](../security-and-audit-boundaries.md).

## Concept 1 — Relationship (source, target, type, scope, lifecycle)

### Existing subsystems

1. **`MemoryEdge`** in [`packages/keiko-contracts/src/memory-records.ts:162`](../../packages/keiko-contracts/src/memory-records.ts). A typed first-class edge contract with `id: MemoryEdgeId`, `schemaVersion: "1"`, `fromMemoryId`, `toMemoryId`, `kind: MemoryEdgeKind`, `createdAt: number`, optional `confidence: number`, optional `provenanceSummary: string`. The accompanying header comment is explicit that "edges live in their own table at the storage layer (#206). At this contract layer they are first-class so retrieval (#210) and consolidation (#208) can reason about the graph without dipping into storage-internal shapes."
2. **`memory_edges`** SQLite table in [`packages/keiko-memory-vault/src/schema.ts:68`](../../packages/keiko-memory-vault/src/schema.ts) with FK-enforced endpoints (`REFERENCES memories(id) ON DELETE CASCADE`), `STRICT`, and `idx_edges_from`/`idx_edges_to` indexes. The persistence path is exercised by [`packages/keiko-memory-vault/src/edges.ts`](../../packages/keiko-memory-vault/src/edges.ts) (`insertEdgeRow`, `listOutgoingEdgeRows`, `listIncomingEdgeRows`, `deleteEdgeRow`) and surfaced on the `MemoryVaultStore` API via `insertEdge`, `listOutgoingEdges`, `listIncomingEdges`, `deleteEdge` ([`vault.ts:222`](../../packages/keiko-memory-vault/src/vault.ts)). The `gateMemoryEdge` validator in [`vault.ts:96`](../../packages/keiko-memory-vault/src/vault.ts) runs before insert; redaction (`redactMemoryEdge`) runs at the persist boundary.
3. **`ConnectorEdge`** and **`ConnectorNode`** in [`packages/keiko-contracts/src/local-knowledge.ts:204`](../../packages/keiko-contracts/src/local-knowledge.ts) — a connector-graph edge with `from: ConnectorNodeRef`, `to: ConnectorNodeRef`, `createdAt: number`. Node kinds are the closed set `"files-window" | "local-knowledge" | "conversation-center"`. This is a different graph: it does not connect memories, it connects UI surfaces that participate in the Local Knowledge Connector.
4. **`Connection`** in [`packages/keiko-ui/src/app/components/desktop/windows/types.ts:22`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts) — a workspace-level link `{ id, a, b }` between two `AppWindow` ids, drawn by [`ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx) and hit-tested by [`connectionUtils.ts`](../../packages/keiko-ui/src/app/components/desktop/windows/connectionUtils.ts). Symmetric, type-free, hashing only the participant ids.

### What is missing or cannot be safely generalized

- The three edge contracts cover three different domains (memory provenance graph, capsule-connector graph, workspace window connections). Their kind enumerations, identity types, persistence backends, and scope semantics are not interchangeable. Generalizing them into a single `Relationship` record would require flattening their identity types and would either weaken `MemoryEdgeId` (a branded type tied to the memory vault's storage scope) or pollute the connector graph (which does not allow `MemoryId` endpoints by construction).
- None of the three carries an explicit `scope` field (workspace, project, conversation, workflow, global). The workspace `Connection` is implicitly tab-session-scoped; the `MemoryEdge` inherits scope from its endpoint memories; the `ConnectorEdge` inherits scope from its node kinds.
- None of the three carries an explicit `lifecycle` field (proposed / accepted / archived / superseded). The memory layer has lifecycle on the records themselves (via the `memory-operations.ts:208` `MemoryAuditAction`) but the edge record carries `createdAt` only.

### Recommended reuse path

- **Adopt unchanged** for the memory-graph layer. Memory-vault edges remain the source of truth for memory-to-memory relationships.
- **Adopt unchanged** for capsule-connector edges. Connector graphs continue to model files-window/local-knowledge/conversation-center adjacency.
- **Adopt unchanged** for workspace `Connection`s. They model UI window adjacency, not domain relationships, and ADR-0026 already locks the workspace substrate.
- **Extend with contract** for the relationship engine itself: introduce a `Relationship` contract in `keiko-contracts` that _references_ (does not generalize) the three above by storing typed source/target references (`{ kind: "memory"; id: MemoryId } | { kind: "capsule"; id: KnowledgeCapsuleId } | { kind: "workspace-object"; id: string }` and so on). The relationship engine becomes the cross-domain layer; the per-domain graphs remain as today.

This split mirrors the established split between [ADR-0019](../adr/ADR-0019-modular-package-architecture.md)'s direction-1 leaf packages and the consumers that compose them, and is the same pattern ADR-0026 uses for the workspace substrate.

## Concept 2 — RelationshipType (closed kind set, type compatibility)

### Existing subsystems

1. **`MemoryEdgeKind`** in [`packages/keiko-contracts/src/memory.ts:191`](../../packages/keiko-contracts/src/memory.ts): `"related" | "derived-from" | "supersedes" | "corrects" | "conflicts-with" | "temporal-precedes"`. Each is documented inline with its semantic intent and which downstream layer emits/consumes it. The companion `MEMORY_EDGE_KINDS` array at line 199 is the runtime-iterable set.
2. **`MemoryEdgeKind` semantics in retrieval** at [`packages/keiko-memory-retrieval/src/graph.ts:20`](../../packages/keiko-memory-retrieval/src/graph.ts): the proximity scorer narrows the closed set to `{ "related", "supersedes", "corrects" }` — `conflicts-with`, `temporal-precedes`, and `derived-from` are explicitly excluded with header-comment rationale. This is an example of a **per-kind policy** already running over the closed set.
3. **`ConnectorNodeKind`** in [`packages/keiko-contracts/src/local-knowledge.ts:174`](../../packages/keiko-contracts/src/local-knowledge.ts): a closed node-kind enumeration; the connector graph's type compatibility is expressed via the `ConnectorNode` discriminated union (`"files-window" | "local-knowledge" | "conversation-center"`).
4. **`TrustBoundary` / `AuthorityRequirement` / `PersistenceExpectation` / `LifecycleState`** in [ADR-0029](../adr/ADR-0029-workspace-object-registry.md) — the workspace object registry already defines four closed enums for object-level invariants. The descriptor validator refuses any value outside the closed set (ADR-0029 §2.5).
5. **`MEMORY_AUDIT_INITIATOR_SURFACES`** in [`memory-operations.ts:279`](../../packages/keiko-contracts/src/memory-operations.ts): a closed set documenting _who_ initiated an action. This is the audit-side parallel to a type system.

### What is missing or cannot be safely generalized

- No package defines a **type-compatibility matrix** between relationship kinds and source/target object types. The closest existing artefact is `validateConnectorGraphState` in [`local-knowledge-validation.ts:508`](../../packages/keiko-contracts/src/local-knowledge-validation.ts), which validates `from.kind` and `to.kind` against the resolved node-kind map for the connector graph only.
- The relationship-engine concept of "`derives-from` only valid between artefact and document, `supersedes` only valid between artefact and artefact of same type" has no equivalent. The memory layer applies the rule informally (consolidation only emits `supersedes` between two memories), but no contract enforces it.

### Recommended reuse path

- **Adopt** the closed-string-union + companion runtime-iterable-array pattern (`MemoryEdgeKind` + `MEMORY_EDGE_KINDS`, [`memory.ts:191`](../../packages/keiko-contracts/src/memory.ts)) for `RelationshipType`. This is the established Keiko convention for closed sets and is the same shape ADR-0029 prescribes for object-registry enums.
- **Extend with contract** for the compatibility matrix: a pure function with the discriminated-result shape (`ValidationOk<T> | ValidationFail`) already standardised in [`local-knowledge-validation.ts:29`](../../packages/keiko-contracts/src/local-knowledge-validation.ts) is the right vehicle. Issue #534 lands the matrix; issue #538 implements the deterministic validator.

## Concept 3 — RelationshipEdge (storage shape, indexes, FK behaviour)

### Existing subsystems

1. **`memory_edges` SQLite schema** in [`packages/keiko-memory-vault/src/schema.ts:68`](../../packages/keiko-memory-vault/src/schema.ts) — STRICT mode, FK on both endpoints with `ON DELETE CASCADE`, dual indexes on `(from_memory_id, kind)` and `(to_memory_id, kind)`, optional `confidence REAL` and `provenance_summary TEXT`.
2. **`EdgeRow` ↔ `MemoryEdge` mapper** in [`packages/keiko-memory-vault/src/edges.ts:31`](../../packages/keiko-memory-vault/src/edges.ts) — column-name ↔ camelCase mapping with optional-field-absent-vs-null normalization, the pattern used across the vault.
3. **`node:sqlite` `--experimental-sqlite` strategy** documented in the [Epic #62 memory entry](../workspace/518-architecture-blueprint.md) and exercised in production by the memory vault. The same `PRAGMA user_version` schema-evolution pattern is established.
4. **Atomic file writes with realpath containment** for evidence in [`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts) and `O_EXCL` semantics — the persistence convention for non-DB ledger writes.

### What is missing or cannot be safely generalized

- A `relationships` SQL table does not exist. The memory vault's `memory_edges` is endpoint-typed to `memory_id` foreign keys, so it cannot host a cross-domain relationship without dropping its FK guarantees.
- No package owns a "polymorphic relationship store" today. The closest pattern is the BFF UI persistence layer ([Epic #62 memory entry](../workspace/518-architecture-blueprint.md)), which uses `node:sqlite` for UI-durable layout.

### Recommended reuse path

- **Adopt** the `memory_edges` schema convention (STRICT, FK with `ON DELETE CASCADE` where the endpoint is in-store; named index per query path; optional confidence; redact-at-persist) as the template for the relationship table.
- **Adopt** the `node:sqlite` + `--experimental-sqlite` invocation contract (no new dependency).
- **Generalize through a port**: where source/target endpoints span packages (`MemoryId`, `KnowledgeCapsuleId`, `WorkflowRunId`, `EvidenceManifestId`, etc.), FK constraints cannot be expressed across SQLite files. The relationship store must accept a **resolver port** that asks the owning package whether an endpoint id is live (and obtain its tombstone status). This is the same `EvidenceStore` port pattern in [`packages/keiko-contracts/src/evidence.ts:355`](../../packages/keiko-contracts/src/evidence.ts).

Issue #535 records the storage choice in an ADR (`ADR-0032` candidate, see [adr-candidates.md](adr-candidates.md)).

## Concept 4 — RelationshipPolicy (who may create, mutate, query)

### Existing subsystems

1. **Five inviolable workspace rules** in [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md). Each rule names the chokepoint that enforces it. Rules 1, 2, 3, and 5 are directly applicable to relationship mutations.
2. **`TrustBoundary` / `AuthorityRequirement` descriptor fields** in [ADR-0029 §1](../adr/ADR-0029-workspace-object-registry.md). Closed enums; `"ui-only" | "user" | "user-confirm" | "read-only"` and `"ui" | "fs" | "tool" | "model" | "evidence" | "memory" | "network"`.
3. **Terminal command policy** in [`packages/keiko-tools/src/terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts) — the `TerminalCommandDecision` shape and `isTerminalCommandAllowed` function are the canonical allow-list policy in the product. They model "explicit decision with reason".
4. **Workspace path containment** in [`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts). `assertContainedRealPath` is the single chokepoint for FS access; the discovery layer ([`discovery.ts:211`](../../packages/keiko-workspace/src/discovery.ts)) documents the order "boundary → deny → realpath containment → size cap → read → redact".
5. **Memory governance** in `keiko-memory-governance` (`retention.ts`, `forget.ts`, `suppression.ts`, `correction.ts`, `conflict.ts`, `status-ops.ts`). The package already operates as the policy layer over the vault, and the [security-and-audit-boundaries doc](../security-and-audit-boundaries.md) records its eleven audit events as the audit surface.
6. **Memory audit-event invariant** in [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts): "MUST NOT carry raw memory body or payload". Same invariant pinned on [`MemoryAuditRecord` at memory-operations.ts:288](../../packages/keiko-contracts/src/memory-operations.ts).

### What is missing or cannot be safely generalized

- No single package today owns a _cross-domain_ relationship policy. Each domain has its own (memory governance for memories, terminal policy for commands, realpath for FS, audit invariants for evidence).
- The relationship engine's policy is by definition a composition of those domain policies (a relationship that names a memory endpoint inherits the memory-vault policy; a relationship that names a workspace object inherits the FS-containment policy where appropriate).

### Recommended reuse path

- **Adopt** the `TerminalCommandDecision` shape (`{ allowed: boolean; reason?: string }` — [terminal-policy.ts:148](../../packages/keiko-tools/src/terminal-policy.ts)) as the canonical "decision with reason" shape for relationship-policy results.
- **Adopt** the ADR-0029 enums (`TrustBoundary`, `AuthorityRequirement`) as the relationship-policy vocabulary — a relationship-engine ADR cannot introduce a parallel enum without breaking the audit narrative ADR-0030 established.
- **Generalize through a port**: every relationship endpoint kind exposes an `isPolicyLive(id): { allowed; reason?; tombstone?: TombstoneRef }` resolver. The relationship-engine policy evaluator composes per-endpoint resolvers — it does not own a per-domain rule. The same composition pattern is the [`EvidenceDeps`](../../packages/keiko-contracts/src/evidence.ts) port set.

## Concept 5 — RelationshipActivity (lightweight read-time activity stream)

### Existing subsystems

1. **Memory-vault `EventSink`** (`emit({ kind: "edge:inserted", edge })` in [`vault.ts:238`](../../packages/keiko-memory-vault/src/vault.ts)) — already emits an activity event each time an edge is inserted. The pattern follows the harness `EventSink` in `keiko-harness`.
2. **`MemoryAuditEventKind`** closed set in [`packages/keiko-contracts/src/memory-audit-events.ts:41`](../../packages/keiko-contracts/src/memory-audit-events.ts) — eleven audit events; each is body-free by construction (`memory-audit-events.ts:19`).
3. **Workflow `BaseWorkflowEvent`** envelopes in [`packages/keiko-contracts/src/unit-test-events.ts:57`](../../packages/keiko-contracts/src/unit-test-events.ts), [`bug-investigation-events.ts:164`](../../packages/keiko-contracts/src/bug-investigation-events.ts). The envelope shape with `schemaVersion`, `runId`, `kind` discriminator, and per-kind fields is the established Keiko activity-stream pattern.
4. **SSE stream from the BFF** for workflow events — established (memory entries) and consumed by the UI through `EventSource` with `addEventListener(kind, ...)`.

### What is missing or cannot be safely generalized

- No package emits a _cross-domain_ relationship-activity stream today. Each domain emits its own.
- No domain emits a privacy-aware "activity" view that distinguishes "user-visible structural change" from "internal vault rebalance". The relationship-engine UI (#541) needs the former; the audit ledger (#536) needs the latter.

### Recommended reuse path

- **Adopt** the `BaseWorkflowEvent`/`EventSink` envelope pattern unchanged. Relationship activity becomes a new event family.
- **Extend with contract** for the closed set of activity kinds (`relationship:proposed | relationship:accepted | relationship:rejected | relationship:retracted | relationship:archived | relationship:impacted`) — same shape as `MemoryAuditEventKind`.
- **Adopt** the body-free invariant from [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts): a `RelationshipActivity` event carries IDs and short audit-side rationale strings; never raw memory bodies, raw file content, or token-bearing strings.

## Concept 6 — RelationshipAuditEvent (durable, redacted, evidence-bearing)

### Existing subsystems

1. **`EvidenceManifest`** at [`packages/keiko-contracts/src/evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts) — the run-ledger envelope with `evidenceSchemaVersion: "1"`, run identity, model, usage totals, optional sections for state transitions, tool calls, command executions, sandbox configurations, verification results, patch, reasoning, browser captures, and connected-context audit. Every section is already redacted-by-construction (`packages/keiko-evidence/src/build.ts`).
2. **`createAuditRedactor` + `deepRedactStrings`** in [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts). The deep redactor walks every string leaf; the idempotency guarantee makes it safe to apply at build time AND again at persist time. ADR-0010 D3 names this the "audit-redaction layer".
3. **Evidence store** in [`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts) — atomic file writes, `O_EXCL`, realpath-contained, retention via [`retention.ts`](../../packages/keiko-evidence/src/retention.ts) with the `DEFAULT_RETENTION: maxRuns: 50` policy from [`evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts). The retention pass always keeps the newest record.
4. **`MemoryAuditRecord`** at [`memory-operations.ts:288`](../../packages/keiko-contracts/src/memory-operations.ts). `actionKind`, `action` (discriminated union), `initiatorSurface`, optional `initiatorReviewerId`, `occurredAt`, bounded `summary` string. The body-free invariant is enforced by the validator and pinned in the audit-layer #214 tests.
5. **Workflow-evidence integration** in [`packages/keiko-evidence/src/workflow-evidence.ts`](../../packages/keiko-evidence/src/workflow-evidence.ts) — the cross-layer extraction the eval harness already uses.

### What is missing or cannot be safely generalized

- The relationship-engine audit shape (which manifest section embeds relationship audit fields, and how `evidenceSchemaVersion` reacts to its addition) is not defined.
- A new `EvidenceManifest` section is the natural home; bumping `evidenceSchemaVersion` is a breaking change and requires an ADR (issue #536).

### Recommended reuse path

- **Adopt** `EvidenceManifest` unchanged; add a new optional `relationships?` section the same way `connectedContext?` was added in `EvidenceConnectedContextAudit` ([`evidence.ts:249`](../../packages/keiko-contracts/src/evidence.ts)) — the addition is backwards-compatible because the field is optional, but bumping `evidenceSchemaVersion` is still recommended for forward compatibility.
- **Adopt** `createAuditRedactor` + `deepRedactStrings` as the redaction primitive — _do not_ introduce a second redactor.
- **Adopt** the body-free invariant from `MemoryAuditRecord`. Relationship-engine audit records reference relationship ids, endpoint ids, and short summary strings only. Endpoint _content_ (memory body, file content, evidence excerpt) is never duplicated into the relationship audit.

## Concept 7 — ImpactAnalysis (bounded "what changes if I remove this relationship?")

### Existing subsystems

1. **`graphProximityScore`** in [`packages/keiko-memory-retrieval/src/graph.ts:22`](../../packages/keiko-memory-retrieval/src/graph.ts). Pure function, bounded (one hop), no transitive closure, with a documented `1 - 1/(1+n)` normalization. The header comment is explicit: "no state, no recursion, no transitive closure — so cost is O(edges_for_memory)".
2. **`importGraph`** in [`packages/keiko-workspace/src/importGraph.ts`](../../packages/keiko-workspace/src/importGraph.ts) — a workspace-local impact graph already used by the workflows layer. Containment-checked, gitignore-aware, bounded.
3. **`MemoryAuditAction "superseded"`** at [`memory-operations.ts:227`](../../packages/keiko-contracts/src/memory-operations.ts). The supersedence audit record names `{ oldMemoryId, newMemoryId, edgeId, edgeKind }`. This is the existing reify-the-impact pattern.
4. **`detect.ts`** and **`gitHistory.ts`** in `keiko-workspace` — additional bounded read-only impact-style primitives.

### What is missing or cannot be safely generalized

- No cross-domain "if I retract this relationship, which downstream artefacts change?" function exists. `graphProximityScore` is the only bounded impact primitive and is memory-only.
- No bounded, deterministic impact-analysis ADR exists. The risk of an unbounded BFS over an unfamiliar graph is the dominant correctness concern for #542.

### Recommended reuse path

- **Adopt** the bounded, single-hop, pure-function shape of `graphProximityScore` ([`graph.ts:22`](../../packages/keiko-memory-retrieval/src/graph.ts)) as the template for `analyzeImpact(relationshipId): ImpactReport`.
- **Extend with contract** for the report shape: a discriminated `{ ok: true; impactedIds; depth; truncated: boolean } | { ok: false; reason }` — the same `ValidationOk<T> | ValidationFail` shape standardised across `keiko-contracts`.
- **Adopt** `importGraph`'s pattern of bounded traversal with explicit budget exhaustion (rather than throwing) as the deterministic-budget pattern for #542.

## Concept 8 — Visualization (read-only, controlled, accessible)

### Existing subsystems

1. **Workspace `ConnectionsLayer.tsx`** at [`packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx). SVG `viewBox="-10000 -10000 20000 20000"`, 1:1 world↔pixel mapping, deterministic path math in [`connectionUtils.ts`](../../packages/keiko-ui/src/app/components/desktop/windows/connectionUtils.ts), per-connection `aria-label` on the remove button.
2. **Capsule `connector-graph.tsx`** at [`packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx`](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx). WCAG-conformant focus rings, ≥30×30 hit targets, `aria-live="assertive"` error alerts (per [518-canvas-graph-deferral.md](../workspace/518-canvas-graph-deferral.md)).
3. **`AppShell`/`LeftRail`/`Header`/`Workspace`/`RightRail`/`Footer`** shell composition documented in [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md).
4. **Object registry extension contract** in [ADR-0029](../adr/ADR-0029-workspace-object-registry.md). New first-class object types (a "relationship inspector" panel, a "controlled relationship graph" view) are added by extending `WindowsRegistry.ts` plus `registerWindowRender`.

### What is missing or cannot be safely generalized

- ADR-0026 explicitly **forbids** an "independent graph substrate". The existing `ConnectionsLayer` + connector-graph patterns must cover the relationship visualization need; a parallel substrate would re-trigger the #529 deferral analysis.
- A capsule-graph-style "controlled graph view" rendering relationship edges between memories, capsules, workflow runs, and evidence runs is not yet implemented. It must be a new registered window type, not a new substrate.

### Recommended reuse path

- **Adopt** ADR-0026's substrate decisions unchanged. The relationship inspector is a new `WindowType` entry; the controlled relationship graph view is a new `WindowType` entry; both reuse the existing renderer + camera + viewport + hit-test seams.
- **Extend with contract** for the descriptor fields: each new window type declares its closed `lifecycle`, `trustBoundary`, `authority`, and `persistence` per ADR-0029.
- **Adopt** WCAG-conformant focus-ring + ≥30×30 hit-target patterns from `connector-graph.tsx` per [518-canvas-graph-deferral.md](../workspace/518-canvas-graph-deferral.md).

## Existing graph model that cannot be safely generalized

**`Connection` in [`packages/keiko-ui/src/app/components/desktop/windows/types.ts:22`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts) (the workspace `ConnectionsLayer` model) cannot be safely generalized into a `Relationship`.**

Reasons, with evidence:

1. **It is intentionally type-free and symmetric.** The record carries `{ id, a, b }` only. The renderer at [`ConnectionsLayer.tsx:79`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx) comments explicitly: "No `<marker>`: links are symmetric, not flows." Adding a `kind` field would force every existing renderer call site to disambiguate, would change the SVG path semantics (the symmetric bezier in `connectionUtils.ts` would need direction), and would propagate into `useWorkspace` selection/hit semantics.
2. **Its endpoints are `AppWindow.id` strings — opaque to the workspace and not stable across reloads in the same way memory/capsule ids are.** A `Connection` describes "window 7 and window 12 are visually linked on this canvas right now". The relationship engine needs durable identities; treating `AppWindow.id` as a relationship endpoint would couple durable relationship records to ephemeral workspace state.
3. **It belongs to the workspace substrate that ADR-0026 has already locked.** Expanding its shape would re-open the substrate decision and trigger the same deferral analysis that closed [#529](https://github.com/oscharko-dev/Keiko/issues/529). The substrate's whole point is that "windows" stay UI-only; cross-domain semantics live in dedicated contracts.
4. **It has no scope, no lifecycle, no provenance, no audit invariant, no validator.** Adding all four would change every consumer of `Connection`, including the `useWorkspace` state owner, in scope-creep that violates the epic non-goal.

The relationship engine must therefore **reference** workspace objects only through the registry's persistence expectations (`persistence: "memory-reference"`, `"evidence-reference"`, `"fs-reference"` per [ADR-0027 §"Cross-class references"](../adr/ADR-0027-workspace-state-ownership.md)), never by reusing the `Connection` record itself.

## Security and evidence invariants the relationship engine MUST preserve

These are enforceable constraints harvested from existing code/docs. They apply to issues #538–#542 implementation.

1. **All relationship API responses MUST flow through the audit redactor before persistence and before any string leaves the BFF.** Use `createAuditRedactor` and `deepRedactStrings` at [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts). Do not introduce a second redactor.
2. **Relationship audit records MUST NOT carry raw memory body, raw file content, raw evidence excerpt, or token-bearing strings.** The invariant is stated in [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts) and [`memory-operations.ts:288`](../../packages/keiko-contracts/src/memory-operations.ts) and must apply unchanged.
3. **Any UI surface that initiates a relationship change MUST go through ADR-0030's five rules.** The relationship inspector and any controlled graph view must declare their `trustBoundary` set on the registry descriptor; the validator from [ADR-0029 §2](../adr/ADR-0029-workspace-object-registry.md) refuses inconsistent declarations.
4. **A relationship referring to a memory MUST honour memory governance lifecycle.** Forgetting a memory tombstones it ([`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts), `ON DELETE CASCADE` in [schema.ts:71](../../packages/keiko-memory-vault/src/schema.ts)). Relationships whose endpoint is tombstoned must read as `availability: "unavailable"` and the API must not resurrect the memory body.
5. **A relationship referring to an evidence manifest MUST honour evidence retention.** Evidence retention defaults to `maxRuns: 50` ([`evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)). Relationships whose evidence endpoint has aged out must surface as unavailable; the API must not refetch the evidence content from any back-channel.
6. **A relationship referring to a file path MUST pass `assertContainedRealPath`.** The single chokepoint is [`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts). Workspace's discovery convention is "boundary → deny → realpath containment → size cap → read → redact" ([`discovery.ts:211`](../../packages/keiko-workspace/src/discovery.ts)); relationship endpoints that name a path are subject to the same gate. Always-on `DEFAULT_DENY_PATTERNS` from [`ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts) apply.
7. **The relationship engine MUST NOT bypass the model gateway.** No relationship creation, query, or impact-analysis path may originate a model call outside `@oscharko-dev/keiko-model-gateway`. [ADR-0030 rule 1](../adr/ADR-0030-workspace-security-evidence.md) is the canonical statement; `arch:check` rule 3a already promotes provider-SDK isolation to error.
8. **The relationship engine MUST NOT execute shell commands.** Any health-check or impact-analysis side effect that wants to run an external check must go through `keiko-tools` ([`terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts) + the existing allow-list). The terminal policy is not expanded by this epic.
9. **Relationship store schema evolution MUST follow the `PRAGMA user_version` migration pattern** established by `keiko-memory-vault` and recorded in the Epic #62 memory entry. No alternative migration tool is introduced.
10. **Relationship records persisted to UI durable state MUST NOT carry secret-shaped values.** [ADR-0030 rule 5](../adr/ADR-0030-workspace-security-evidence.md) names the second-barrier redactor at write time in the BFF UI persistence layer. The first barrier is the descriptor validator; the second is the persist-time redactor.
11. **Relationship existence MUST NOT be treated as authorization.** Issue #533's stop condition: "Stop if relationship existence is treated as sufficient authority to access models, tools, files, connectors, workflows, or evidence." Every consumer must re-check the endpoint owner's policy before acting.
12. **No new credential surface.** [ADR-0030 §"Credential handling"](../adr/ADR-0030-workspace-security-evidence.md) — credentials remain under `keiko-server` config and `keiko-memory-vault`; relationships never persist them.

## No new dependency is required

No new third-party dependency is required for the planned relationship foundation.

Every primitive the engine needs is present in the current `package.json` set:

| Need                            | Existing capability                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed first-class edge contract | `MemoryEdge`/`MemoryEdgeKind` shape in [`memory-records.ts:162`](../../packages/keiko-contracts/src/memory-records.ts) + `MEMORY_EDGE_KINDS`                                                                                        |
| Persistent edge storage         | `node:sqlite` + `--experimental-sqlite` (Node 22 built-in; ADR-0013 strategy)                                                                                                                                                       |
| Validator pattern               | `ValidationOk<T> \| ValidationFail` standardised in [`local-knowledge-validation.ts:29`](../../packages/keiko-contracts/src/local-knowledge-validation.ts)                                                                          |
| Closed-set type system          | `MemoryEdgeKind` / `MEMORY_EDGE_KINDS` ([`memory.ts:191`](../../packages/keiko-contracts/src/memory.ts))                                                                                                                            |
| Redaction                       | `keiko-security` `redact`, `createAuditRedactor`, `deepRedactStrings`                                                                                                                                                               |
| Audit-event envelope            | `BaseWorkflowEvent` shape in [`unit-test-events.ts:57`](../../packages/keiko-contracts/src/unit-test-events.ts); `MemoryAuditRecord` shape in [`memory-operations.ts:288`](../../packages/keiko-contracts/src/memory-operations.ts) |
| Evidence ledger envelope        | `EvidenceManifest` in [`evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts); atomic store at [`store.ts`](../../packages/keiko-evidence/src/store.ts)                                                                 |
| Retention                       | `DEFAULT_RETENTION` + retention pass at [`retention.ts`](../../packages/keiko-evidence/src/retention.ts)                                                                                                                            |
| Bounded impact-graph primitive  | `graphProximityScore` in [`graph.ts:22`](../../packages/keiko-memory-retrieval/src/graph.ts)                                                                                                                                        |
| Path containment                | `assertContainedRealPath` in [`realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)                                                                                                                                        |
| Policy decision shape           | `TerminalCommandDecision` in [`terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts)                                                                                                                          |
| Visualization substrate         | `ConnectionsLayer`, `connector-graph.tsx`, ADR-0026 substrate decision                                                                                                                                                              |
| UI extension contract           | `WindowsRegistry.ts` + `registerWindowRender`; ADR-0029 descriptor extension                                                                                                                                                        |
| SSE/WebSocket stream            | Existing `ws` library (ADR-0030 §"WebSocket usage")                                                                                                                                                                                 |
| Event envelope                  | `BaseWorkflowEvent` shape used by workflow events                                                                                                                                                                                   |
| BFF wire types                  | `keiko-contracts/src/bff-wire.ts`                                                                                                                                                                                                   |

The dependency lists in `packages/keiko-contracts/package.json`, `packages/keiko-memory-vault/package.json`, `packages/keiko-evidence/package.json`, `packages/keiko-security/package.json`, `packages/keiko-workspace/package.json`, `packages/keiko-tools/package.json`, `packages/keiko-model-gateway/package.json`, `packages/keiko-workflows/package.json`, `packages/keiko-ui/package.json`, and the root `package.json` are unchanged by the planned relationship-engine implementation.

## Cross-cutting risks inherited from existing patterns

1. **`node:sqlite` `--experimental-sqlite` flag must be applied at three sites** (CLI re-exec, vitest `execArgv`, no flag for `tsc`) — captured in the Epic #62 memory entry. New relationship-store callers inherit this constraint.
2. **macOS case-folding** breaks worktree paths when uppercase/lowercase project directories diverge ([Epic #270 memory entry](../adr/README.md)). Relationship paths must use the workspace `realpath` gate, which already normalises.
3. **`exactOptionalPropertyTypes`** + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` are repo-wide. New relationship contracts must apply the "absent vs. null" idiom seen in [`edges.ts:42`](../../packages/keiko-memory-vault/src/edges.ts) (`...(row.confidence !== null ? { confidence: row.confidence } : {})`).
4. **CodeQL `js/polynomial-redos` is a required gate.** Any new redaction or validation regex must follow the linear-character-class + single-quantifier rule documented in [`packages/keiko-security/src/redaction.ts:1`](../../packages/keiko-security/src/redaction.ts).
5. **ESM-only**; no CJS shims. Relationship contracts in `keiko-contracts` must follow the leaf-package rule from [`boundary.test.ts`](../../packages/keiko-contracts/src/boundary.test.ts) — no sibling `@oscharko-dev/keiko-*` imports.
6. **Dependency-cruiser and `eslint-plugin-keiko`** enforce direction rules ([ADR-0019](../adr/ADR-0019-modular-package-architecture.md) + [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md)). A new relationship package would have to land on the existing direction matrix. The recommended layout (contract in `keiko-contracts`, store in a leaf consumer, UI in `keiko-ui`) requires no new direction rule.
7. **Static-export UI** under Next.js — dynamic routes are query-param routes. Any relationship inspector route in the UI follows this convention (Epic #62 memory entry).
8. **SSE EventSource needs `addEventListener` per event name.** A relationship-activity stream must enumerate its event names in the BFF wire types so the UI subscribes per-kind, not by string concatenation (Epic #13 memory entry).

## Downstream issue briefs (constraint summary)

| Issue                                  | Constraint summary from this audit                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #534 — taxonomy                        | Closed `RelationshipKind` set + companion runtime-iterable array; compatibility matrix as a pure function returning `ValidationOk<T> \| ValidationFail`; lifecycle vocabulary aligned with [ADR-0029 LifecycleState](../adr/ADR-0029-workspace-object-registry.md).                                                    |
| #535 — policy/API/storage              | Storage schema modelled on `memory_edges` (STRICT, FK where in-store, FK-resolver port where cross-domain); policy result shape `TerminalCommandDecision`; `node:sqlite` + `--experimental-sqlite`; new ADR `ADR-0032 Relationship Storage` recommended.                                                               |
| #536 — audit/activity                  | Add an optional `relationships?` section to `EvidenceManifest`; bump `evidenceSchemaVersion`; reuse `BaseWorkflowEvent` envelope; body-free audit invariant from [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts); new ADR `ADR-0033 Relationship Audit/Activity` recommended. |
| #537 — UI blueprint                    | New `WindowType` entries (relationship inspector, controlled relationship graph); reuse ADR-0026 substrate; reuse `connector-graph.tsx` a11y patterns; new ADR `ADR-0034 Relationship UI Containment` recommended.                                                                                                     |
| #538 — contracts + validation engine   | Deterministic, single-pass validator; ReDoS-safe by construction; `ValidationOk<T> \| ValidationFail` result shape.                                                                                                                                                                                                    |
| #539 — APIs                            | BFF route family additive to existing routes; SSE event-name discipline; redaction at both write and response boundaries; no new credential surface.                                                                                                                                                                   |
| #540 — inspector + viz                 | New `WindowsRegistry` entries; ADR-0029 descriptor validator gates registration; ≥30×30 hit targets; focus rings; WCAG 2.2 AA.                                                                                                                                                                                         |
| #541 — privacy-preserving activity     | Body-free events; redaction at SSE-emit; activity vs. audit ledger separation; visible only what `MemoryAuditEventKind` would already permit at the same scope.                                                                                                                                                        |
| #542 — impact analysis + health checks | Bounded single-hop primitive modelled on `graphProximityScore`; explicit budget exhaustion; no shell execution outside `keiko-tools` terminal policy.                                                                                                                                                                  |

## References

- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532)
- Child: [#533](https://github.com/oscharko-dev/Keiko/issues/533)
- Companion deliverables: [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md)
- Prior art: [518-canvas-graph-deferral.md](../workspace/518-canvas-graph-deferral.md), [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md), [518-reference-analysis.md](../workspace/518-reference-analysis.md)
- Decision records: [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
- Privacy and security: [connected-context-privacy.md](../connected-context-privacy.md), [security-and-audit-boundaries.md](../security-and-audit-boundaries.md)
