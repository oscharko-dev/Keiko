# Epic #532 — Relationship Engine Storage Design

Status: Wave 3 deliverable for [issue #535](https://github.com/oscharko-dev/Keiko/issues/535) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [architecture.md](architecture.md), [api-contract.md](api-contract.md), [security-checklist.md](security-checklist.md), [taxonomy.md](taxonomy.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md).

Date: 2026-06-06.

## 1. Purpose

This document locks the storage ownership for the relationship engine: which existing Keiko persistence facility holds the relationship table, what the schema looks like, how it migrates, how transactional invariants compose with redaction and audit, and how retention interacts with evidence reference contracts.

The decision binds issues [#538](https://github.com/oscharko-dev/Keiko/issues/538) (contracts + validator), [#539](https://github.com/oscharko-dev/Keiko/issues/539) (APIs), [#542](https://github.com/oscharko-dev/Keiko/issues/542) (impact + health), and is recorded normatively in [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md).

No new database, no new package, no new third-party dependency.

## 2. Storage choice

**Decision**: the relationship table lives **inside the existing UI-persistence SQLite database** owned by `@oscharko-dev/keiko-server` at [`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts) and migrated by [`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts).

The new table is added as `V5` in the existing migration ledger. The `PRAGMA user_version` runner ([`schema.ts:94`](../../packages/keiko-server/src/store/schema.ts)) already supports additive migrations transactionally.

### 2.1 Why the existing UI-persistence database

[gap-analysis.md Gap 5](gap-analysis.md) considered four options. The trade-offs settle as follows:

| Option                                         | Verdict     | Why                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing `keiko-server` store DB (this choice) | **Adopted** | Single SQLite file, single migration runner, single corrupt-DB quarantine flow, single backup story. The relationship table is a sibling of `chats` / `chat_messages`; no new fan-out of operational surfaces. Audit-bearing UI-persistence is the established pattern (issue #62 / #66 / #200).                                        |
| Memory-vault DB (`keiko-memory-vault`)         | Rejected    | Couples cross-domain relationships to vault retention (`forget.ts`, tombstones with `ON DELETE CASCADE`). A relationship row would be deleted whenever a memory endpoint was forgotten, defeating the audit-trail invariant.                                                                                                            |
| New separate SQLite file                       | Rejected    | Doubles the `node:sqlite` `--experimental-sqlite` flag activation surface (already a known footgun from the Issue #62 memory entry: three sites — CLI re-exec, vitest `execArgv`, no flag for `tsc`). Forces a parallel corrupt-DB quarantine handler, a parallel backup story, and a parallel migration ledger. No architectural gain. |
| JSON ledger (evidence-store style)             | Rejected    | O(N) per-row queries break the bounded-query cost model in [api-contract.md §7](api-contract.md). The impact-analysis primitive in [gap-analysis.md Gap 8](gap-analysis.md) would have to materialise an in-memory index on every call.                                                                                                 |

### 2.2 Why colocation does not weaken UI persistence rules

The existing UI-persistence database is subject to [ADR-0030 rule 5](../adr/ADR-0030-workspace-security-evidence.md): no raw secrets, customer data, private logs, or token-bearing artifacts in UI durable state. The relationship table inherits the rule:

- The `Relationship` record carries no payload fields (per [taxonomy.md §12](taxonomy.md)).
- The `summary` field is bounded to 240 chars and passed through `deepRedactStrings` at the persist boundary.
- The schema has no column for body content, prompts, document excerpts, or token-bearing strings (per §3).

Schema isolation between `relationships` and `chats` / `chat_messages` is enforced by table. No `FOREIGN KEY` from `relationships` to any existing UI-persistence table exists; endpoint liveness goes through the `RelationshipEndpointResolver` port instead (per [gap-analysis.md Gap 2](gap-analysis.md)).

## 3. Schema

### 3.1 SQL DDL (binding for #538 / #539)

```sql
-- V5 (issue #535) — relationship engine table.
CREATE TABLE relationships (
  id                  TEXT NOT NULL PRIMARY KEY,
  schema_version      TEXT NOT NULL,
  workspace_scope_id  TEXT NOT NULL,
  scope_kind          TEXT NOT NULL,
  scope_coordinate    TEXT NOT NULL,
  type                TEXT NOT NULL,
  source_kind         TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  target_kind         TEXT NOT NULL,
  target_id           TEXT NOT NULL,
  lifecycle           TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  etag                TEXT NOT NULL,
  confidence          REAL,
  summary             TEXT,
  CHECK (
    schema_version IN ('1')
    AND type IN (
      'reads-context','proposes-patch','uses-tool','starts-workflow',
      'produces-evidence','references-document','depends-on'
    )
    AND lifecycle IN (
      'draft','active','archived','superseded','revoked','blocked','stale'
    )
    AND scope_kind IN ('user','workspace','project','workflow','global')
    AND source_kind IN (
      'memory','capsule','capsule-set','workflow-run','evidence-run',
      'workspace-path','chat','tool','patch-proposal',
      'agent','connector','data-source','skill','mcp-tool'
    )
    AND target_kind IN (
      'memory','capsule','capsule-set','workflow-run','evidence-run',
      'workspace-path','chat','tool','patch-proposal',
      'agent','connector','data-source','skill','mcp-tool'
    )
    AND created_at >= 0
    AND updated_at >= created_at
    AND (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0))
    AND (summary IS NULL OR length(summary) <= 240)
  )
) STRICT;

-- Indexes serve the bounded-query patterns from api-contract.md §4.3:
CREATE INDEX idx_relationships_source
  ON relationships(workspace_scope_id, source_kind, source_id);
CREATE INDEX idx_relationships_target
  ON relationships(workspace_scope_id, target_kind, target_id);
CREATE INDEX idx_relationships_type
  ON relationships(workspace_scope_id, type, lifecycle);
CREATE INDEX idx_relationships_lifecycle
  ON relationships(workspace_scope_id, lifecycle, updated_at);

-- Cardinality enforcement at the DB layer (defence-in-depth alongside the validator):
-- 'produces-evidence' is 1:1 from source: a workflow-run produces at most one evidence-run.
CREATE UNIQUE INDEX uniq_relationships_produces_evidence_source
  ON relationships(workspace_scope_id, source_kind, source_id)
  WHERE type = 'produces-evidence' AND lifecycle IN ('draft','active','archived');

-- 'starts-workflow' is 1:1 from target: a workflow-run has exactly one origin.
CREATE UNIQUE INDEX uniq_relationships_starts_workflow_target
  ON relationships(workspace_scope_id, target_kind, target_id)
  WHERE type = 'starts-workflow' AND lifecycle IN ('draft','active','archived');

-- Lifecycle history (bounded to 32 rows per relationship by retention; see §5):
CREATE TABLE relationship_lifecycle_history (
  id              TEXT NOT NULL PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  from_state      TEXT NOT NULL,
  to_state        TEXT NOT NULL,
  occurred_at     INTEGER NOT NULL,
  summary         TEXT,
  CHECK (
    from_state IN ('draft','active','archived','superseded','revoked','blocked','stale')
    AND to_state IN ('draft','active','archived','superseded','revoked','blocked','stale')
    AND occurred_at >= 0
    AND (summary IS NULL OR length(summary) <= 240)
  )
) STRICT;

CREATE INDEX idx_relationship_lifecycle_relationship
  ON relationship_lifecycle_history(relationship_id, occurred_at);
```

### 3.2 Column rationale

- `schema_version` mirrors the established `schemaVersion` literal pattern; the `CHECK` constraint is the structural barrier for [taxonomy.md §3.2](taxonomy.md) additive evolution.
- `workspace_scope_id` is a denormalized copy of the scope identifier (the `workspaceId` / `projectId` / `workflowDefinitionId` / `userId` / sentinel for `global`) for index-friendly scope filtering. The full `MemoryScope` is reconstructed from `scope_kind` + `scope_coordinate`. The denormalization is read-only; updates go through the SQL `UPDATE` path which re-computes both.
- `etag` is the optimistic-concurrency token. The algorithm: `printf('%016x', updated_at) || '-' || lower(hex(randomblob(3)))`. The format gives 16 hex chars of timestamp plus 6 hex chars of random tiebreaker, total 23 chars including the hyphen. The string is opaque to the client; only `If-Match` equality matters.
- `confidence` is `REAL` (nullable) following the convention from [`packages/keiko-memory-vault/src/schema.ts:68`](../../packages/keiko-memory-vault/src/schema.ts) `memory_edges.confidence`.
- `summary` is `TEXT` (nullable), bounded by `CHECK` to 240 chars (the `MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS` value at [`packages/keiko-contracts/src/memory-audit-events.ts:35`](../../packages/keiko-contracts/src/memory-audit-events.ts)). The validator rejects upstream; the `CHECK` is the third barrier per [architecture.md §3.3](architecture.md).

### 3.3 Index coverage

Each route from [api-contract.md §4](api-contract.md) maps to an index:

| Route                                          | Index used                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET `/api/relationships?sourceKind=&sourceId=` | `idx_relationships_source`                                                                 |
| GET `/api/relationships?targetKind=&targetId=` | `idx_relationships_target`                                                                 |
| GET `/api/relationships?type=&lifecycle=`      | `idx_relationships_type`                                                                   |
| GET `/api/relationships?lifecycle=`            | `idx_relationships_lifecycle`                                                              |
| GET `/api/relationships/health`                | `idx_relationships_lifecycle` (filtered)                                                   |
| Cardinality enforcement (POST validation)      | `uniq_relationships_produces_evidence_source`, `uniq_relationships_starts_workflow_target` |

The dependency walk and impact routes use the source/target indexes for outgoing/incoming traversal at each hop. Bounded `maxDepth: 3` + `maxNodes: 1024` keeps the walk cost dominated by the indexed lookups.

### 3.4 The forward-looking-kind question

`source_kind` and `target_kind` `CHECK` lists include the forward-looking kinds (`agent`, `connector`, `data-source`, `skill`, `mcp-tool`) so the schema is stable when the owning registries land. The validator rejects writes that name them with `denied/object-kind-not-yet-supported` (per [denial-reasons.md](denial-reasons.md)) so no row with a forward-looking kind ever exists in production at `schemaVersion: "1"`.

## 4. Transactional rules

Every mutation is one SQL transaction. The order of operations:

1. `BEGIN`.
2. Acquire the row (for PATCH / DELETE) via `SELECT etag FROM relationships WHERE id = ?`.
3. Validate the `If-Match` header against the acquired etag. Mismatch → `ROLLBACK` and `relationship/optimistic-concurrency-conflict`.
4. Run the validator (pure function; uses an injected snapshot of the current store state limited to the rows the validator needs, plus the endpoint resolver port).
5. If the decision is `allowed: false` → `ROLLBACK` and `relationship/policy-denied`. Persist a `relationship:rejected` activity event outside the transaction (or in a sibling audit row inside the same transaction, owned by ADR-0032).
6. Compute the new row state: `updated_at = now()`, `etag = newEtag()`.
7. `INSERT` or `UPDATE` (and `INSERT INTO relationship_lifecycle_history` on every state transition).
8. Emit the activity event(s) inside the same transaction by writing the audit row (issue #536) or by enqueuing the SSE-emit side effect post-commit. The exact placement is owned by ADR-0032; this contract requires that **the audit row's existence and the relationship row's state are either both present or both absent** — no half-applied state on the wire.
9. `COMMIT`.

### 4.1 Why the validator runs inside the transaction

The validator's snapshot must reflect the state seen by the `INSERT` / `UPDATE`. Running the validator outside the transaction would create a TOCTOU window between snapshot read and write commit; another writer could insert a conflicting `produces-evidence` row between the snapshot and the commit. The `UNIQUE` partial indexes are the second barrier; the in-transaction validator is the first.

### 4.2 Why the `stale` lifecycle is flipped by the health check only

`stale` is a derived state: it means at least one endpoint is `tombstoned` / `retired` / `unavailable`. The health-check pass (route 10) walks the relationship table, asks each `RelationshipEndpointResolver`, and writes `lifecycle = 'stale'` (plus a history row) for any relationship whose source or target liveness is non-`live`. The health check is a separate transaction per row.

A mutation path **never** writes `stale` directly; the validator may surface an endpoint-liveness denial reason (`denied/endpoint-tombstoned`, etc.) and reject the proposal, but it does not transition existing rows. This separation keeps the mutation path's behaviour deterministic and isolates the resolver-port side effects to a dedicated route.

### 4.3 Audit-row co-location

The audit row's home is the optional `relationships?` section of `EvidenceManifest` (per [gap-analysis.md Gap 7](gap-analysis.md)) **plus**, for cross-domain mutations not tied to a run, an additive audit row in this database. The decision between the two surfaces is owned by ADR-0032 (issue #536). For the purposes of this contract:

- The current implementation routes both run-scoped and non-run-scoped relationship mutations to the sibling audit table in this database, `relationship_audit_entries`.
- Future `EvidenceManifest.relationships?` embedding remains deferred follow-up work. The shape and any placement split are locked in ADR-0032 / later hardening work; this document keeps the current-state storage decision explicit.

### 4.4 Atomic-write conventions for the SQLite database

The existing UI-persistence database lives under the `keiko-server` data directory and is opened by [`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts). The opening flow already:

- Applies `--experimental-sqlite` at the three sites documented in the Issue #62 memory entry (CLI re-exec, vitest `execArgv`, no flag for `tsc`).
- Runs `runMigrations` ([`schema.ts:94`](../../packages/keiko-server/src/store/schema.ts)) transactionally; partial migrations roll back.
- Quarantines a corrupt DB by renaming to `.corrupt.<iso>` per the issue #62 memory entry pattern.

V5 inherits all three. No new infrastructure is added.

## 5. Retention

### 5.1 Soft-delete vs. hard-delete

`DELETE /api/relationships/:id` is a soft delete: it transitions the row to `lifecycle = 'revoked'` and writes a history entry. The row remains in the table.

Hard-delete sweeps may evict `revoked` rows older than a threshold to prevent unbounded growth. The threshold:

- Default: `maxRevokedRows: 50000` per workspace (round-number large bound; the table is narrow so even a million rows is manageable). The actual count is parameterised at startup; the default lives in `keiko-server` deps.
- Always-keep-newest: the most recent `revoked` row per `(source, target, type)` is **never** evicted while either endpoint is still live. This preserves the dependency-walk audit trail.

### 5.2 Lifecycle-history retention

`relationship_lifecycle_history` keeps the last 32 transitions per relationship. The sweep runs as part of the health-check route (route 10) and is bounded so it never starves the request thread. Out-of-band history older than 32 rows is evicted during the sweep; the oldest-first eviction policy is symmetric with the `keiko-evidence` retention ledger.

### 5.3 Evidence-reference invariant

**Never delete a `revoked` row that still appears in an evidence manifest.** Restated normatively for issue #543's hardening pass: the retention sweep MUST consult the evidence store ([`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts)) to check whether the relationship id appears in any non-retired `EvidenceManifest.relationships?` section (per the audit-section design in [gap-analysis.md Gap 7](gap-analysis.md) and ADR-0032). If yes, the row is retained until the evidence manifest itself ages out under `DEFAULT_RETENTION: maxRuns: 50` ([`packages/keiko-contracts/src/evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)).

This is the storage-side enforcement of the rule "evidence retains its referenced relationship rows": the evidence ledger is the canonical lineage record; the relationship table is the index.

## 6. Migration story

### 6.1 V5 migration

The migration runner at [`packages/keiko-server/src/store/schema.ts:94`](../../packages/keiko-server/src/store/schema.ts) gains:

- `SCHEMA_VERSION = 5`.
- A `V5_SQL` constant containing the DDL above.
- An entry `{ version: 5, sql: V5_SQL }` in the `MIGRATIONS` array.

The runner is transactional, idempotent, and forward-only — no migration alters this table after V5 without a new version.

### 6.2 Additive-only rule

Adding a relationship type, object kind, lifecycle state, or denial-reason code is an additive change that lands as a new migration extending the relevant `CHECK` constraint. The migration adds the new value to the list; old rows continue to validate; new rows are accepted.

A breaking change (rename, narrowing, removal) requires a new `schemaVersion` literal at the contract layer **plus** a new SQL migration that rewrites the table (typically: create new table, copy rows, drop old, rename). The breaking change is gated by a new ADR amending or superseding [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md). The migration runner remains forward-only.

### 6.3 Rollback

The `node:sqlite` migration runner does not support rollback. Recovery from a bad migration is the corrupt-DB quarantine flow: rename to `.corrupt.<iso>` and start clean. This is the existing pattern from the Issue #62 memory entry; the relationship table inherits it.

For development environments, `npm run reset` (or equivalent) deletes the database file; for production, the operator restores from a backup or accepts data loss with the quarantine.

## 7. Operational notes

### 7.1 Database size projection

A relationship row is approximately 256 bytes on disk (mostly TEXT columns; STRICT mode keeps overhead modest). At 50,000 revoked rows per workspace plus a typical active set of 10,000, the table is on the order of 15 MB per workspace. This is well within the operating envelope of `node:sqlite` and the existing UI-persistence database, which already holds chats and chat messages of comparable size.

### 7.2 Backup

The relationship table is part of the existing UI-persistence database. Backup mechanisms (file copy with the database closed, or `VACUUM INTO` to a sibling file) work unchanged. No new backup tooling is introduced.

### 7.3 Read-side caching

No application-level cache is introduced. The bounded-query contract in [api-contract.md §7](api-contract.md) plus the indexed lookups make per-call cost predictable; a cache would introduce staleness without measurable benefit.

### 7.4 Multi-process considerations

The deployed BFF is a single process (per [ADR-0011 D5](../adr/ADR-0025-forward-only-0-2-0-modular-baseline.md) lineage). Multi-process deployments are explicitly out of scope; if the deployment shape changes, a new ADR locks the cross-process concurrency model.

## 8. References

- [architecture.md](architecture.md), [api-contract.md](api-contract.md), [security-checklist.md](security-checklist.md)
- [taxonomy.md](taxonomy.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md)
- [gap-analysis.md](gap-analysis.md), [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [adr-candidates.md](adr-candidates.md)
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md)
- [`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts), [`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#535](https://github.com/oscharko-dev/Keiko/issues/535).
