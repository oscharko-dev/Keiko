# Epic #532 — Semantic Relationship Taxonomy

Status: Wave 2 deliverable for [issue #534](https://github.com/oscharko-dev/Keiko/issues/534) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532).

Issue date: 2026-06-06. Companion documents: [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md).

## 1. Purpose

This document specifies the durable semantic contract for the Keiko relationship engine: the canonical set of object kinds that may participate in a relationship, the canonical set of relationship types, their cardinality and direction, their lifecycle states and transitions, their compatibility constraints, and the invariants every type MUST preserve.

The taxonomy is the binding input for issues:

- [#535](https://github.com/oscharko-dev/Keiko/issues/535) — policy / validation / API / storage architecture (ADR-0031);
- [#536](https://github.com/oscharko-dev/Keiko/issues/536) — audit and activity model (ADR-0032);
- [#537](https://github.com/oscharko-dev/Keiko/issues/537) — UI blueprint (ADR-0033);
- [#538](https://github.com/oscharko-dev/Keiko/issues/538) — versioned contracts and deterministic validation engine.

The taxonomy is reuse-first: every relationship type is anchored to an existing Keiko subsystem that already models the same edge (cited as `file.ts:line`) or, where no such subsystem exists, to a `new-capability-gap` row enumerated in [gap-analysis.md](gap-analysis.md). The taxonomy does not introduce a new package, a new dependency, a new credential surface, or a new persistence backend.

## 2. Non-authority invariant

Relationships are **descriptive**, not **authoritative**.

The existence of a relationship between two entities MUST NOT be treated as authorization. Every consumer of a relationship MUST re-check the authority of the relevant policy boundary before acting on the relationship.

Authority decisions remain with the boundaries that already own them:

| Authority concern                   | Owning boundary                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Originating a model call            | `@oscharko-dev/keiko-model-gateway` ([ADR-0030 rule 1](../adr/ADR-0030-workspace-security-evidence.md)). `arch:check` rule 3a enforces provider-SDK isolation at error level.                                                                                                   |
| Executing a shell command           | `@oscharko-dev/keiko-tools` terminal policy ([`terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts)). The allow-list is not expanded by this epic.                                                                                                       |
| Applying a patch to a file          | `@oscharko-dev/keiko-tools` patch gate ([`packages/keiko-tools/src/patch.ts`](../../packages/keiko-tools/src/patch.ts)) plus the workspace path containment chokepoint ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)).          |
| Persisting evidence                 | `@oscharko-dev/keiko-evidence` redaction and atomic store ([`packages/keiko-evidence/src/build.ts`](../../packages/keiko-evidence/src/build.ts), [`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts)).                                         |
| Reading or writing a workspace file | `@oscharko-dev/keiko-workspace` `assertContainedRealPath` + `DEFAULT_DENY_PATTERNS` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts), [`packages/keiko-workspace/src/ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts)). |
| Mutating a memory record            | `@oscharko-dev/keiko-memory-governance` (`retention.ts`, `correction.ts`, `forget.ts`, `suppression.ts`, `status-ops.ts`, `conflict.ts`).                                                                                                                                       |
| Starting / mutating a workflow run  | `@oscharko-dev/keiko-workflows` (workflow descriptor + handoff).                                                                                                                                                                                                                |
| Connecting a UI window or capsule   | `@oscharko-dev/keiko-ui` workspace substrate ([ADR-0026](../adr/ADR-0026-workspace-substrate.md)) and connector graph validator ([`packages/keiko-contracts/src/local-knowledge-validation.ts:508`](../../packages/keiko-contracts/src/local-knowledge-validation.ts)).         |

A relationship that names an endpoint inside one of these boundaries inherits that boundary's authority rules. The relationship engine does not, must not, and is not designed to grant any of them. This re-states issue #533's stop condition and [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)'s five inviolable rules.

## 3. Versioning model

### 3.1 Schema-version field

Every relationship-engine contract (the relationship record, the activity event, the audit entry, the validation result, the impact report) carries `schemaVersion: "1"` as a string literal, matching the established Keiko convention in `MEMORY_AUDIT_EVENT_SCHEMA_VERSION` ([`memory-audit-events.ts:31`](../../packages/keiko-contracts/src/memory-audit-events.ts)) and `EvidenceManifest.evidenceSchemaVersion` ([`evidence.ts:277`](../../packages/keiko-contracts/src/evidence.ts)).

### 3.2 Additive-evolution rule

The taxonomy evolves additively:

- A new relationship type, object kind, lifecycle state, or denial-reason code is added by extending the closed set, never by repurposing an existing member.
- A breaking change (renaming, narrowing, or removing a member) introduces a new literal `schemaVersion` (e.g. `"2"`) and lands an ADR that supersedes ADR-0031. Readers of an older schema version receive a typed schema-mismatch error rather than silently coercing the new shape into the old shape. The same rule already applies to `EvidenceManifest` (see [adr-candidates.md](adr-candidates.md)).

### 3.3 Deprecation policy

A member is deprecated by ADR amendment, never by silent removal. A deprecated member is retained in the closed set for at least one schema-version cycle so consumers can migrate. Activity and audit emitters MUST stop emitting deprecated members at the schema-version bump; readers MUST continue to accept them until the next bump.

### 3.4 Forward / backward compatibility

- Forward: a `"1"` reader opening a `"2"` envelope rejects with a typed `SchemaError`. It does not attempt to coerce.
- Backward: a `"2"` reader opening a `"1"` envelope accepts and treats new optional sections as absent. New required fields are forbidden in an additive change; if a field must be required, a new schema version is the only path.

The audit ledger's redaction is idempotent ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)), so the versioned envelopes are safe to re-redact on a major bump.

## 4. Canonical object kinds

A relationship has exactly two endpoints. Each endpoint is one of the following kinds. The enumeration is the union of the existing Keiko id-bearing surfaces plus the smallest set of forward-looking kinds the epic needs to express. Each row anchors the kind to the existing subsystem that already owns the id and the authority for it.

The taxonomy uses the term **object kind** for the value of `RelationshipEndpoint.kind`. The relationship engine itself never owns the underlying id; it only references it. The polymorphic endpoint contract is enumerated in [gap-analysis.md Gap 1](gap-analysis.md).

| Object kind      | Status today    | Identity source                                                                                                                                                                                                                                                | Owning package                         | Trust boundary (per ADR-0029)        | Notes                                                                                                                                                                                                                                                  |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory`         | Exists today    | `MemoryId` ([`memory.ts:54`](../../packages/keiko-contracts/src/memory.ts))                                                                                                                                                                                    | `@oscharko-dev/keiko-memory-vault`     | `memory`                             | Liveness is the existing tombstone check ([`tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts)).                                                                                                                                     |
| `capsule`        | Exists today    | `KnowledgeCapsuleId` ([`local-knowledge-records.ts:30`](../../packages/keiko-contracts/src/local-knowledge-records.ts))                                                                                                                                        | `@oscharko-dev/keiko-local-knowledge`  | `evidence` (capsule lifecycle owns)  | Per `capsule-lifecycle.ts` / `source-lifecycle.ts`.                                                                                                                                                                                                    |
| `capsule-set`    | Exists today    | `CapsuleSetId` ([`bff-wire.ts:57`](../../packages/keiko-contracts/src/bff-wire.ts))                                                                                                                                                                            | `@oscharko-dev/keiko-local-knowledge`  | `evidence`                           | Composite of capsules.                                                                                                                                                                                                                                 |
| `workflow-run`   | Exists today    | `WorkflowRunId` ([`memory.ts:54`](../../packages/keiko-contracts/src/memory.ts), workflow-handoff)                                                                                                                                                             | `@oscharko-dev/keiko-workflows`        | `tool` + `model` (workflow composes) | Liveness via workflow ledger.                                                                                                                                                                                                                          |
| `evidence-run`   | Exists today    | `EvidenceManifestId` (re-exported in `keiko-contracts` from memory barrel; `EvidenceManifest` at [`evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts))                                                                                          | `@oscharko-dev/keiko-evidence`         | `evidence`                           | Retention defaults to `maxRuns: 50` ([`evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)). Retired runs surface as `availability: "unavailable"`.                                                                                      |
| `workspace-path` | Exists today    | Relative path string, resolved via `assertContainedRealPath`                                                                                                                                                                                                   | `@oscharko-dev/keiko-workspace`        | `fs`                                 | The string is a relative path; resolution happens at the engine boundary, not in the contract layer (per [gap-analysis.md Gap 1](gap-analysis.md)).                                                                                                    |
| `chat`           | Exists today    | `chat` window id from `WindowType` ([`WindowsRegistry.ts:5`](../../packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts)) plus BFF-persisted chat row ([`bff-wire.ts:77`](../../packages/keiko-contracts/src/bff-wire.ts) `ChatMessage`)    | `@oscharko-dev/keiko-ui` (BFF surface) | `ui`                                 | The relationship engine references the chat **id**; chat content remains in the BFF persistence layer (Epic #62).                                                                                                                                      |
| `tool`           | Exists today    | `ToolCallRequest` references at [`tools.ts:271`](../../packages/keiko-contracts/src/tools.ts); registry in [`packages/keiko-tools/src/registry.ts`](../../packages/keiko-tools/src/registry.ts)                                                                | `@oscharko-dev/keiko-tools`            | `tool`                               | A tool endpoint identifies a registry entry, not a tool **call**. Per-call edges are modelled via the `workflow-run` endpoint that originated the call.                                                                                                |
| `patch-proposal` | Exists today    | `PatchProposedEvent` / `PatchAppliedEvent` ([`harness.ts:279`](../../packages/keiko-contracts/src/harness.ts), [`harness.ts:294`](../../packages/keiko-contracts/src/harness.ts))                                                                              | `@oscharko-dev/keiko-tools`            | `fs`                                 | The relationship references the patch-proposal event id (the harness event envelope already carries it).                                                                                                                                               |
| `agent`          | Forward-looking | Reserved for the agent registry; no first-class `AgentId` exists in `keiko-contracts` today (the existing `agents` window type [`WindowsRegistry.ts:10`](../../packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts) is UI-only).           | (not yet owned)                        | `model`                              | Tagged as **forward-looking**; consumers MAY use this kind only when the future agent registry lands. Until then the relationship validator rejects `agent` endpoints. Tracked under `new-capability-gap` in [gap-analysis.md Gap 1](gap-analysis.md). |
| `connector`      | Forward-looking | Connector node ids exist in the UI graph (`ConnectorNode` / `ConnectorEdge` at [`local-knowledge.ts:204`](../../packages/keiko-contracts/src/local-knowledge.ts)) but only for the closed kind set `files-window` / `local-knowledge` / `conversation-center`. | `@oscharko-dev/keiko-local-knowledge`  | `evidence` + `ui`                    | The taxonomy reserves the kind for future connectors beyond the closed UI set; the engine accepts only `kind: "capsule"` / `"capsule-set"` until then.                                                                                                 |
| `data-source`    | Forward-looking | No id surface today (data sources are modelled per-capsule via `KnowledgeSourceId` in [`local-knowledge-records.ts`](../../packages/keiko-contracts/src/local-knowledge-records.ts)).                                                                          | (not yet owned)                        | `evidence`                           | Reserved for future explicit data-source records.                                                                                                                                                                                                      |
| `skill`          | Forward-looking | No id surface today. The existing `plugins` window type is UI metadata only.                                                                                                                                                                                   | (not yet owned)                        | `tool` + `model`                     | Reserved for the future skill registry. The validator rejects until landed.                                                                                                                                                                            |
| `mcp-tool`       | Forward-looking | No id surface today. MCP tools are referenced via the workflow descriptor and the harness `ToolCallRequest`.                                                                                                                                                   | (not yet owned)                        | `tool`                               | Reserved for first-class MCP tool ids. Until then `tool` covers the in-tree allow-list and the workflow-descriptor surface.                                                                                                                            |

### 4.1 Closed enumeration

```
type RelationshipEndpointKind =
  | "memory"
  | "capsule"
  | "capsule-set"
  | "workflow-run"
  | "evidence-run"
  | "workspace-path"
  | "chat"
  | "tool"
  | "patch-proposal"
  | "agent"           // forward-looking; validator rejects until landed
  | "connector"       // forward-looking; validator rejects until landed
  | "data-source"     // forward-looking; validator rejects until landed
  | "skill"           // forward-looking; validator rejects until landed
  | "mcp-tool";       // forward-looking; validator rejects until landed
```

The companion runtime-iterable array `RELATIONSHIP_ENDPOINT_KINDS` mirrors the closed convention from `MEMORY_EDGE_KINDS` ([`memory.ts:199`](../../packages/keiko-contracts/src/memory.ts)).

### 4.2 Forward-looking kinds

A forward-looking kind is **enumerated** so the schema is stable across the epic, but **rejected** by the validator with `denied/object-kind-not-yet-supported` until the owning registry lands. This avoids a schema version bump when the registry finally arrives.

## 5. Canonical relationship types

Each relationship type below is documented to the level of precision required for two engineers to write identical TypeScript types from the description.

For every type the contract carries:

- `payload-content rule`: **relationship metadata only; sensitive payloads are not permitted**. Audit invariant from [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts) applies.
- `authority`: **none (validation remains with the owning boundary listed below)**. Re-states §2.

### 5.1 `reads-context`

| Field                 | Value                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `reads-context`                                                                                                                                                                                                                                            |
| Display name          | "reads context"                                                                                                                                                                                                                                            |
| Semantics             | A consumer endpoint **reads** the contextual content represented by the target endpoint at a specific point in time. The relationship records that the read happened; it does not embed what was read.                                                     |
| Valid source kinds    | `workflow-run`, `chat`                                                                                                                                                                                                                                     |
| Valid target kinds    | `memory`, `capsule`, `capsule-set`, `evidence-run`, `workspace-path`, `connector` (forward-looking), `data-source` (forward-looking)                                                                                                                       |
| Cardinality           | N:N (one workflow run reads many context items; one item is read by many runs).                                                                                                                                                                            |
| Direction             | Directed (source `reads` target).                                                                                                                                                                                                                          |
| Lifecycle             | Creatable, immutable after `accepted`, archivable, retractable.                                                                                                                                                                                            |
| Audit expectation     | One `relationship:proposed` then `relationship:accepted` event per creation. Audit record names source/target ids and short rationale `summary`. No raw context content.                                                                                   |
| Evidence relevance    | The owning `workflow-run`'s `EvidenceManifest` records the read via the existing `connected-context-evidence.ts` section ([`packages/keiko-evidence/src/connected-context-evidence.ts`](../../packages/keiko-evidence/src/connected-context-evidence.ts)). |
| Owner package         | Source: `@oscharko-dev/keiko-workflows`. Target: per-endpoint owner. Engine: contract additions in `@oscharko-dev/keiko-contracts`.                                                                                                                        |
| Trust boundary        | Source trust boundary applies to the source endpoint; target trust boundary applies to the target endpoint. The relationship itself crosses neither.                                                                                                       |
| Payload-content rule  | Relationship metadata only; sensitive payloads are not permitted.                                                                                                                                                                                          |
| Existing-Keiko anchor | `EvidenceConnectedContextAudit` at [`evidence.ts:249`](../../packages/keiko-contracts/src/evidence.ts); `MemoryAuditEventKind` `memory:retrieved` at [`memory-audit-events.ts:50`](../../packages/keiko-contracts/src/memory-audit-events.ts).             |
| Denial reasons        | `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/cross-workspace`, `denied/non-existent-source`, `denied/non-existent-target`, `denied/payload-content-not-permitted`.                                                          |

### 5.2 `proposes-patch`

| Field                 | Value                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | `proposes-patch`                                                                                                                                                                                                                                                         |
| Display name          | "proposes patch"                                                                                                                                                                                                                                                         |
| Semantics             | A workflow run proposes a patch targeting one or more workspace paths. The relationship records the proposal; the proposal content remains in the harness `PatchProposedEvent` envelope.                                                                                 |
| Valid source kinds    | `workflow-run`                                                                                                                                                                                                                                                           |
| Valid target kinds    | `workspace-path`, `patch-proposal`                                                                                                                                                                                                                                       |
| Cardinality           | 1:N (one run proposes one or more patches across one or more paths).                                                                                                                                                                                                     |
| Direction             | Directed (source `proposes` target).                                                                                                                                                                                                                                     |
| Lifecycle             | Creatable; immutable after `accepted`; transitions to `archived` on apply or to `revoked` on reject; never `reconnectable`.                                                                                                                                              |
| Audit expectation     | One `relationship:proposed` event. On apply or reject, the existing harness `PatchAppliedEvent` / harness rejection event carries the resolution; the relationship engine emits `relationship:archived` (apply) or `relationship:rejected` (reject).                     |
| Evidence relevance    | Carried by `EvidenceManifest.patch` ([`evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts) section list). No new evidence section required.                                                                                                                |
| Owner package         | Source: `@oscharko-dev/keiko-workflows`. Target: `@oscharko-dev/keiko-tools` for `patch-proposal`; `@oscharko-dev/keiko-workspace` for `workspace-path`. Engine: contract additions in `@oscharko-dev/keiko-contracts`.                                                  |
| Trust boundary        | The relationship inherits `fs` trust at the target; apply itself crosses the `keiko-tools` patch gate, which the relationship does not bypass.                                                                                                                           |
| Payload-content rule  | Relationship metadata only; sensitive payloads are not permitted.                                                                                                                                                                                                        |
| Existing-Keiko anchor | `PatchProposedEvent` at [`harness.ts:294`](../../packages/keiko-contracts/src/harness.ts); `PatchAppliedEvent` at [`harness.ts:279`](../../packages/keiko-contracts/src/harness.ts); `PatchFileChange` at [`tools.ts:178`](../../packages/keiko-contracts/src/tools.ts). |
| Denial reasons        | `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/cross-workspace`, `denied/path-not-contained`, `denied/non-existent-source`, `denied/non-existent-target`, `denied/payload-content-not-permitted`.                                           |

### 5.3 `uses-tool`

| Field                 | Value                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `uses-tool`                                                                                                                                                                                                          |
| Display name          | "uses tool"                                                                                                                                                                                                          |
| Semantics             | A workflow run uses a registered tool. The relationship records that the tool was invoked from that run; per-call arguments and results remain in the harness `ToolCallRequest` / `ToolCallResult` envelopes.        |
| Valid source kinds    | `workflow-run`                                                                                                                                                                                                       |
| Valid target kinds    | `tool`, `mcp-tool` (forward-looking)                                                                                                                                                                                 |
| Cardinality           | N:N (a run uses many tools; a tool is used by many runs).                                                                                                                                                            |
| Direction             | Directed (source `uses` target).                                                                                                                                                                                     |
| Lifecycle             | Creatable; immutable after `accepted`; archivable.                                                                                                                                                                   |
| Audit expectation     | One `relationship:accepted` event per first-time usage in a run. Subsequent uses within the same run are de-duplicated; the existing harness `command:executed` / `tool:executed` events remain the per-call ledger. |
| Evidence relevance    | Carried by the run's `EvidenceManifest.toolCalls` / `commandExecutions` sections; the relationship adds no new evidence content.                                                                                     |
| Owner package         | Source: `@oscharko-dev/keiko-workflows`. Target: `@oscharko-dev/keiko-tools`. Engine: contract additions in `@oscharko-dev/keiko-contracts`.                                                                         |
| Trust boundary        | The relationship inherits `tool` trust at the target; tool invocation itself crosses the `keiko-tools` terminal policy, which the relationship does not bypass.                                                      |
| Payload-content rule  | Relationship metadata only; sensitive payloads are not permitted.                                                                                                                                                    |
| Existing-Keiko anchor | `ToolCallRequest` at [`tools.ts:271`](../../packages/keiko-contracts/src/tools.ts); `ToolCallResult` at [`tools.ts:305`](../../packages/keiko-contracts/src/tools.ts).                                               |
| Denial reasons        | `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/object-kind-not-yet-supported` (for `mcp-tool`), `denied/cross-workspace`, `denied/payload-content-not-permitted`.                       |

### 5.4 `starts-workflow`

| Field                 | Value                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `starts-workflow`                                                                                                                                                                                                                                                                                                             |
| Display name          | "starts workflow"                                                                                                                                                                                                                                                                                                             |
| Semantics             | A chat (or a parent workflow run) initiates a workflow run. The relationship records the origin; the run identity belongs to the workflow ledger.                                                                                                                                                                             |
| Valid source kinds    | `chat`, `workflow-run`                                                                                                                                                                                                                                                                                                        |
| Valid target kinds    | `workflow-run`                                                                                                                                                                                                                                                                                                                |
| Cardinality           | 1:N from the source side (one chat starts many runs over time); 1:1 from the target side (each run has exactly one origin).                                                                                                                                                                                                   |
| Direction             | Directed (source `starts` target).                                                                                                                                                                                                                                                                                            |
| Lifecycle             | Creatable; immutable for the lifetime of the run; archivable when the run completes.                                                                                                                                                                                                                                          |
| Audit expectation     | One `relationship:accepted` event at run start. No mid-run mutation; cancellation is a workflow-ledger event, not a relationship-engine concern.                                                                                                                                                                              |
| Evidence relevance    | Carried by the run's `EvidenceManifest.runId` and `EvidenceManifest.workflow*` fields ([`evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts)). The relationship adds no new evidence content.                                                                                                                   |
| Owner package         | Source: `@oscharko-dev/keiko-ui` BFF (chat surface) or `@oscharko-dev/keiko-workflows` (run-spawn-run). Target: `@oscharko-dev/keiko-workflows`. Engine: contract additions in `@oscharko-dev/keiko-contracts`.                                                                                                               |
| Trust boundary        | The relationship inherits the source's trust boundary at the source and the workflow's trust boundary at the target. The engine never originates a run.                                                                                                                                                                       |
| Payload-content rule  | Relationship metadata only; sensitive payloads are not permitted.                                                                                                                                                                                                                                                             |
| Existing-Keiko anchor | `WorkflowRunId` at [`memory.ts:54`](../../packages/keiko-contracts/src/memory.ts); workflow-handoff envelope in [`packages/keiko-contracts/src/workflow-handoff.ts`](../../packages/keiko-contracts/src/workflow-handoff.ts); `EvidenceManifest.runId` ([`evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts)). |
| Denial reasons        | `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/cardinality-exceeded` (target side; a run has exactly one origin), `denied/cross-workspace`, `denied/payload-content-not-permitted`.                                                                                                              |

### 5.5 `produces-evidence`

| Field                 | Value                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `produces-evidence`                                                                                                                                                                                                                                                                                   |
| Display name          | "produces evidence"                                                                                                                                                                                                                                                                                   |
| Semantics             | A workflow run produces a durable evidence-run record. The relationship records the lineage from the workflow run to the evidence manifest it wrote.                                                                                                                                                  |
| Valid source kinds    | `workflow-run`                                                                                                                                                                                                                                                                                        |
| Valid target kinds    | `evidence-run`                                                                                                                                                                                                                                                                                        |
| Cardinality           | 1:1 (each workflow run produces exactly one evidence run; if a run produces no evidence, no relationship is recorded).                                                                                                                                                                                |
| Direction             | Directed (source `produces` target).                                                                                                                                                                                                                                                                  |
| Lifecycle             | Creatable; immutable; archivable when the evidence run is retired by retention.                                                                                                                                                                                                                       |
| Audit expectation     | One `relationship:accepted` event at evidence-run persist time. When evidence retention retires the run, the relationship transitions to `stale` (engine-side); the evidence ledger itself does not change.                                                                                           |
| Evidence relevance    | Carried by the evidence record's existence. The relationship is a join-key recorded in the relationship store; the evidence ledger is canonical.                                                                                                                                                      |
| Owner package         | Source: `@oscharko-dev/keiko-workflows`. Target: `@oscharko-dev/keiko-evidence`. Engine: contract additions in `@oscharko-dev/keiko-contracts`.                                                                                                                                                       |
| Trust boundary        | `evidence` at the target. The relationship does not bypass evidence retention or redaction.                                                                                                                                                                                                           |
| Payload-content rule  | Relationship metadata only; sensitive payloads are not permitted.                                                                                                                                                                                                                                     |
| Existing-Keiko anchor | `EvidenceManifest` at [`evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts); `EvidenceStore` port at [`evidence.ts:355`](../../packages/keiko-contracts/src/evidence.ts); persistence flow in [`packages/keiko-evidence/src/persist.ts`](../../packages/keiko-evidence/src/persist.ts). |
| Denial reasons        | `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/cardinality-exceeded`, `denied/cross-workspace`, `denied/payload-content-not-permitted`.                                                                                                                                  |

### 5.6 `references-document`

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | `references-document`                                                                                                                                                                                                                                                                                                                                                          |
| Display name          | "references document"                                                                                                                                                                                                                                                                                                                                                          |
| Semantics             | A chat or a workflow run references a document (workspace file or local-knowledge capsule). Distinct from `reads-context`: a reference is a **structural pointer** (e.g. "this chat is grounded in this file"); a `reads-context` is a **read event**.                                                                                                                         |
| Valid source kinds    | `chat`, `workflow-run`                                                                                                                                                                                                                                                                                                                                                         |
| Valid target kinds    | `workspace-path`, `capsule`, `capsule-set`                                                                                                                                                                                                                                                                                                                                     |
| Cardinality           | N:N.                                                                                                                                                                                                                                                                                                                                                                           |
| Direction             | Directed (source `references` target).                                                                                                                                                                                                                                                                                                                                         |
| Lifecycle             | Creatable; reconnectable when a document is renamed or replaced; archivable; retractable.                                                                                                                                                                                                                                                                                      |
| Audit expectation     | `relationship:proposed` then `relationship:accepted`. A reconnection (rename/replace) emits `relationship:superseded`.                                                                                                                                                                                                                                                         |
| Evidence relevance    | Surfaces in the run's `EvidenceManifest.connectedContext` section when the run also reads the document; otherwise the relationship is structural only and carries no evidence content.                                                                                                                                                                                         |
| Owner package         | Source: `@oscharko-dev/keiko-ui` (chat) or `@oscharko-dev/keiko-workflows` (run). Target: `@oscharko-dev/keiko-workspace` (path) or `@oscharko-dev/keiko-local-knowledge` (capsule). Engine: contract additions in `@oscharko-dev/keiko-contracts`.                                                                                                                            |
| Trust boundary        | `fs` for `workspace-path` targets; `evidence` for capsule targets.                                                                                                                                                                                                                                                                                                             |
| Payload-content rule  | Relationship metadata only; sensitive payloads are not permitted.                                                                                                                                                                                                                                                                                                              |
| Existing-Keiko anchor | `ConnectorEdge` / `ConnectorNode` at [`local-knowledge.ts:204`](../../packages/keiko-contracts/src/local-knowledge.ts); workspace `Connection` at [`windows/types.ts:22`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts) (workspace-level only); `EvidenceConnectedContextAudit` at [`evidence.ts:249`](../../packages/keiko-contracts/src/evidence.ts). |
| Denial reasons        | `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/cross-workspace`, `denied/path-not-contained`, `denied/non-existent-target`, `denied/payload-content-not-permitted`.                                                                                                                                                                               |

### 5.7 `depends-on`

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | `depends-on`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Display name          | "depends on"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Semantics             | A capsule, capsule-set, workflow run, or memory **depends on** another. Used by impact analysis (#542) to compute "if X changes / is retracted, what else changes?".                                                                                                                                                                                                                                                                                                                                                                                                     |
| Valid source kinds    | `capsule`, `capsule-set`, `workflow-run`, `memory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Valid target kinds    | `capsule`, `capsule-set`, `workflow-run`, `memory`, `evidence-run`, `workspace-path`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cardinality           | N:N.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Direction             | Directed (source `depends on` target).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Lifecycle             | Creatable; reconnectable when the target is reorganised; archivable; retractable. **Self-loop forbidden**; **cycles between two `depends-on` edges forbidden** at validation time (`denied/cycle-forbidden`).                                                                                                                                                                                                                                                                                                                                                            |
| Audit expectation     | `relationship:proposed` then `relationship:accepted`. Cycle detection runs at validation time, not as a separate event.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Evidence relevance    | Dependencies are visible to the impact analysis primitive in [gap-analysis.md Gap 8](gap-analysis.md). Single-hop traversal; the engine does not chase transitive closure at query time.                                                                                                                                                                                                                                                                                                                                                                                 |
| Owner package         | Engine: contract additions in `@oscharko-dev/keiko-contracts`. Per-endpoint owners as listed in §4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Trust boundary        | Inherits per-endpoint trust boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Payload-content rule  | Relationship metadata only; sensitive payloads are not permitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Existing-Keiko anchor | `MemoryEdgeKind "derived-from"` and `"supersedes"` at [`memory.ts:191`](../../packages/keiko-contracts/src/memory.ts); `importGraph` at [`packages/keiko-workspace/src/importGraph.ts`](../../packages/keiko-workspace/src/importGraph.ts); `graphProximityScore` at [`packages/keiko-memory-retrieval/src/graph.ts:22`](../../packages/keiko-memory-retrieval/src/graph.ts). The `depends-on` semantic is a **new-capability-gap** at the cross-domain level (no single existing edge carries cross-domain "depends-on"); see [gap-analysis.md Gap 4](gap-analysis.md). |
| Denial reasons        | `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/cross-workspace`, `denied/cycle-forbidden`, `denied/non-existent-source`, `denied/non-existent-target`, `denied/payload-content-not-permitted`.                                                                                                                                                                                                                                                                                                                                              |

### 5.8 Summary table of type ids

```
type RelationshipType =
  | "reads-context"
  | "proposes-patch"
  | "uses-tool"
  | "starts-workflow"
  | "produces-evidence"
  | "references-document"
  | "depends-on";

const RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  "reads-context",
  "proposes-patch",
  "uses-tool",
  "starts-workflow",
  "produces-evidence",
  "references-document",
  "depends-on",
] as const;
```

The companion `RELATIONSHIP_TYPES` array mirrors `MEMORY_EDGE_KINDS` ([`memory.ts:199`](../../packages/keiko-contracts/src/memory.ts)).

### 5.9 New-capability-gap mapping

The following relationship types are flagged as `new-capability-gap` because no single existing Keiko subsystem already models the same cross-domain edge:

| Relationship type     | Gap-analysis row                                                                                       | Why                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `depends-on`          | [Gap 1](gap-analysis.md), [Gap 4](gap-analysis.md), [Gap 5](gap-analysis.md), [Gap 8](gap-analysis.md) | Existing edges express within-domain dependencies (`MemoryEdgeKind "derived-from"` for memory-to-memory, `importGraph` for file-to-file). A cross-domain "X depends on Y" is the leaf-engine concern that ADR-0031 records.                   |
| `references-document` | [Gap 1](gap-analysis.md), [Gap 4](gap-analysis.md)                                                     | `ConnectorEdge` covers UI surface adjacency only; workspace `Connection` is type-free and substrate-locked (ADR-0026). A typed `references` edge from chat or workflow-run to a document needs the cross-domain endpoint contract from Gap 1. |

The other five types (`reads-context`, `proposes-patch`, `uses-tool`, `starts-workflow`, `produces-evidence`) name **structural views** over edges that already exist in evidence sections (`connectedContext`, `patch`, `toolCalls`, the run-id pivot, and the manifest itself respectively). The relationship store reifies them at the cross-domain layer so a single query surface can answer "show me everything this run touched" without dipping into each evidence section.

## 6. Lifecycle state machine

The formal table and rules live in [lifecycle.md](lifecycle.md). The states and the highest-level invariants are restated here.

### 6.1 Closed lifecycle state set

```
type RelationshipLifecycle =
  | "draft"
  | "active"
  | "archived"
  | "superseded"
  | "revoked"
  | "blocked"
  | "stale";

const RELATIONSHIP_LIFECYCLES: readonly RelationshipLifecycle[] = [
  "draft",
  "active",
  "archived",
  "superseded",
  "revoked",
  "blocked",
  "stale",
] as const;
```

| State        | Meaning                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`      | Proposed but not yet committed. Validator has not yet run, or is awaiting a downstream gate.                                           |
| `active`     | Committed and currently valid. Both endpoints are live.                                                                                |
| `archived`   | The relationship is preserved for audit but no longer participates in queries by default. Triggered by an explicit operator action.    |
| `superseded` | Replaced by a newer relationship (e.g. on a document rename, the old `references-document` is `superseded` by the new one).            |
| `revoked`    | Rejected after proposal, or retracted after acceptance. Audit-visible; query-invisible by default.                                     |
| `blocked`    | The relationship cannot transition to `active` because the validator (or the endpoint resolver) returned a `denied/*` reason.          |
| `stale`      | Engine-side derived state: at least one endpoint is `tombstoned`, `retired`, or `unavailable`. The relationship row remains for audit. |

### 6.2 Server-authoritative transitions

Every transition is server-authoritative. The UI proposes a transition; the relationship engine evaluates the policy decision (per [gap-analysis.md Gap 3](gap-analysis.md)) and either commits the transition (emitting the corresponding `relationship:*` activity event) or returns a `RelationshipPolicyDecision` with the denial reasons. The client MUST treat any optimistic UI state as advisory until the server's accept is observed.

### 6.3 No payload mutation

Lifecycle transitions never carry payload content. The transition envelope carries:

- `relationshipId`
- `from` lifecycle state
- `to` lifecycle state
- `occurredAt` timestamp (epoch ms)
- optional bounded `summary` string (≤240 chars, per `MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS` at [`memory-audit-events.ts:35`](../../packages/keiko-contracts/src/memory-audit-events.ts))

No endpoint content, no payload diff, no token-bearing string.

## 7. Cardinality rules

| Relationship type     | Cardinality                                                                                    | Enforcement                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reads-context`       | N:N                                                                                            | No cap. Per-run de-duplication: at most one `relationship:accepted` event per (run, target) pair.                                                                                    |
| `proposes-patch`      | 1:N from source, N:1 from target path (one path may have many proposals)                       | A workflow run may propose multiple patches; each `patch-proposal` target is unique by harness event id.                                                                             |
| `uses-tool`           | N:N                                                                                            | Per-run de-duplication: at most one `relationship:accepted` per (run, tool) pair.                                                                                                    |
| `starts-workflow`     | 1:N from source (one chat starts many runs); 1:1 from target (each run has exactly one origin) | Validator rejects a second `starts-workflow` whose target is an already-claimed `workflow-run` with `denied/cardinality-exceeded`.                                                   |
| `produces-evidence`   | 1:1                                                                                            | Validator rejects a second `produces-evidence` for the same source workflow-run with `denied/cardinality-exceeded`.                                                                  |
| `references-document` | N:N                                                                                            | No cap. Reconnection on rename emits `relationship:superseded` (per §5.6).                                                                                                           |
| `depends-on`          | N:N, but the engine forbids self-loops and direct two-edge cycles                              | Validator rejects with `denied/cycle-forbidden` if `(source, target)` reverses an existing `depends-on`. Transitive cycle detection is deferred to #542's impact-analysis traversal. |

## 8. Compatibility matrix

The full 2-D source-kind × target-kind matrix with the relationship type ids in each cell (and explicit `denied/*` markers for forbidden cells) is in [compatibility-matrix.md](compatibility-matrix.md). This taxonomy is the source of truth for the cell values; the matrix file presents them in tabular form for downstream validators.

The most important explicit denials:

- **`chat` → `chat`**: `denied/source-kind-not-allowed` (and `denied/target-kind-not-allowed`). A chat does not relate to another chat in the relationship engine; cross-chat coupling, if needed, goes through a shared `workflow-run` or a shared `capsule`.
- **`document` (workspace-path / capsule) → `document`**: `denied/source-kind-not-allowed`. Document-to-document relationships exist today inside `importGraph` (FS-level) and inside connector graphs (UI-level); the cross-domain relationship engine does not duplicate those.
- **`agent` → `evidence-run`** (when the `agent` kind lands): `denied/kind-incompatible`. Evidence is produced by runs, not by agents. The lineage is agent → run → evidence, not agent → evidence directly.
- **`evidence-run` → `tool`**: `denied/source-kind-not-allowed`. Evidence runs are leaf artefacts; they do not initiate tool usage in reverse.

## 9. Scope boundary

A relationship is scoped to exactly one workspace or project. Cross-workspace edges are **forbidden by construction**.

The scope follows the existing `MemoryScope` discriminated union ([`memory.ts:72`](../../packages/keiko-contracts/src/memory.ts)):

```
type MemoryScope =
  | { readonly kind: "user"; readonly userId: UserId }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "workflow"; readonly workflowDefinitionId: WorkflowDefinitionId }
  | { readonly kind: "global" };
```

The relationship record carries a `scope: MemoryScope` field. The validator rejects with `denied/cross-workspace` whenever the source and target endpoints resolve to different scopes that are not the same (workspace, project) instance or one of `{global, user}`. Workspace containment for path endpoints is enforced via `assertContainedRealPath` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)), restating the [audit.md §"Security and evidence invariants"](audit.md) rule 6.

## 10. Schema-versioning and migration expectations

1. **Additive evolution** is the default. New types, new object kinds, new lifecycle states, and new denial-reason codes extend the closed sets. The `schemaVersion: "1"` literal does not change.
2. **Breaking evolution** (renaming, narrowing, removing a member) requires a new `schemaVersion` literal (e.g. `"2"`) AND an ADR amending or superseding ADR-0031. Readers of the old version reject the new envelope with `SchemaError`, mirroring the audit-store typed read errors in [`packages/keiko-evidence/src/index-api.ts`](../../packages/keiko-evidence/src/index-api.ts) (Issue #10 memory entry).
3. **Forward-looking object kinds** (§4.2) are enumerated in `schemaVersion: "1"` so the schema is stable when they land. The validator rejects until the owning registry lands, gated on `denied/object-kind-not-yet-supported`.
4. **Persistence migration** follows the `PRAGMA user_version` pattern from `keiko-memory-vault` ([`schema.ts`](../../packages/keiko-memory-vault/src/schema.ts)), restated in [gap-analysis.md Gap 5](gap-analysis.md). The relationship store records its own user_version; the storage ADR is ADR-0031.
5. **Backwards-compatibility** for activity events: an old subscriber that does not recognise a new `relationship:*` kind name discards the event without raising; a new subscriber that receives an old-schema envelope upgrades the missing fields to absent. The SSE event-name discipline (per-kind `addEventListener`) means an unknown kind is structurally never delivered to an old subscriber — restated from the [Epic #13 memory entry](../workspace/518-canvas-graph-deferral.md) and [audit.md §"Cross-cutting risks"](audit.md).

## 11. Non-authority invariant restatement

Restated from §2 so this section is self-contained for #535 / #536 / #537 / #538 implementers.

- A relationship MUST NOT, by itself, authorise a model call, a tool call, a patch apply, an evidence read, a memory mutation, a workspace read, a workflow start, or a UI escalation.
- Every authority check happens at the owning boundary, listed in §2.
- The relationship engine is a **read substrate** and a **mutation gate over its own records only**. Cross-domain authority is composed via the endpoint-resolver port from [gap-analysis.md Gap 2](gap-analysis.md); the resolver returns liveness only, never authority.

## 12. No-payload invariant

A relationship record (in the store, on the wire, in an activity event, or in an audit entry) MAY carry:

- `id` (RelationshipId)
- `schemaVersion` (string literal)
- `type` / `kind` (closed-string from §5.8)
- `source` (RelationshipEndpoint, opaque)
- `target` (RelationshipEndpoint, opaque)
- `scope` (MemoryScope from §9)
- `lifecycle` (closed-string from §6.1)
- `createdAt` / `updatedAt` (epoch ms numbers)
- optional `confidence` (number in `[0, 1]`)
- optional bounded `summary` (≤ `MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS` chars; redacted by `createAuditRedactor` at persist / emit boundary)
- optional `initiatorSurface` and `initiatorReviewerId` on audit entries (reused from `MemoryAuditInitiatorSurface`)

A relationship record MUST NOT carry:

- Prompts or model messages (covered by `keiko-model-gateway` and the run's evidence)
- Document content or excerpts (workspace files, capsule excerpts; covered by `connected-context-evidence`)
- Tool stdout, stderr, or argument values (covered by `EvidenceManifest.toolCalls` / `commandExecutions`)
- Patch hunks or diff bytes (covered by `EvidenceManifest.patch`)
- Secrets, credentials, API keys, or any token-bearing string (covered by `keiko-security` redactor)
- Endpoint identity payloads other than the opaque id (e.g. memory body, capsule body, evidence excerpt)
- File paths outside the relative form covered by `assertContainedRealPath`
- Free-form JSON blobs

The invariant is enforced by `createAuditRedactor` + `deepRedactStrings` at the persist / emit boundary ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)). It mirrors the existing audit invariant at [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts) and [`memory-operations.ts:288`](../../packages/keiko-contracts/src/memory-operations.ts).

## 13. References

- [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md)
- [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md)
- [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
- [connected-context-privacy.md](../connected-context-privacy.md), [security-and-audit-boundaries.md](../security-and-audit-boundaries.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#534](https://github.com/oscharko-dev/Keiko/issues/534).
