# Epic #532 — Relationship Audit Event Model

Status: Wave 3 deliverable for [issue #536](https://github.com/oscharko-dev/Keiko/issues/536) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [activity-state.md](activity-state.md), [evidence-references.md](evidence-references.md), [retention-and-privacy.md](retention-and-privacy.md), [audit-activity-checklist.md](audit-activity-checklist.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md).

Date: 2026-06-06.

## 1. Purpose

This document is the durable-audit contract for the relationship engine. It locks:

- the closed set of relationship audit event kinds;
- the per-kind schema (TypeScript-flavored);
- the append-only invariant;
- the field classification per kind (durable / transient / FORBIDDEN);
- the persistence placement decision per row-class (evidence-manifest section vs. sibling `relationship_audit_entries` table);
- the redaction-on-write contract;
- the workspace-scope contract;
- the cross-workspace denial subtlety.

The contract binds issues [#538](https://github.com/oscharko-dev/Keiko/issues/538) (contracts + validator), [#539](https://github.com/oscharko-dev/Keiko/issues/539) (APIs), [#541](https://github.com/oscharko-dev/Keiko/issues/541) (activity visualization), [#542](https://github.com/oscharko-dev/Keiko/issues/542) (impact + health), and is recorded normatively in [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md).

No new database, no new package, no new third-party dependency.

## 1.1 Current implementation note

On current `dev`, the durable audit contract is only partially implemented:

- `relationship_audit_entries` is the shipped persistence surface.
- `EvidenceManifest` does not yet expose a `relationships` section.
- `resolveAuditPlacement()` currently returns `"sibling-table"` for every row, including workflow-run-scoped mutations ([`../../packages/keiko-server/src/store/relationship-audit.ts`](../../packages/keiko-server/src/store/relationship-audit.ts)).
- The optional `evidenceRef` shape below is a design target, not a field the current server emits.

## 2. Relationship to the existing audit vocabulary

The closed enum below is **the audit-layer projection of the relationship lifecycle** in the same way `MemoryAuditEvent` ([`packages/keiko-contracts/src/memory-audit-events.ts:41`](../../packages/keiko-contracts/src/memory-audit-events.ts)) is the audit-layer projection of the memory-vault state machine. The naming convention, schema-version pinning, and envelope fields mirror the memory audit contract:

- pinned literal `relationshipAuditSchemaVersion: "1"` (mirrors [`memory-audit-events.ts:29`](../../packages/keiko-contracts/src/memory-audit-events.ts) `MEMORY_AUDIT_EVENT_SCHEMA_VERSION`);
- bounded `summary` of 240 chars (mirrors [`memory-audit-events.ts:34`](../../packages/keiko-contracts/src/memory-audit-events.ts) `MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS`);
- discriminated union over `kind` with a shared envelope (mirrors [`memory-audit-events.ts:73`](../../packages/keiko-contracts/src/memory-audit-events.ts) `MemoryAuditEventEnvelope`);
- redaction-before-persist via `createAuditRedactor` ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)) and `deepRedactStrings` ([`packages/keiko-security/src/redaction.ts:114`](../../packages/keiko-security/src/redaction.ts)).

The vocabulary is also distinct from the existing wire-level `RelationshipActivityKind` family enumerated in [lifecycle.md §5](lifecycle.md) (`relationship:proposed`, `relationship:accepted`, `relationship:rejected`, `relationship:retracted`, `relationship:superseded`, `relationship:archived`, `relationship:impacted`). Those names address **live SSE activity events** rendered in the inspector and dependency view; they are presentation kinds. The audit kinds in this document address **durable audit rows** that survive a process restart. The mapping is many-to-many; §6 ties them together.

## 3. Closed enum of audit event kinds

```ts
export const RELATIONSHIP_AUDIT_SCHEMA_VERSION = "1" as const;
export const RELATIONSHIP_AUDIT_SUMMARY_MAX_CHARS = 240;

export type RelationshipAuditKind =
  | "relationship.created"
  | "relationship.updated"
  | "relationship.deleted"
  | "relationship.reconnected"
  | "relationship.validation-denied"
  | "relationship.policy-denied"
  | "relationship.activity-transitioned"
  | "relationship.impact-analysis-bounded"
  | "relationship.health-finding";
```

| Kind                                   | Mutation trigger                                                                        | Persist site                       |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| `relationship.created`                 | `POST /api/relationships` accepted (validator `allowed: true`).                         | dual; see §5                       |
| `relationship.updated`                 | `PATCH /api/relationships/:id` accepted.                                                | dual; see §5                       |
| `relationship.deleted`                 | `DELETE /api/relationships/:id` accepted (soft-delete to `revoked`).                    | dual; see §5                       |
| `relationship.reconnected`             | `stale → active` lifecycle transition observed by the health-check pass.                | sibling table only                 |
| `relationship.validation-denied`       | Validator returned `allowed: false` for structural reasons (identity/kind/cardinality). | sibling table only                 |
| `relationship.policy-denied`           | Validator returned `allowed: false` for policy reasons (scope/path/deny-list/auth).     | sibling table only                 |
| `relationship.activity-transitioned`   | Lifecycle transition committed (any `X → Y` per [lifecycle.md §3](lifecycle.md)).       | sibling table only                 |
| `relationship.impact-analysis-bounded` | `GET /api/relationships/impact` returned with `truncated: true` (bounded fan-out hit).  | sibling table only                 |
| `relationship.health-finding`          | Health-check pass observed a non-`live` endpoint or wrote `stale`.                      | evidence-manifest where applicable |

The closed enum extends additively per [taxonomy.md §3.2](taxonomy.md): a new kind adds a member; existing readers continue to parse old payloads at `"1"`. A breaking change introduces a new literal `relationshipAuditSchemaVersion: "2"`.

## 4. Per-kind schema

Every payload extends the common envelope. `summary` is REDACTED before the payload reaches this type at the audit boundary (per §7); the type-level invariant is "non-secret short rationale". `actor.redactedActorId` is an opaque per-workspace identifier — never an email, never a username, never a session token, never PII.

```ts
interface RelationshipAuditEnvelope {
  readonly relationshipAuditSchemaVersion: typeof RELATIONSHIP_AUDIT_SCHEMA_VERSION;
  readonly eventId: string; // ULID; monotone within a workspace
  readonly sequence: number; // monotone counter per workspace
  readonly workspaceId: string; // scope; queries are workspace-filtered
  readonly occurredAt: number; // epoch-ms
  readonly actor: {
    readonly surface: "chat" | "inspector" | "workflow" | "health-check" | "system";
    readonly redactedActorId: string; // opaque per-workspace; NEVER PII
  };
  readonly redactionState: "redacted-on-write" | "redacted-on-write-and-persist";
  readonly summary: string; // <= 240 chars, redacted
}
```

### 4.1 `relationship.created`

```ts
type RelationshipCreatedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.created";
  readonly relationshipId: string;
  readonly relationshipType: RelationshipType; // from taxonomy.md §4
  readonly sourceKind: RelationshipEndpointKind;
  readonly sourceId: string; // opaque; per-workspace
  readonly targetKind: RelationshipEndpointKind;
  readonly targetId: string; // opaque; per-workspace
  readonly lifecycle: "draft" | "active"; // initial state per lifecycle.md §3
  readonly etag: string; // optimistic-concurrency token
  readonly evidenceRef?: RelationshipEvidenceRef; // follow-up seam; not emitted on current dev
};
```

### 4.2 `relationship.updated`

```ts
type RelationshipUpdatedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.updated";
  readonly relationshipId: string;
  readonly changedFields: readonly ("confidence" | "summary" | "lifecycle")[]; // closed set
  readonly previousEtag: string;
  readonly newEtag: string;
};
```

### 4.3 `relationship.deleted`

Soft-delete only (per [storage.md §5.1](storage.md)): the row transitions to `lifecycle: "revoked"`. Hard-deletion happens through retention sweeps and never emits a `relationship.deleted` audit row — sweeps emit a structural `retention:evicted` ledger entry owned by [retention-and-privacy.md §3](retention-and-privacy.md).

```ts
type RelationshipDeletedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.deleted";
  readonly relationshipId: string;
  readonly tombstoned: true; // always true; per evidence-references.md §3
  readonly reasonCode: "operator-revoked" | "endpoint-tombstoned" | "endpoint-retired";
};
```

### 4.4 `relationship.reconnected`

A `stale → active` transition observed by the health-check pass after an endpoint became `live` again. This is the only kind that names two lifecycle states.

```ts
type RelationshipReconnectedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.reconnected";
  readonly relationshipId: string;
  readonly fromLifecycle: "stale";
  readonly toLifecycle: "active";
  readonly endpointSide: "source" | "target" | "both";
};
```

### 4.5 `relationship.validation-denied`

Structural denials from the validator (identity / kind / cardinality / cycle). The payload carries the denial code only and intentionally omits `proposedSourceId` / `proposedTargetId` — the proposal was rejected; persisting it would leak the existence of identifiers the operator was not authorised to use. The kind and the type are recorded for the inspector summary.

```ts
type RelationshipValidationDeniedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.validation-denied";
  readonly proposedType: RelationshipType;
  readonly proposedSourceKind: RelationshipEndpointKind;
  readonly proposedTargetKind: RelationshipEndpointKind;
  readonly reasons: readonly RelationshipPolicyReason[];
  // reasons[].code MUST be one of the structural codes from denial-reasons.md §"Catalog":
  //   denied/non-existent-source, denied/non-existent-target,
  //   denied/object-kind-not-yet-supported, denied/source-kind-not-allowed,
  //   denied/target-kind-not-allowed, denied/kind-incompatible,
  //   denied/cardinality-exceeded, denied/cycle-forbidden, denied/schema-version-unsupported.
};
```

### 4.6 `relationship.policy-denied`

Policy denials (scope / path / deny-list / authority / payload-content). Same body-free invariant as `relationship.validation-denied`.

The **cross-workspace subtlety**: when the denial reason is `denied/cross-workspace` (per [denial-reasons.md](denial-reasons.md)), the payload MUST NOT include `proposedSourceId` or `proposedTargetId`. The validator is allowed to recognise that an id resolves to a different workspace; the audit row is NOT allowed to record which one — that would let an audit reader confirm the existence of an identifier in a workspace they cannot read. The payload records only:

```ts
type RelationshipPolicyDeniedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.policy-denied";
  readonly proposedType: RelationshipType;
  readonly proposedSourceKind: RelationshipEndpointKind;
  readonly proposedTargetKind: RelationshipEndpointKind;
  readonly reasons: readonly RelationshipPolicyReason[];
  // For denied/cross-workspace: reasons[].endpoint identifies the offending side
  // ("source" | "target") but NEVER carries the id. For all other policy codes,
  // ids are also omitted by convention — the relationship was never created;
  // the inspector can re-issue the proposal to see live denial detail.
};
```

### 4.7 `relationship.activity-transitioned`

A lifecycle transition that did commit. Maps to the `RelationshipActivityKind` family in [lifecycle.md §5](lifecycle.md). The wire-level activity event (live SSE) is body-free per [lifecycle.md §5](lifecycle.md); the audit row adds the durable from/to state record.

```ts
type RelationshipActivityTransitionedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.activity-transitioned";
  readonly relationshipId: string;
  readonly from: RelationshipLifecycle;
  readonly to: RelationshipLifecycle;
  readonly liveActivityKind: RelationshipActivityKind; // mapping per §6
};
```

### 4.8 `relationship.impact-analysis-bounded`

Emitted when `GET /api/relationships/impact` returns `truncated: true` (per [api-contract.md §4.8](api-contract.md)). The audit row records that the operator hit the fan-out cap. It does NOT enumerate the nodes — that would defeat the cap.

```ts
type RelationshipImpactAnalysisBoundedAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.impact-analysis-bounded";
  readonly originRelationshipId: string;
  readonly requestedMaxDepth: number;
  readonly requestedMaxNodes: number;
  readonly observedDepth: number;
  readonly observedNodes: number; // bounded by maxNodes
  readonly truncatedAt: "depth" | "nodes";
};
```

### 4.9 `relationship.health-finding`

Emitted by the health-check pass when it observes a non-`live` endpoint or commits a `* → stale` transition. One row per relationship per pass; rows are batched per workspace.

```ts
type RelationshipHealthFindingAudit = RelationshipAuditEnvelope & {
  readonly kind: "relationship.health-finding";
  readonly relationshipId: string;
  readonly sourceLiveness: "live" | "tombstoned" | "retired" | "unavailable";
  readonly targetLiveness: "live" | "tombstoned" | "retired" | "unavailable";
  readonly newLifecycle: "stale" | "active"; // resulting state after the pass
};
```

## 5. Persistence placement decision (per row-class)

The relationship engine writes audit rows to two persistence surfaces, never both for the same logical event. The decision is per **row-class**, not per-event-instance. The split honors [storage.md §4.3](storage.md), which explicitly deferred this decision to #536.

### 5.1 The two surfaces

1. **Future seam: evidence-manifest `relationships?` section.** Not yet present in the shipped `EvidenceManifest` contract. If implemented, it should be added additively and persisted by the existing evidence pipeline.

2. **Sibling `relationship_audit_entries` table.** Added as part of the V5 migration in the UI-persistence SQLite database alongside the `relationships` table (per [storage.md §3.1](storage.md)). Co-located so the audit row write and the relationship row write share a single `BEGIN`/`COMMIT` (per [storage.md §4](storage.md)). Owned by `@oscharko-dev/keiko-server` migration runner ([`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts)).

### 5.2 Per-row-class placement

| Audit kind                             | Run-scoped? | Placement                                                                                                                                                                     |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relationship.created`                 | Sometimes   | Design target: `EvidenceManifest.relationships` when source is a `workflow-run`; sibling table otherwise. Current `dev`: sibling table only.                                  |
| `relationship.updated`                 | Sometimes   | Same design target as `created`. Current `dev`: sibling table only.                                                                                                           |
| `relationship.deleted`                 | Sometimes   | Same design target as `created`. Current `dev`: sibling table only.                                                                                                           |
| `relationship.reconnected`             | No          | Sibling table only (health-check pass has no run context).                                                                                                                    |
| `relationship.validation-denied`       | No          | Sibling table only (no relationship row exists; cannot tie to a run).                                                                                                         |
| `relationship.policy-denied`           | No          | Sibling table only (same reason).                                                                                                                                             |
| `relationship.activity-transitioned`   | No          | Sibling table only (transitions happen outside run boundaries).                                                                                                               |
| `relationship.impact-analysis-bounded` | No          | Sibling table only (the request is a read; no run materialises the row).                                                                                                      |
| `relationship.health-finding`          | Conditional | `EvidenceManifest.relationships` when emitted during a workflow run that triggered the health pass; sibling table otherwise. Health passes outside a run are the common case. |

### 5.3 The selection rule

For the three mutation kinds (`created`, `updated`, `deleted`), the intended placement is selected by the **source endpoint kind**:

- If `sourceKind === "workflow-run"` AND the request handler holds an `evidenceRunId` for the in-flight run, the audit row is written into `EvidenceManifest.relationships` for that run. The row is part of the run's evidence.
- Otherwise, the audit row is written to the sibling `relationship_audit_entries` table. The row stands alone with full envelope fields.

This remains the design rule. Current `dev` stops short of the workflow-run manifest branch and keeps the single-call-site invariant by writing every row to the sibling table.

### 5.4 Justification

- **Evidence-manifest section for run-scoped mutations** keeps the per-run audit story intact: the manifest already records every tool call, command execution, patch, and verification result for that run. The relationship facts produced during the run live alongside. Retention is inherited; no second retention policy is introduced.
- **Sibling table for non-run-scoped mutations** keeps every audit row reachable by workspace-scoped query without scanning evidence files. Denial events, policy events, lifecycle transitions, impact-analysis bounds, and standalone health findings all need fast workspace-scoped listing (the inspector lists the last N events for a workspace; per [api-contract.md §4.9](api-contract.md)).
- **Atomic-write coupling** with the relationship row write (per [storage.md §4](storage.md)) is only possible in the sibling table — the SQL transaction already wraps the `relationships` row write. Run-scoped audit rows DO NOT cross this transaction (they live in the evidence file, written post-commit); for those rows, the relationship row is the source of truth and the evidence-manifest section is a denormalised projection re-derived from the relationship row at evidence-build time.

### 5.5 `relationship_audit_entries` schema (binding for #538 / #539)

The sibling table is added in the same V5 migration as `relationships` (per [storage.md §3.1](storage.md)). DDL:

```sql
-- V5 (issue #536) — relationship audit ledger sibling table.
CREATE TABLE relationship_audit_entries (
  event_id                       TEXT NOT NULL PRIMARY KEY,
  relationship_audit_schema_ver  TEXT NOT NULL,
  workspace_id                   TEXT NOT NULL,
  sequence                       INTEGER NOT NULL,
  occurred_at                    INTEGER NOT NULL,
  kind                           TEXT NOT NULL,
  relationship_id                TEXT,
  actor_surface                  TEXT NOT NULL,
  redacted_actor_id              TEXT NOT NULL,
  redaction_state                TEXT NOT NULL,
  summary                        TEXT NOT NULL,
  payload_json                   TEXT NOT NULL,
  CHECK (
    relationship_audit_schema_ver IN ('1')
    AND kind IN (
      'relationship.created','relationship.updated','relationship.deleted',
      'relationship.reconnected','relationship.validation-denied',
      'relationship.policy-denied','relationship.activity-transitioned',
      'relationship.impact-analysis-bounded','relationship.health-finding'
    )
    AND actor_surface IN ('chat','inspector','workflow','health-check','system')
    AND redaction_state IN ('redacted-on-write','redacted-on-write-and-persist')
    AND sequence >= 0
    AND occurred_at >= 0
    AND length(summary) <= 240
  )
) STRICT;

CREATE UNIQUE INDEX uniq_relationship_audit_workspace_sequence
  ON relationship_audit_entries(workspace_id, sequence);
CREATE INDEX idx_relationship_audit_workspace_occurred_at
  ON relationship_audit_entries(workspace_id, occurred_at);
CREATE INDEX idx_relationship_audit_relationship
  ON relationship_audit_entries(workspace_id, relationship_id, occurred_at)
  WHERE relationship_id IS NOT NULL;
```

`payload_json` carries the kind-specific fields from §4 serialised after the persist-time deep-redact pass (per §7). `relationship_id` is `NULL` for `relationship.validation-denied` and `relationship.policy-denied` (no row exists yet). The `(workspace_id, sequence)` uniqueness is the append-only invariant's structural barrier.

The table inherits the existing UI-persistence database's corrupt-DB quarantine flow ([storage.md §4.4](storage.md)) and the `--experimental-sqlite` activation strategy.

## 6. Mapping from audit kinds to live `RelationshipActivityKind`

The live SSE activity stream emits the `RelationshipActivityKind` family from [lifecycle.md §5](lifecycle.md). The audit row records the structural truth. The mapping:

| `RelationshipActivityKind` (live SSE) | Audit kind written                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `relationship:proposed`               | `relationship.created` (lifecycle = `draft`).                                                                                   |
| `relationship:accepted`               | `relationship.activity-transitioned` (`* → active`) + a `relationship.created` for the first ever `draft → active` direct path. |
| `relationship:rejected`               | `relationship.validation-denied` or `relationship.policy-denied`; never both for the same event.                                |
| `relationship:retracted`              | `relationship.deleted`.                                                                                                         |
| `relationship:superseded`             | `relationship.activity-transitioned` (`* → superseded`).                                                                        |
| `relationship:archived`               | `relationship.activity-transitioned` (`* → archived`).                                                                          |
| `relationship:impacted`               | `relationship.activity-transitioned` (`* → stale`) + a `relationship.health-finding` carrying the endpoint liveness.            |

The live event and the audit row are emitted by the same server-authoritative code path (per [lifecycle.md §4](lifecycle.md)); the SSE emit is post-commit, the audit write is in-transaction (sibling table) or part of the evidence build (manifest section).

## 7. Redaction-on-write contract

Every audit row passes through redaction **before** persist. The single call site is:

```ts
const redact = createAuditRedactor(redactionConfig, processEnv);
const safePayload = deepRedactStrings(payload, redact) as RelationshipAuditEvent;
```

referencing [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts) and [`packages/keiko-security/src/redaction.ts:114`](../../packages/keiko-security/src/redaction.ts).

The redactor receives the union of:

- caller-supplied additional secrets (per [evidence.ts:297](../../packages/keiko-contracts/src/evidence.ts) `AuditRedactionConfig`);
- env-value secrets named via the existing helper [`packages/keiko-security/src/secrets.ts:33`](../../packages/keiko-security/src/secrets.ts) `keikoApiKeySecretValues`;
- the configured `sensitiveLiterals`.

The redactor is **idempotent** ([`packages/keiko-security/src/redaction.ts:111`](../../packages/keiko-security/src/redaction.ts)), so:

- **Sibling-table writes** set `redactionState: "redacted-on-write"` and run the redactor exactly once before the SQL `INSERT`. The `payload_json` column stores the post-redaction shape.
- **Evidence-manifest writes** set `redactionState: "redacted-on-write-and-persist"` because [`packages/keiko-evidence/src/persist.ts:50`](../../packages/keiko-evidence/src/persist.ts) re-runs `deepRedactStrings` as defense-in-depth. The build-time pass is primary; the persist-time pass cannot break correctness because of idempotence.

No new redactor is introduced. No new regex. No new secret-shape detector. The existing patterns at [`packages/keiko-security/src/redaction.ts:15`–`32`](../../packages/keiko-security/src/redaction.ts) cover Bearer / Basic / OpenAI / GitHub / AWS / Slack / Google / PEM / generic API-key shapes.

## 8. Field classification

### 8.1 Durable fields (persisted in `payload_json` or `EvidenceManifest.relationships`)

For all kinds: `relationshipAuditSchemaVersion`, `eventId`, `sequence`, `workspaceId`, `occurredAt`, `actor.surface`, `actor.redactedActorId`, `redactionState`, `summary` (≤240 chars, redacted), `kind`.

Per kind (additive over the envelope):

- `created`/`updated`/`deleted`: `relationshipId`, `relationshipType`, `sourceKind`, `targetKind`, opaque `sourceId`/`targetId`, `lifecycle`, `etag`/`previousEtag`/`newEtag`, `changedFields`, optional `evidenceRef` (follow-up seam), `tombstoned`, `reasonCode`.
- `reconnected`: `relationshipId`, `fromLifecycle`, `toLifecycle`, `endpointSide`.
- `validation-denied`/`policy-denied`: `proposedType`, `proposedSourceKind`, `proposedTargetKind`, `reasons[].code`, `reasons[].endpoint`, `reasons[].summary` (≤240 chars, redacted).
- `activity-transitioned`: `relationshipId`, `from`, `to`, `liveActivityKind`.
- `impact-analysis-bounded`: `originRelationshipId`, `requestedMaxDepth`, `requestedMaxNodes`, `observedDepth`, `observedNodes`, `truncatedAt`.
- `health-finding`: `relationshipId`, `sourceLiveness`, `targetLiveness`, `newLifecycle`.

### 8.2 Transient fields (computed at read time, never persisted)

- Endpoint display labels (resolved through the endpoint resolver at read time per [storage.md §2.2](storage.md)).
- Aggregated counts in the inspector summary (recomputed on each request).
- Live `RelationshipActivityKind` event-name presentation (re-derived from §6 mapping at SSE-emit time).
- The current activity-state badge from [activity-state.md](activity-state.md). Activity state is in-memory only.

### 8.3 FORBIDDEN fields

The following MUST NEVER appear in any audit row, evidence-manifest section, or activity payload — not in `summary`, not in `payload_json`, not in any nested string, not in any future additive field:

- raw prompts (user input, system prompts);
- model output text (the assistant turn body);
- document contents (file bodies, retrieved-document excerpts beyond the bounded redacted summary already governed by the connected-context redactor);
- tool stdout / stderr (the existing `command:executed` event at [`packages/keiko-contracts/src/harness.ts:256`](../../packages/keiko-contracts/src/harness.ts) emits counts and flags only — this audit ledger inherits the same discipline);
- patch bodies / diff bytes (the existing `patch:applied` event at [`packages/keiko-contracts/src/harness.ts:280`](../../packages/keiko-contracts/src/harness.ts) emits file counts only — same discipline);
- secrets (API keys, OAuth tokens, refresh tokens, signing keys, password hashes);
- credentials (`Authorization` headers, cookies, session ids, CSRF tokens);
- private logs (any tool output redirected to a file path);
- request bodies that include the above (the audit ledger never proxies HTTP bodies);
- customer data, PII (email, real name, phone, IP, geolocation);
- cross-workspace identifiers (`proposedSourceId` / `proposedTargetId` on `denied/cross-workspace`; see §4.6).

The list mirrors the existing memory-audit invariant ([`packages/keiko-contracts/src/memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts) "NEVER carry raw memory body or payload") and the evidence non-content rule (counts/flags only).

## 9. Append-only invariant

Once written, an audit row is never mutated:

1. **No `UPDATE`.** The validator at [`packages/keiko-server/src/store/validation.ts`](../../packages/keiko-server/src/store/validation.ts) — extended for V5 by #538 — rejects any attempt to `UPDATE relationship_audit_entries` outside the migration runner.
2. **No `DELETE` outside retention.** Hard deletion happens through bounded retention sweeps (per [retention-and-privacy.md §3](retention-and-privacy.md)); the sweep emits an additional structural ledger event rather than silently removing rows mid-stream.
3. **Tombstones, never silent removal.** A relationship deletion is recorded as `relationship.deleted` (per §4.3) AND the underlying `relationships` row transitions to `lifecycle = "revoked"` (per [storage.md §5.1](storage.md)). The audit row is the durable signal; the soft-delete is the queryable state.
4. **Monotone sequence per workspace.** The `(workspace_id, sequence)` unique index in §5.5 is the structural barrier. Any reader can detect a gap; any writer that observes a sequence collision MUST `ROLLBACK` and re-issue.

Evidence-manifest-borne audit rows inherit append-only from [`packages/keiko-evidence/src/persist.ts`](../../packages/keiko-evidence/src/persist.ts) (atomic O_EXCL writes, never overwriting an existing run id).

## 10. Workspace scope

Every audit row carries `workspaceId`. Every read API filters by workspace before any other clause. The structural barriers:

1. **Schema-level.** `workspace_id` is `NOT NULL` in `relationship_audit_entries`.
2. **Index-level.** Every read index in §5.5 is keyed by `workspace_id` first. A scan without a workspace filter is rejected at the route layer (per [api-contract.md §4.3](api-contract.md) "bare list" prohibition).
3. **Cross-workspace denial.** The `denied/cross-workspace` payload (per §4.6) records the side but not the id.
4. **Health-check pass scope.** Health passes iterate per workspace; a single pass never crosses workspaces.

Acceptance: every audit row is filterable by `workspaceId` and unreachable to readers without that scope.

## 11. References

- [activity-state.md](activity-state.md), [evidence-references.md](evidence-references.md), [retention-and-privacy.md](retention-and-privacy.md), [audit-activity-checklist.md](audit-activity-checklist.md)
- [taxonomy.md](taxonomy.md), [lifecycle.md](lifecycle.md), [denial-reasons.md](denial-reasons.md), [architecture.md](architecture.md), [api-contract.md](api-contract.md), [storage.md](storage.md)
- [security-checklist.md](security-checklist.md), [audit.md](audit.md), [gap-analysis.md](gap-analysis.md), [reuse-matrix.md](reuse-matrix.md)
- [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md)
- [`packages/keiko-contracts/src/memory-audit-events.ts`](../../packages/keiko-contracts/src/memory-audit-events.ts), [`packages/keiko-contracts/src/evidence.ts`](../../packages/keiko-contracts/src/evidence.ts), [`packages/keiko-contracts/src/harness.ts`](../../packages/keiko-contracts/src/harness.ts)
- [`packages/keiko-security/src/redaction.ts`](../../packages/keiko-security/src/redaction.ts), [`packages/keiko-security/src/secrets.ts`](../../packages/keiko-security/src/secrets.ts)
- [`packages/keiko-evidence/src/build.ts`](../../packages/keiko-evidence/src/build.ts), [`packages/keiko-evidence/src/persist.ts`](../../packages/keiko-evidence/src/persist.ts)
- [`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts)
- [`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#536](https://github.com/oscharko-dev/Keiko/issues/536).
