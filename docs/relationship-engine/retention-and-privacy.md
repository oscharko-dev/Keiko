# Epic #532 — Retention, Redaction, and Privacy Contract

Status: Wave 3 deliverable for [issue #536](https://github.com/oscharko-dev/Keiko/issues/536) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [audit-events.md](audit-events.md), [activity-state.md](activity-state.md), [evidence-references.md](evidence-references.md), [audit-activity-checklist.md](audit-activity-checklist.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md).

Date: 2026-06-06.

## 1. Purpose

This document is the bounding contract for retention, redaction, and privacy across the three relationship persistence surfaces: the `relationships` table, the `relationship_audit_entries` table, and the `EvidenceManifest.relationships?` section. It also locks the zero-persistence rule for `RelationshipActivity` state, the local-only data-flow rule, and the privacy invariant that activity visualization is **presentation of existing redacted state**, never a new telemetry stream.

No new database, no new package, no new third-party dependency.

## 2. Local-only invariant

### 2.1 Statement

All relationship audit rows, all relationship evidence references, and all relationship activity state **remain on the local Keiko runtime**. None of these surfaces is shipped to a remote endpoint, a cloud service, an analytics pipeline, a usage telemetry collector, or a third-party logging sink.

This restates and extends the existing Keiko runtime contract at [`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md). Specifically:

- The UI-persistence SQLite database (which holds `relationships` and `relationship_audit_entries`) is local-only per the contract document.
- The evidence directory (which holds `EvidenceManifest` files including the new `relationships?` section) is local-only per the contract document.
- The activity-derivation in-memory state lives in the same process as the BFF and never leaves it.

### 2.2 Structural barriers

1. **No new outbound network code path.** The relationship engine code is permitted to import `node:sqlite` and `node:fs` (per [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md)) and nothing else from the network/IO surface. It does NOT import `node:http`, `node:https`, `node:net`, or any provider SDK.
2. **No new analytics endpoint.** The audit row write path goes to local SQLite; the evidence write path goes to the existing local store ([`packages/keiko-evidence/src/persist.ts:39`](../../packages/keiko-evidence/src/persist.ts)). There is no `fetch` call anywhere in the relationship engine.
3. **No third-party logger.** Audit summaries are written to the SQLite `summary` column; they are NOT shipped to a remote log aggregator. The existing in-process logging conventions apply (stderr only for operator-visible warnings; no PII).
4. **No SSE leak.** The SSE activity stream at `GET /api/relationships/events` (per [api-contract.md §4.11](api-contract.md)) is served by the local BFF over the local socket; the BFF is single-process and bound to localhost or a unix socket per the existing deployment shape.

## 3. Retention

The three durable surfaces have bounded retention. The activity state has zero retention.

### 3.1 `relationships` table

Per [storage.md §5](storage.md):

- `DELETE` is a **soft delete** to `lifecycle = "revoked"`. The row is retained.
- The retention sweep MAY evict `revoked` rows older than the threshold.
- **Default threshold**: `maxRevokedRows: 50000` per workspace.
- **Always-keep-newest**: the most recent `revoked` row per `(source, target, type)` is never evicted while either endpoint is still live.
- **Evidence pin**: a `revoked` row is never evicted while any non-retired `EvidenceManifest.relationships?` entry names it (per [evidence-references.md §5](evidence-references.md)).

### 3.2 `relationship_audit_entries` table

Per [audit-events.md §5.5](audit-events.md):

- The table grows in monotone `(workspace_id, sequence)` order.
- **Default retention**: `maxAuditEntriesPerWorkspace: 100000`. Oldest-archived-first eviction.
- **Always-keep-newest-per-relationship**: the most recent audit row per `(workspace_id, relationship_id, kind)` is never evicted while the underlying `relationships` row exists (active or revoked).
- **Denial events**: `relationship.validation-denied` and `relationship.policy-denied` have no `relationship_id`. They are evicted purely by age (oldest first beyond the cap).
- **Health findings**: `relationship.health-finding` is evicted purely by age except for the most-recent finding per relationship.
- The sweep is bounded per request: it never evicts more than 1024 rows per pass; subsequent passes continue.
- The sweep emits a structural `retention:evicted` ledger entry to operator-visible logs (counts only, no row content).

### 3.3 `EvidenceManifest.relationships?` section

Per [evidence-references.md §5.4](evidence-references.md):

- The section is part of the parent `EvidenceManifest` and inherits the manifest's retention.
- Default retention is `DEFAULT_RETENTION: { maxRuns: 50 }` ([`packages/keiko-contracts/src/evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)).
- The manifest is never partially evicted; the entire manifest is retained or evicted as a unit by `applyRetention` ([`packages/keiko-evidence/src/persist.ts:57`](../../packages/keiko-evidence/src/persist.ts)).
- A relationship `revoked` row is pinned until the **last** referencing manifest ages out (per §3.1 and [evidence-references.md §5](evidence-references.md)).

### 3.4 `RelationshipActivity` state

- **Retention: ZERO.**
- The derivation is in-memory only. Process exit drops the state.
- Restart re-derives from the durable sources (the `relationships.lifecycle` column, the `relationship_audit_entries` table, the live harness event stream).
- No snapshot of activity state is ever serialised.

State this loudly because it is the privacy lever: an attacker who reads the local SQLite file or the evidence directory cannot recover an activity history. The history does not exist.

### 3.5 Tombstone retention coupling

Tombstone rows (the `revoked` lifecycle bearing the `relationship.deleted` audit row, per [audit-events.md §4.3](audit-events.md)) are retained **until linked evidence retention also elapses**. This is the structural barrier against dangling refs:

```
relationships.lifecycle = "revoked"
  ⨉  evicted only when
       (no non-retired EvidenceManifest references the relationship_id)
       AND
       (count(revoked rows per workspace) > maxRevokedRows)
       AND
       (this row is not the most recent revoked row per (source,target,type)
        with either endpoint still live)
```

The conjunction is conservative on purpose; over-retention is preferable to a broken audit trail. Operators concerned about long-term growth tune `maxRevokedRows` rather than relaxing the conjunction.

## 4. Redaction

### 4.1 Single-redactor rule

Every persisted relationship payload field — `relationships.summary`, `relationship_audit_entries.summary`, `relationship_audit_entries.payload_json`, every nested string in `EvidenceManifest.relationships?` — passes through the existing redactor pipeline at the persist boundary. The pipeline is:

1. `createAuditRedactor(config, env)` ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)) constructs a redactor closure over the union of additional secrets, env-value secrets, and configured `sensitiveLiterals`.
2. `deepRedactStrings(value, redact)` ([`packages/keiko-security/src/redaction.ts:114`](../../packages/keiko-security/src/redaction.ts)) re-applies the redactor over every string leaf.
3. Both calls are idempotent ([`packages/keiko-security/src/redaction.ts:111`](../../packages/keiko-security/src/redaction.ts)).

No new redactor, no new regex, no new secret detector.

### 4.2 Secret-shape patterns

The built-in patterns at [`packages/keiko-security/src/redaction.ts:15`–`32`](../../packages/keiko-security/src/redaction.ts) catch:

- `Bearer <token>` and `Basic <credential>` (`BEARER_PATTERN`, `BASIC_AUTH_PATTERN`);
- OpenAI-shaped keys (`API_KEY_PATTERN`);
- GitHub tokens, AWS access keys, Slack tokens, Google API keys, PEM private-key blocks (`BUILTIN_PATTERNS`);
- generic `x-api-key:` headers and `api_key=` assignments.

Per [`packages/keiko-security/src/secrets.ts`](../../packages/keiko-security/src/secrets.ts):

- `keikoApiKeySecretValues(env)` collects KEIKO*DEFAULT_API_KEY and KEIKO_MODEL*\*\_API_KEY **values** (never names);
- the caller passes the collected values into the redactor's `additionalSecrets`.

The relationship engine inherits this discipline at the persist boundary; it adds nothing.

### 4.3 Redaction-state column

The `relationship_audit_entries.redaction_state` column records which redaction passes ran:

- `"redacted-on-write"` — the sibling-table path; the redactor runs exactly once before the SQL `INSERT`.
- `"redacted-on-write-and-persist"` — the evidence-manifest path; the builder is redacted-by-construction and the persist-time `deepRedactStrings` re-runs as defense-in-depth.

A test (per [audit-activity-checklist.md](audit-activity-checklist.md)) asserts that no row reaches the table with an unexpected `redaction_state`.

### 4.4 What the redactor does NOT do

The redactor is a string-level scrubber. It cannot:

- detect a secret embedded in a numeric field (we use bounded integers / floats, not numeric secrets);
- detect a secret embedded in a non-string JSON value (we never store binary secrets in `payload_json`);
- detect customer-supplied PII that is not credential-shaped (this is what the FORBIDDEN list in [audit-events.md §8.3](audit-events.md) is for — the boundary refuses such fields by construction).

The redactor is a last-line scrubber. The structural ban on FORBIDDEN fields at the type level is the first line.

## 5. Privacy invariants

### 5.1 Activity is presentation, not telemetry

This is the load-bearing invariant for issue #541's UI deliverable:

> Activity visualization is the rendered projection of state that already exists in redacted form. The activity layer introduces no new telemetry stream, no new persisted record, no new event vocabulary, no remote sink.

Restated:

- The activity layer **reads** durable rows from `relationships.lifecycle` and `relationship_audit_entries`.
- The activity layer **subscribes** to the in-process harness/workflow/bug event streams (already body-free per [audit-events.md §8.3](audit-events.md)).
- The activity layer **derives** the nine activity states from those inputs (per [activity-state.md §3](activity-state.md)).
- The activity layer **emits** body-free SSE messages on the local socket.
- The activity layer **never** writes, never persists, never sends remotely.

A future "let's collect anonymised activity counts for usage analysis" suggestion is **out of scope** of this contract and would require a new ADR superseding the relevant clauses here. Today: no.

### 5.2 No PII at any persistence layer

The FORBIDDEN list at [audit-events.md §8.3](audit-events.md) bans customer data and PII at the row-shape level. In addition:

- **Actor identity** is opaque (`actor.redactedActorId` per [audit-events.md §4](audit-events.md)). The mapping from a human operator to the opaque id lives in the workspace's identity layer, not in the relationship engine.
- **Endpoint ids** are opaque per-workspace identifiers. They are not user emails, GitHub usernames, file system paths outside the workspace, or any other externally-meaningful identifier.
- **Workspace ids** are opaque per the existing workspace conventions ([ADR-0029](../adr/ADR-0029-workspace-object-registry.md)).

### 5.3 Cross-workspace existence non-disclosure

A reader in workspace A MUST NOT be able to confirm that an identifier exists in workspace B. The relevant rules from earlier docs are restated here for completeness:

- The validator may detect a `denied/cross-workspace` proposal but the audit row records no offending id (per [audit-events.md §4.6](audit-events.md)).
- The read API filters by workspace before any other clause (per [audit-events.md §10](audit-events.md)).
- An evidence ref cannot point across workspaces (per [evidence-references.md §4](evidence-references.md)).

### 5.4 Bounded-cardinality leakage

A truncated impact-analysis result (per [audit-events.md §4.8](audit-events.md)) records the **count** of nodes observed, never the ids. A high-throughput activity badge (per [activity-state.md §5.4](activity-state.md)) records the **count** of events, never the ids. Bounded cardinality is the privacy lever: an attacker observing counts learns aggregate behaviour but not individual events.

### 5.5 Determinism vs. privacy

A determinism property is desirable for testing (same inputs ⇒ same activity state per [activity-state.md §8](activity-state.md)). It does NOT imply the activity state is sensitive to inputs that the audit rows have already redacted: the derivation reads only redacted durable inputs and body-free live events. There is no leak channel via determinism.

## 6. Cross-cutting invariants

1. **Three durable surfaces** (`relationships`, `relationship_audit_entries`, `EvidenceManifest.relationships?`); one transient surface (`RelationshipActivity`).
2. **Local-only.** §2.
3. **Bounded retention with always-keep-newest pinning.** §3.1, §3.2. **Zero retention for activity.** §3.4.
4. **Tombstones outlive linked evidence.** §3.5.
5. **Single redactor, idempotent, run at the persist boundary.** §4.
6. **Activity is presentation.** §5.1.
7. **No PII, no cross-workspace existence, no cardinality leak.** §5.2, §5.3, §5.4.

## 7. Verification hooks (for #543 hardening pass)

The hardening issue [#543] is expected to add the structural tests that verify this contract. Concretely:

- A redaction-before-persist test: every audit-row writer is called with a payload containing a known-shaped secret; the persisted row does not contain the secret.
- An append-only enforcement test: an `UPDATE` against `relationship_audit_entries` from non-migration code fails.
- A workspace-scope filter test: a reader in workspace A receives 0 rows for workspace B.
- A FORBIDDEN-field reject test: an audit-row writer that attempts to set a forbidden field at the type level fails the type check; at runtime, the call site that would carry one is unreachable.
- A retention-coupling test: a `revoked` row whose evidence manifest is still retained is NOT evicted.
- An activity-zero-persistence test: there is no `fs.write*` or `db.prepare("INSERT").run(...)` reachable from the activity-derivation module's import graph.
- An accessibility test: the activity badge is announced by the assistive-technology test harness without color or motion (per [activity-state.md §6](activity-state.md)).

Issue [#543](https://github.com/oscharko-dev/Keiko/issues/543) owns the actual tests; this section names the contract slots.

## 8. References

- [audit-events.md](audit-events.md), [activity-state.md](activity-state.md), [evidence-references.md](evidence-references.md), [audit-activity-checklist.md](audit-activity-checklist.md)
- [lifecycle.md](lifecycle.md), [storage.md](storage.md), [api-contract.md](api-contract.md), [security-checklist.md](security-checklist.md), [denial-reasons.md](denial-reasons.md)
- [`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md), [`docs/security-and-audit-boundaries.md`](../security-and-audit-boundaries.md)
- [`packages/keiko-security/src/redaction.ts`](../../packages/keiko-security/src/redaction.ts), [`packages/keiko-security/src/secrets.ts`](../../packages/keiko-security/src/secrets.ts)
- [`packages/keiko-evidence/src/persist.ts`](../../packages/keiko-evidence/src/persist.ts)
- [`packages/keiko-contracts/src/evidence.ts`](../../packages/keiko-contracts/src/evidence.ts)
- [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#536](https://github.com/oscharko-dev/Keiko/issues/536).
