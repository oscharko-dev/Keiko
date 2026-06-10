# Epic #532 — Relationship Lifecycle State Machine

Status: Wave 2 deliverable for [issue #534](https://github.com/oscharko-dev/Keiko/issues/534) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md).

Issue date: 2026-06-06.

## Purpose

This document specifies the lifecycle state machine for a `Relationship` record: the closed set of states, the legal transitions between them, which side authorises each transition, which transitions emit audit events, which transitions create or revoke evidence references, and which `RelationshipActivity` event each transition emits on the live activity stream.

The state machine binds issues [#535](https://github.com/oscharko-dev/Keiko/issues/535) (storage + policy), [#536](https://github.com/oscharko-dev/Keiko/issues/536) (audit / activity model), [#538](https://github.com/oscharko-dev/Keiko/issues/538) (deterministic validator), and [#539](https://github.com/oscharko-dev/Keiko/issues/539) (BFF APIs).

## 1. States

The closed lifecycle state set is restated from [taxonomy.md §6.1](taxonomy.md):

```
type RelationshipLifecycle =
  | "draft"
  | "active"
  | "archived"
  | "superseded"
  | "revoked"
  | "blocked"
  | "stale";
```

| State        | Description                                                                                                                                                                                                                                                                                             | Query visibility (default)                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `draft`      | A proposal that has not yet been validated or that is awaiting an upstream gate. The record exists in the relationship store but does not yet participate in impact analysis or health checks.                                                                                                          | Hidden from default queries; visible in inspector for the originating surface only. |
| `active`     | Validated, committed, both endpoints currently live. The default queryable state.                                                                                                                                                                                                                       | Visible.                                                                            |
| `archived`   | Preserved for audit but no longer participates in queries by default. Operators may archive an active relationship to declutter without losing audit history.                                                                                                                                           | Hidden by default; visible on `?includeArchived=true`.                              |
| `superseded` | Replaced by a newer relationship of the same type with a related (typically renamed) target. The supersedence is recorded by a `relationship:superseded` event whose payload names the replacement id.                                                                                                  | Hidden by default; visible on `?includeSuperseded=true`.                            |
| `revoked`    | Explicitly rejected after a proposal or retracted after acceptance. Terminal.                                                                                                                                                                                                                           | Hidden by default.                                                                  |
| `blocked`    | The validator (or the endpoint resolver) returned a `denied/*` reason; the record is parked. Operators may inspect the reason and either fix the upstream cause or revoke.                                                                                                                              | Hidden by default; visible in inspector.                                            |
| `stale`      | Engine-side derived state: at least one endpoint is `tombstoned`, `retired`, or `unavailable`. The relationship row remains for audit but its target / source is no longer live. The state is computed by the health-check pass (per [gap-analysis.md Gap 9](gap-analysis.md)) and updated server-side. | Visible with a `stale` badge.                                                       |

## 2. Transition table (diagram-as-table)

`→` indicates a legal transition. `denied/lifecycle-illegal-transition` is returned for any pair not in this table.

| From \ To    | `draft`                       | `active`                          | `archived`                           | `superseded`             | `revoked`                               | `blocked`                                    | `stale`                                 |
| ------------ | ----------------------------- | --------------------------------- | ------------------------------------ | ------------------------ | --------------------------------------- | -------------------------------------------- | --------------------------------------- |
| `draft`      | (no-op)                       | → (validator commits)             | → (operator archives draft)          | →                        | → (proposal rejected)                   | → (validator denies; reason recorded)        | →                                       |
| `active`     | denied                        | (no-op)                           | → (operator archives)                | → (renamed / replaced)   | → (operator retracts)                   | denied                                       | → (health check flags stale)            |
| `archived`   | denied                        | denied                            | (no-op)                              | →                        | → (operator hard-retracts archived row) | denied                                       | → (endpoint goes away while archived)   |
| `superseded` | denied                        | denied                            | denied                               | (no-op)                  | denied                                  | denied                                       | → (endpoint goes away while superseded) |
| `revoked`    | denied                        | denied                            | denied                               | denied                   | (no-op)                                 | denied                                       | denied                                  |
| `blocked`    | → (validator condition fixed) | → (validator re-runs and accepts) | → (operator archives blocked record) | denied                   | → (operator gives up)                   | (no-op; multiple denial reasons may accrete) | →                                       |
| `stale`      | denied                        | → (endpoint returns to live)      | → (operator archives stale)          | → (replaced by new edge) | → (operator retracts stale)             | denied                                       | (no-op)                                 |

Terminal states: `revoked` is terminal (no outbound transitions). `superseded` is effectively terminal (only `stale` follows it, and only because an endpoint went away after supersession; the relationship is not resurrected).

## 3. Per-transition rules

The columns name the load-bearing properties downstream implementers MUST honour.

| Transition              | Server-authoritative? | Emits audit event? | Emits activity event                       | Touches evidence?                                                                                                           | Notes                                                                                                            |
| ----------------------- | --------------------- | ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `draft → active`        | Yes (validator).      | Yes.               | `relationship:accepted`                    | Adds the relationship to the run's `EvidenceManifest.relationships` section (per [gap-analysis.md Gap 7](gap-analysis.md)). | The validator runs the compatibility matrix and policy evaluator; only the engine commits the transition.        |
| `draft → archived`      | Yes.                  | Yes.               | `relationship:archived`                    | None.                                                                                                                       | Operator archives a draft they no longer want; the proposal never reached `active`.                              |
| `draft → revoked`       | Yes.                  | Yes.               | `relationship:rejected`                    | None.                                                                                                                       | A proposal was rejected. Terminal.                                                                               |
| `draft → blocked`       | Yes (validator).      | Yes.               | `relationship:rejected` (with blocked tag) | None.                                                                                                                       | Validator returned ≥ 1 `denied/*` reason. The relationship parks in `blocked` so the operator can inspect.       |
| `draft → superseded`    | Yes.                  | Yes.               | `relationship:superseded`                  | None.                                                                                                                       | A draft is replaced before commit. Rare; commonly the new draft transitions directly to `active`.                |
| `draft → stale`         | Yes (health check).   | Yes.               | `relationship:impacted`                    | None.                                                                                                                       | A draft endpoint went away before commit.                                                                        |
| `active → archived`     | Yes.                  | Yes.               | `relationship:archived`                    | None.                                                                                                                       | Operator archives an active relationship.                                                                        |
| `active → superseded`   | Yes.                  | Yes.               | `relationship:superseded`                  | Updates `EvidenceManifest.relationships` section to record the replacement id.                                              | Used on document rename / replace for `references-document` relationships.                                       |
| `active → revoked`      | Yes.                  | Yes.               | `relationship:retracted`                   | Updates `EvidenceManifest.relationships` to record the retraction.                                                          | Operator-driven retraction.                                                                                      |
| `active → stale`        | Yes (health check).   | Yes.               | `relationship:impacted`                    | None (the evidence record for the run is not back-mutated; the relationship row reflects the change).                       | Triggered by the endpoint resolver returning `tombstoned`, `retired`, or `unavailable`.                          |
| `archived → superseded` | Yes.                  | Yes.               | `relationship:superseded`                  | None.                                                                                                                       | Archived relationships can be replaced by a new edge; the old archived record links to the new id.               |
| `archived → revoked`    | Yes.                  | Yes.               | `relationship:retracted`                   | None.                                                                                                                       | Operator decides an archived record must be hard-retracted (e.g. compliance).                                    |
| `archived → stale`      | Yes (health check).   | Yes.               | `relationship:impacted`                    | None.                                                                                                                       | Endpoint went away while the record was archived.                                                                |
| `superseded → stale`    | Yes (health check).   | Yes.               | `relationship:impacted`                    | None.                                                                                                                       | Endpoint went away after supersession.                                                                           |
| `blocked → draft`       | Yes.                  | Yes.               | `relationship:proposed`                    | None.                                                                                                                       | Operator fixed the upstream cause and re-drafted; the validator will re-run.                                     |
| `blocked → active`      | Yes (validator).      | Yes.               | `relationship:accepted`                    | Adds to `EvidenceManifest.relationships`.                                                                                   | The condition that caused the `denied/*` reason has been remediated; the validator re-runs and accepts.          |
| `blocked → archived`    | Yes.                  | Yes.               | `relationship:archived`                    | None.                                                                                                                       | Operator decides the blocked record is no longer worth pursuing.                                                 |
| `blocked → revoked`     | Yes.                  | Yes.               | `relationship:rejected`                    | None.                                                                                                                       | Hard rejection of a blocked draft.                                                                               |
| `blocked → stale`       | Yes (health check).   | Yes.               | `relationship:impacted`                    | None.                                                                                                                       | Endpoint went away while blocked.                                                                                |
| `stale → active`        | Yes (health check).   | Yes.               | `relationship:accepted`                    | None.                                                                                                                       | A previously stale endpoint became live again (e.g. a connector reconnects); the relationship returns to active. |
| `stale → archived`      | Yes.                  | Yes.               | `relationship:archived`                    | None.                                                                                                                       | Operator archives a stale record.                                                                                |
| `stale → superseded`    | Yes.                  | Yes.               | `relationship:superseded`                  | None.                                                                                                                       | A new edge replaces the stale one (e.g. a document was replaced; the new edge supersedes the stale old one).     |
| `stale → revoked`       | Yes.                  | Yes.               | `relationship:retracted`                   | None.                                                                                                                       | Operator hard-retracts a stale record.                                                                           |

## 4. Server-authoritative rule

Every transition in §3 is server-authoritative. The client (chat surface, inspector, controlled graph view, or workflow run) **proposes** a transition by issuing a typed BFF request (per [reuse-matrix.md row 17](reuse-matrix.md)); the engine evaluates the policy decision per [gap-analysis.md Gap 3](gap-analysis.md) and either:

1. commits the transition, persists the new lifecycle state, emits the corresponding `relationship:*` activity event, and (where §3 indicates) writes the audit-event entry into the run's `EvidenceManifest.relationships` section; or
2. returns a `RelationshipPolicyDecision` whose `reasons` array carries one or more codes from [denial-reasons.md](denial-reasons.md), and leaves the lifecycle state unchanged.

The client treats any optimistic UI state as advisory until the server's accept is observed via the SSE activity stream. SSE consumers subscribe per event-name via `addEventListener("relationship:accepted", …)` etc., per the Epic #13 event-name discipline ([audit.md §"Cross-cutting risks"](audit.md) item 8).

## 5. Activity-event mapping

This restates the `RelationshipActivityKind` family from [gap-analysis.md Gap 6](gap-analysis.md):

| `RelationshipActivityKind` | Emitted on transition(s)                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `relationship:proposed`    | new `draft` record created (no from-state); `blocked → draft`.                                                               |
| `relationship:accepted`    | `draft → active`; `blocked → active`; `stale → active`.                                                                      |
| `relationship:rejected`    | `draft → revoked`; `draft → blocked`; `blocked → revoked`.                                                                   |
| `relationship:retracted`   | `active → revoked`; `archived → revoked`; `stale → revoked`.                                                                 |
| `relationship:superseded`  | `draft → superseded`; `active → superseded`; `archived → superseded`; `stale → superseded`.                                  |
| `relationship:archived`    | `draft → archived`; `active → archived`; `blocked → archived`; `stale → archived`.                                           |
| `relationship:impacted`    | any `* → stale` transition (`draft → stale`, `active → stale`, `archived → stale`, `superseded → stale`, `blocked → stale`). |

The activity event is **body-free** ([taxonomy.md §12](taxonomy.md), [gap-analysis.md Gap 6](gap-analysis.md)) and carries: `relationshipId`, `kind`, `occurredAt`, `scope`, optional bounded `summary`. The summary is redacted by `createAuditRedactor` at emit time ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)).

## 6. Evidence-reference transitions

Two transitions create or revoke an evidence reference; all others do not change the `EvidenceManifest`:

1. `draft → active` and `blocked → active`: an entry is appended to `EvidenceManifest.relationships` (see [gap-analysis.md Gap 7](gap-analysis.md)) for the originating run. The entry is body-free and flows through `deepRedactStrings` ([`packages/keiko-security/src/redaction.ts:114`](../../packages/keiko-security/src/redaction.ts)) at persist time.
2. `active → superseded` and `active → revoked`: an entry is appended to `EvidenceManifest.relationships` recording the change. The original entry is not back-mutated; evidence manifests are append-only ([`packages/keiko-evidence/src/persist.ts`](../../packages/keiko-evidence/src/persist.ts) + the `O_EXCL` atomic-write convention at [`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts)).

`stale` transitions do **not** write to the evidence manifest. The relationship row reflects the change; the historical manifest stays authoritative for "what the run saw at the time it ran".

## 7. Health-check ownership

Transitions `* → stale` and `stale → active` are driven by the relationship health-check pass per [gap-analysis.md Gap 9](gap-analysis.md). The health check:

- is read-only against each owning domain;
- composes the endpoint-resolver port (per [gap-analysis.md Gap 2](gap-analysis.md)) for each relationship's source and target;
- runs on a bounded cadence (operator-configurable; default cadence locked by issue #535) and on operator demand;
- writes the new lifecycle state via the same server-authoritative path as operator transitions, so the audit and activity surfaces emit identical envelopes.

No client may directly set `stale` or clear it; the health-check pass is the only originator.

## 8. Cardinality and cycle enforcement at transition time

The validator re-runs cardinality and cycle checks on every `* → active` transition, not only at `draft → active`. This is to defend against:

- a `blocked → active` retry where the upstream cause was fixed but a competing relationship now occupies the 1:1 slot (`produces-evidence`, `starts-workflow` target);
- a `stale → active` recovery where a new edge inserted while the relationship was stale would now create a cycle (`depends-on`).

A failing re-check returns the relationship to `blocked` (from `draft`) or keeps it `stale` / `archived` (from any other state), with the `denied/*` reason recorded.

## 9. Cross-cutting invariants

1. **No payload mutation on transition.** Transition envelopes carry the fields listed in [taxonomy.md §6.3](taxonomy.md) only. No endpoint content, no diff bytes, no token-bearing strings.
2. **Redaction at emit.** Every audit entry and every SSE activity event flows through `createAuditRedactor` ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)) at the persist / emit boundary. No new redactor.
3. **No authority granted.** A `* → active` transition makes the relationship queryable; it does **not** grant model, tool, FS, evidence, memory, workflow, or UI authority. The non-authority invariant from [taxonomy.md §2 / §11](taxonomy.md) applies.
4. **Retention inheritance.** Transitions that write into `EvidenceManifest.relationships` inherit the run's retention via `DEFAULT_RETENTION: maxRuns: 50` ([`evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)). Relationship audit entries do not pin runs from eviction.
5. **SSE event-name discipline.** Each `RelationshipActivityKind` is enumerated in the BFF wire types so the UI subscribes per-kind. Mirrors the Epic #13 lesson ([audit.md §"Cross-cutting risks"](audit.md) item 8).
6. **Schema-version coupling.** Transitions never change a record's `schemaVersion`. A schema-version bump per [taxonomy.md §3](taxonomy.md) is the only path that may add new lifecycle states or change the legal-transition table; current schema is `"1"`.

## 10. References

- [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md)
- [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md)
- [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
- Issue: [#534](https://github.com/oscharko-dev/Keiko/issues/534). Downstream: [#535](https://github.com/oscharko-dev/Keiko/issues/535), [#536](https://github.com/oscharko-dev/Keiko/issues/536), [#538](https://github.com/oscharko-dev/Keiko/issues/538), [#539](https://github.com/oscharko-dev/Keiko/issues/539).
