# Epic #532 — Relationship Evidence-Reference Contract

Status: Wave 3 deliverable for [issue #536](https://github.com/oscharko-dev/Keiko/issues/536) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [audit-events.md](audit-events.md), [activity-state.md](activity-state.md), [retention-and-privacy.md](retention-and-privacy.md), [audit-activity-checklist.md](audit-activity-checklist.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md).

Date: 2026-06-06.

## 1. Purpose

The relationship engine MUST be able to point at evidence artifacts (workflow runs, verification results, patches, command executions, browser captures, connected-context audits) without duplicating the evidence content. This document specifies the `RelationshipEvidenceRef` type, the rules that govern its creation and deletion, the workspace-scope invariant, the read API obligation, and the tombstoning rule when a relationship is deleted while still referenced by an evidence manifest.

The contract binds issues [#538](https://github.com/oscharko-dev/Keiko/issues/538), [#539](https://github.com/oscharko-dev/Keiko/issues/539), [#542](https://github.com/oscharko-dev/Keiko/issues/542), [#543](https://github.com/oscharko-dev/Keiko/issues/543), and is recorded normatively in [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md).

No new database, no new package, no new third-party dependency.

## 2. The `RelationshipEvidenceRef` type

```ts
export type RelationshipEvidenceRefKind = "attests" | "produces" | "depends-on-input";

export interface RelationshipEvidenceRef {
  readonly evidenceRunId: string; // the EvidenceRunIdentity.runId
  readonly manifestPath: string; // location string returned by EvidenceStore.put
  readonly manifestSchemaVersion: "1"; // matches EvidenceManifest.evidenceSchemaVersion
  readonly kind: RelationshipEvidenceRefKind;
}
```

### 2.1 Field semantics

- **`evidenceRunId`** matches `EvidenceRunIdentity.runId` ([`packages/keiko-contracts/src/evidence.ts:24`](../../packages/keiko-contracts/src/evidence.ts)). It is the canonical join key against the evidence store.
- **`manifestPath`** is the location string returned by `EvidenceStore.put` (the `location` field on `PersistResult` at [`packages/keiko-evidence/src/persist.ts:30`](../../packages/keiko-evidence/src/persist.ts)). For the default Node store, this is the absolute path to `<dir>/<runId>.json`; for an injected in-memory store, it is the opaque key returned by that store's `put`. The relationship engine treats it as opaque.
- **`manifestSchemaVersion`** is pinned to the literal `"1"` at the time of writing (per `EVIDENCE_SCHEMA_VERSION` at [`packages/keiko-contracts/src/evidence.ts:21`](../../packages/keiko-contracts/src/evidence.ts)). A future bump to `"2"` would require an additive evolution of this ref shape.
- **`kind`** distinguishes:
  - `"attests"` — the evidence run records facts about a relationship that already existed (e.g. a verification run attesting that a `proposes-patch` was validated);
  - `"produces"` — the run produced the relationship as a side effect (the `produces-evidence` type's canonical kind);
  - `"depends-on-input"` — the run consumed the relationship's source endpoint as input (`reads-context`, `references-document`, `depends-on`).

### 2.2 What `RelationshipEvidenceRef` is NOT

- Not an embedded `EvidenceManifest`. It is a **pointer**.
- Not a copy of any field from the manifest. The relationship row does not carry `usageTotals`, `model`, `verificationResults`, `patch`, `failure`, `reasoning`, `browser`, or `connectedContext` content.
- Not a copy of any `summary` strings from the manifest. The relationship's own bounded `summary` field (per [storage.md §3.2](storage.md)) is sufficient; the evidence summary is reachable through the ref.
- Not a list of contributing events. Events live inside the manifest; the ref points to the manifest only.

This is the "point at the existing evidence artifact instead of duplicating the evidence content" acceptance criterion from issue #536, reified as a contract.

## 3. Creation rule

A `RelationshipEvidenceRef` is **created** exactly when one of the two lifecycle transitions from [lifecycle.md §6](lifecycle.md) fires:

1. `draft → active` or `blocked → active`: a new entry is appended to `EvidenceManifest.relationships?` (per [gap-analysis.md Gap 7](gap-analysis.md)) for the originating run AND the corresponding `RelationshipEvidenceRef` is set on the relationship row's `evidenceRef` field for `relationship.created` and `relationship.updated` audit events (per [audit-events.md §4.1 / §4.2](audit-events.md)).
2. `active → superseded` or `active → revoked`: a new entry is appended to `EvidenceManifest.relationships?` recording the change. The relationship row's `evidenceRef` is updated to point at the new manifest entry.

The original ref is **not** back-mutated. The audit invariant from [audit-events.md §9](audit-events.md) holds: rows are append-only.

The deep-redact pass at [`packages/keiko-evidence/src/persist.ts:50`](../../packages/keiko-evidence/src/persist.ts) is the defence-in-depth boundary. The ref carries opaque ids and pointers only; no string in the ref could ever match a secret pattern, but the pass runs anyway because the contract guarantees idempotence.

## 4. Workspace-scope invariant

`RelationshipEvidenceRef` is **workspace-scoped**. A ref MUST NOT point at an evidence manifest in a different workspace.

### 4.1 Structural barriers

1. **The evidence store directory is per-workspace.** The default Node store resolves the directory through `resolveEvidenceDir` ([`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts) per [`packages/keiko-evidence/src/persist.ts:34`](../../packages/keiko-evidence/src/persist.ts)). The relationship engine constructs refs only against the workspace's own resolved dir.
2. **The validator's path-containment check.** Per [denial-reasons.md `denied/path-not-contained`], a proposed evidence-bearing relationship whose `manifestPath` escapes the current workspace's evidence root is rejected at validation time.
3. **The read API filters by workspace.** `GET /api/relationships/:id/explain` (per [api-contract.md §4.9](api-contract.md)) loads the relationship row under the caller's workspace; if the row's `evidenceRef.evidenceRunId` resolves to a manifest outside the workspace store, the API returns `relationship/scope-not-permitted` (HTTP 403) and does NOT reveal the ref.

### 4.2 No cross-workspace dereferencing

A relationship in workspace A may never resolve a ref to an evidence manifest in workspace B. The relationship row itself cannot exist with cross-workspace endpoints (per [storage.md §3.1](storage.md) `workspace_scope_id` and the `denied/cross-workspace` denial in [denial-reasons.md](denial-reasons.md)); the ref therefore inherits the scope.

## 5. Deletion rule and tombstone

When a relationship is deleted (soft-delete via `DELETE /api/relationships/:id`, per [api-contract.md §4](api-contract.md)) **and** at least one active evidence ref names it:

1. The relationship row transitions to `lifecycle = "revoked"` per [storage.md §5.1](storage.md). The row is **not** removed.
2. A `relationship.deleted` audit row is written per [audit-events.md §4.3](audit-events.md), with `tombstoned: true`.
3. The retention sweep at [storage.md §5.3](storage.md) MUST NOT evict the `revoked` row while any non-retired `EvidenceManifest.relationships?` entry references it.
4. The relationship row is retained until **the last referencing evidence manifest itself ages out** under the evidence retention policy (`DEFAULT_RETENTION: maxRuns: 50` at [`packages/keiko-contracts/src/evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)).
5. Once the last referencing manifest is evicted, the next retention sweep evicts the row.

This mirrors the memory-vault tombstone pattern at [`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts) (memory tombstones outlive the underlying memory row to preserve the audit trail) applied at a different layer: the relationship row IS the tombstone-bearing record, retained while evidence still names it.

### 5.1 Why a tombstone, not row removal

Removing the row would leave dangling refs in evidence manifests. The evidence ledger is the canonical lineage record; the relationship table is the index ([storage.md §5.3](storage.md)). A dangling ref breaks the join from the inspector's "Open evidence run" link and the impact-analysis walk.

### 5.2 Hard-delete only via retention

There is no operator-facing hard-delete API. The only path that removes a `revoked` row from disk is the retention sweep, and the sweep is gated by the rule above. This is by design: the evidence retention envelope (`maxRuns: 50` default) is the canonical lifetime contract.

## 6. Query API obligation

`GET /api/relationships/:id/explain` (per [api-contract.md §4.9](api-contract.md)) MAY return the relationship's evidence refs but MUST NEVER inline evidence content. The contract:

1. The response body includes a `evidenceRefs: readonly RelationshipEvidenceRef[]` field when refs are present.
2. The response body does NOT include any field from `EvidenceManifest` beyond the version/identity already in the ref.
3. The UI navigates to the existing evidence viewer (e.g. `/evidence/<runId>`) to render the manifest; the BFF's relationships routes never proxy evidence bytes.

This keeps the privacy boundary explicit: relationship reads return relationship facts; evidence reads return evidence facts; the two never cross.

### 6.1 Bounded reference list

`evidenceRefs` is bounded to the last **32 refs** per relationship (one ref per lifecycle transition that wrote to a manifest; per [lifecycle.md §6](lifecycle.md), only `* → active`, `* → superseded`, and `* → revoked` write). Beyond 32 the list is truncated with a `truncated: true` flag in the response; the inspector links to the full history through the evidence-store browse page.

### 6.2 No content embedding even on inspector deep-link

Even when a user follows the inspector's "Open evidence run" deep-link, the relationship engine API surface is not the data channel. The deep-link target is the existing evidence-viewer route which already enforces the [security-checklist.md §"Evidence"](security-checklist.md) rules.

## 7. Audit-row embedding of `RelationshipEvidenceRef`

A `RelationshipEvidenceRef` MAY appear on the `relationship.created` and `relationship.updated` audit payload (per [audit-events.md §4.1 / §4.2](audit-events.md)) as the optional `evidenceRef` field. When present, it carries the same four-field shape as §2. The ref is part of the audit row's `payload_json` and inherits the redaction-on-write pass (per [audit-events.md §7](audit-events.md)) — the redactor finds nothing to redact in opaque ids, but the pass runs.

`relationship.deleted` does NOT carry an `evidenceRef`. The deletion is signalled by `tombstoned: true` per [audit-events.md §4.3](audit-events.md). The historical refs are reachable through the relationship row's lifecycle history; the audit row records the deletion event itself.

## 8. Evidence-side schema contract

The `EvidenceManifest.relationships?` section (per [gap-analysis.md Gap 7](gap-analysis.md) and [storage.md §4.3](storage.md)) carries entries shaped as:

```ts
interface EvidenceManifestRelationshipEntry {
  readonly relationshipId: string;
  readonly relationshipType: RelationshipType;
  readonly sourceKind: RelationshipEndpointKind;
  readonly sourceId: string; // opaque; workspace-scoped
  readonly targetKind: RelationshipEndpointKind;
  readonly targetId: string; // opaque; workspace-scoped
  readonly transition: "created" | "superseded" | "revoked";
  readonly occurredAt: number; // epoch-ms
  readonly summary: string; // <= 240 chars, redacted
}
```

Adding this `relationships?` field to `EvidenceManifest` is an **additive** schema evolution under the existing `evidenceSchemaVersion: "1"` invariant ([evidence.ts:21](../../packages/keiko-contracts/src/evidence.ts)). Old readers continue to ignore the field; new readers parse it. The build wiring is owned by [`packages/keiko-evidence/src/build.ts`](../../packages/keiko-evidence/src/build.ts) (issue #539 extends the builder to assemble the section from in-flight relationship mutations).

The section is **redacted-by-construction** at build time (the builder receives already-redacted `summary` strings from the relationship mutation handler) and **redacted again** by the persist-time deep-redact pass at [`packages/keiko-evidence/src/persist.ts:50`](../../packages/keiko-evidence/src/persist.ts).

## 9. Cross-cutting invariants

1. **Refs are pointers, not embeddings.** §2.2.
2. **Refs are workspace-scoped.** §4.
3. **Refs survive relationship deletion via tombstone.** §5.
4. **Refs never inline content on read.** §6.
5. **Refs inherit evidence retention.** §5.4; the relationship row's revoked-state lifetime is bounded above by the evidence manifest's retention.
6. **Refs are body-free.** No `RelationshipEvidenceRef` field carries a secret-shaped string, a prompt, a model output, a tool output, a patch body, a document body, or a customer identifier.

## 10. References

- [audit-events.md](audit-events.md), [activity-state.md](activity-state.md), [retention-and-privacy.md](retention-and-privacy.md), [audit-activity-checklist.md](audit-activity-checklist.md)
- [lifecycle.md](lifecycle.md), [taxonomy.md](taxonomy.md), [denial-reasons.md](denial-reasons.md), [storage.md](storage.md), [api-contract.md](api-contract.md), [architecture.md](architecture.md), [security-checklist.md](security-checklist.md)
- [`packages/keiko-contracts/src/evidence.ts`](../../packages/keiko-contracts/src/evidence.ts)
- [`packages/keiko-evidence/src/types.ts`](../../packages/keiko-evidence/src/types.ts), [`packages/keiko-evidence/src/build.ts`](../../packages/keiko-evidence/src/build.ts), [`packages/keiko-evidence/src/persist.ts`](../../packages/keiko-evidence/src/persist.ts)
- [`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts)
- [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#536](https://github.com/oscharko-dev/Keiko/issues/536).
