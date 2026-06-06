# Epic #532 — Relationship Engine Security Checklist

Status: Wave 3 deliverable for [issue #535](https://github.com/oscharko-dev/Keiko/issues/535) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [architecture.md](architecture.md), [api-contract.md](api-contract.md), [storage.md](storage.md), [taxonomy.md](taxonomy.md), [denial-reasons.md](denial-reasons.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md).

Date: 2026-06-06.

## 1. Purpose

This document is the security-review checklist that implementers of issues [#538](https://github.com/oscharko-dev/Keiko/issues/538) – [#542](https://github.com/oscharko-dev/Keiko/issues/542) MUST verify before opening a PR. Each item is binary: it can be checked off or it cannot. Failure to satisfy any item is a PR blocker and an explicit reviewer escalation point.

The checklist is normative. New items are added by ADR amendment, never by silent insertion at review time.

## 2. Scope filtering

| #   | Item                                                                                                                                                                              | Reviewer verifies                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every SQL `SELECT`, `UPDATE`, and `DELETE` against `relationships` filters by `workspace_scope_id` (plus the caller's resolved scope set).                                        | grep the relationships handler module; absence of an unfiltered query is the proof.                                                     |
| 2   | Every relationship API route resolves the caller's scope from the request context before any DB call.                                                                             | the handler reads `deps.scopeResolver(request)` (or equivalent) and rejects with `relationship/scope-not-permitted` (HTTP 403) on miss. |
| 3   | A relationship created in workspace A is **invisible** to a caller resolved to workspace B. There is a test for this.                                                             | test in `packages/keiko-server/src/relationship-handlers.test.ts` (issue #539).                                                         |
| 4   | The bounded-query contract is enforced server-side: `limit > 256`, `maxDepth > 3`, `maxNodes > 1024`, `maxRelationships > 2048` all return `relationship/bounded-query-exceeded`. | tests assert the four caps.                                                                                                             |
| 5   | A bare `GET /api/relationships` (no selective parameter) returns 400 with `relationship/bounded-query-required`.                                                                  | test asserts the 400 response.                                                                                                          |
| 6   | The dependency-walk and impact routes never exceed their declared budget; truncation is reported in-band via `truncated: true` and out-of-band via `X-Truncated`.                 | tests construct a graph that exceeds `maxNodes` and assert the truncation contract.                                                     |
| 7   | The health route is paginated; a single call returns at most `limit` entries (default 64, max 256).                                                                               | test asserts the pagination shape.                                                                                                      |

## 3. Redaction

| #   | Item                                                                                                                                                                              | Reviewer verifies                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every response body passes through `deepRedactStrings` from [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts) before serialization. | the handler's last operation before `res.end()` is `deepRedactStrings(body)`.                                              |
| 2   | Every persisted `summary` string passes through `deepRedactStrings` at the persist boundary.                                                                                      | the store layer's `INSERT` / `UPDATE` path applies the redactor inside the transaction.                                    |
| 3   | Every SSE event payload passes through `deepRedactStrings` at emit.                                                                                                               | the SSE writer applies the redactor before `res.write(`data: ...`)`.                                                       |
| 4   | No new redactor is introduced. The same `createAuditRedactor` factory is the chokepoint.                                                                                          | grep for new `redact` / `scrub` / `sanitize` factories in the relationship modules; absence is the proof.                  |
| 5   | A relationship row whose `summary` is engineered to look like an API key (e.g., `ghp_` prefix + 36 chars) returns a redacted string at the wire boundary.                         | test in `relationship-handlers.test.ts` asserts the scrub.                                                                 |
| 6   | The redactor runs idempotently on inputs that have already been redacted (no double-redaction artefacts).                                                                         | the redactor's idempotency invariant is already documented; the test re-runs it on a redacted string and asserts equality. |

## 4. Payload-content invariant

| #   | Item                                                                                                                                                                   | Reviewer verifies                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | The contract layer's `Relationship` record has no field for body content, prompts, document excerpts, tool stdout / stderr / argument values, patch hunks, or secrets. | grep the contracts module; the field set matches [taxonomy.md §12](taxonomy.md) exactly. |
| 2   | The SQL schema has no column for the above (see [storage.md §3](storage.md)).                                                                                          | grep `schema.ts` for the V5 DDL; the column list matches the documented set.             |
| 3   | The validator rejects with `denied/payload-content-not-permitted` when a client submits a body containing fields outside the closed set.                               | test asserts the rejection.                                                              |
| 4   | The activity event envelope carries `relationshipId`, `kind`, `occurredAt`, `scope`, optional `summary` — nothing more.                                                | test asserts the on-wire envelope shape.                                                 |
| 5   | The audit-entry envelope is body-free per [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts).                                    | test asserts the audit-entry shape.                                                      |

## 5. Validator purity and determinism

| #   | Item                                                                                                                                                                                                      | Reviewer verifies                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | The validator function is **pure** with respect to its inputs. It does not import `node:fs`, `node:net`, `node:child_process`, `keiko-model-gateway`, `keiko-tools` runtime modules, or any provider SDK. | grep imports; absence is the proof.                                                                         |
| 2   | The validator is **deterministic**: identical inputs yield identical outputs. There is a test that runs the validator twice over the same input and asserts equality.                                     | test in `packages/keiko-contracts/src/relationship-validator.test.ts` (issue #538).                         |
| 3   | The validator returns reasons in the order specified by [denial-reasons.md §"Resolution order"](denial-reasons.md).                                                                                       | test asserts the order on a multi-failure input.                                                            |
| 4   | The validator runs **inside** the same SQL transaction as the mutation (per [storage.md §4.1](storage.md)).                                                                                               | grep the handler; the `BEGIN` precedes the validator call and the `COMMIT` follows the `INSERT` / `UPDATE`. |
| 5   | The validator never short-circuits a structural identity prelude (non-existent endpoint, unknown forward-looking kind) — it surfaces the reason and stops further evaluation.                             | test asserts the early-stop behaviour on these specific codes.                                              |

## 6. Endpoint resolver

| #   | Item                                                                                                                                                                          | Reviewer verifies                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Each endpoint kind has exactly one `RelationshipEndpointResolver` implementation, owned by the owning package.                                                                | grep each owning package for the implementation; the relationship engine imports them via the deps. |
| 2   | A resolver MUST NOT resurrect, hide, or mutate the underlying record. Resolvers are read-only.                                                                                | code review; the resolver method signature returns `EndpointLiveness` only.                         |
| 3   | A resolver that touches the filesystem goes through `assertContainedRealPath` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)). | grep the `workspace-path` resolver for `assertContainedRealPath`; absence is a failure.             |
| 4   | A resolver never returns endpoint content. Only `{ status, optional timestamps, optional short reason }`.                                                                     | the `EndpointLiveness` discriminated union has no content field.                                    |
| 5   | A resolver's call is bounded — no recursion, no model call, no shell command, no network I/O.                                                                                 | code review; the resolver body is plain DB or cached state read.                                    |

## 7. Idempotency and concurrency

| #   | Item                                                                                                                                                                                                         | Reviewer verifies                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --------------------------- | ------------------------------------------ |
| 1   | Every POST / PATCH / DELETE rejects a missing `Idempotency-Key` with `relationship/idempotency-key-required`.                                                                                                | test.                                                                                                                                    |
| 2   | A replay with a divergent body returns `relationship/idempotency-replay-mismatch` (HTTP 409). The current implementation hashes the raw JSON request body deterministically before comparing cached replays. | test.                                                                                                                                    |
| 3   | The current POST replay cache TTL is 10 minutes and the capacity is 1024. A cache eviction does not corrupt the response of a concurrent in-flight request.                                                  | code review; the cache is process-local and synchronised.                                                                                |
| 4   | Every PATCH / DELETE rejects a missing `If-Match` with `relationship/optimistic-concurrency-required` (HTTP 428).                                                                                            | test.                                                                                                                                    |
| 5   | An `If-Match` mismatch returns `relationship/optimistic-concurrency-conflict` (HTTP 412) using the standard redacted error envelope.                                                                         | test.                                                                                                                                    |
| 6   | The etag is monotonic per row: `printf('%016x', updated_at)                                                                                                                                                  |                                                                                                                                          | '-' |     | lower(hex(randomblob(3)))`. | grep the store layer for the etag formula. |
| 7   | The `UNIQUE` partial indexes on `produces-evidence` (source) and `starts-workflow` (target) prevent double-write at the DB level.                                                                            | test: a second `produces-evidence` for the same source returns the DB-level uniqueness error, surfaced as `denied/cardinality-exceeded`. |

## 8. Audit obligations

| #   | Item                                                                                                                                                                                   | Reviewer verifies                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Every mutation emits the activity event(s) listed in [api-contract.md §9](api-contract.md).                                                                                            | tests assert event emission on POST / PATCH / DELETE.                        |
| 2   | Every denied mutation emits a `relationship:rejected` event (per [denial-reasons.md §"Catalog"](denial-reasons.md): every `denied/*` has audit-event implication).                     | test asserts emission on denial.                                             |
| 3   | The audit row's existence and the relationship row's state are atomic: either both present or both absent.                                                                             | code review; the transactional ordering follows [storage.md §4](storage.md). |
| 4   | The audit entry carries no payload (per §4 above).                                                                                                                                     | code review.                                                                 |
| 5   | The audit entry's `initiatorSurface` is one of the closed `MemoryAuditInitiatorSurface` values from [`memory-operations.ts`](../../packages/keiko-contracts/src/memory-operations.ts). | code review.                                                                 |

## 9. Trust-boundary composition

| #   | Item                                                                                                                                                                                                           | Reviewer verifies                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | The relationship engine does not import any provider SDK. `arch:check` rule 3a is the existing enforcement.                                                                                                    | `npm run arch:check` is green.                                                                      |
| 2   | The relationship engine does not import `keiko-tools` runtime modules. (Contract types only, where strictly required.)                                                                                         | grep imports; `keiko-tools` types ok, runtime functions not.                                        |
| 3   | The relationship engine does not call `runCommand`, `child_process`, `node:net`, `node:dgram`, `node:tls`, or `fetch` directly.                                                                                | grep; absence is the proof.                                                                         |
| 4   | The relationship engine does not write to `memory_edges`, `memories`, `evidence_*`, or any vault or evidence table. Its only write surface is the `relationships` and `relationship_lifecycle_history` tables. | grep the store layer; only the two table names appear in `INSERT` / `UPDATE` / `DELETE` statements. |
| 5   | The UI inspector / graph view declares its `WindowsRegistry` descriptor with `trustBoundary: ["ui", "memory", "evidence"]` (no `model`, no `tool`, no `network`).                                              | ADR-0029 validator passes; descriptor is part of issue #540's PR.                                   |
| 6   | The UI never re-fetches raw endpoint content. The inspector renders only the redacted server response.                                                                                                         | code review of the inspector component.                                                             |

## 10. Path containment

| #   | Item                                                                                                                                                                                                                      | Reviewer verifies                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Every `workspace-path` endpoint in every API route passes through `assertContainedRealPath` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)) **before** the validator runs. | grep the handler; the call precedes the validator.                                     |
| 2   | A path that matches `DEFAULT_DENY_PATTERNS` ([`packages/keiko-workspace/src/ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts)) is rejected with `denied/path-not-contained`.                                    | test.                                                                                  |
| 3   | A path that escapes containment (e.g., `../../etc/passwd`, an absolute path, a symlink to outside the workspace) is rejected.                                                                                             | tests for each escape pattern.                                                         |
| 4   | The realpath chokepoint is the **only** path validator; no parallel validator is introduced in the relationship engine.                                                                                                   | grep the relationship modules for new path-validation functions; absence is the proof. |

## 11. Schema and migration

| #   | Item                                                                                                                                                                                                        | Reviewer verifies                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | The V5 migration is additive and idempotent; running it twice is a no-op.                                                                                                                                   | the migration runner is the existing `PRAGMA user_version` runner; idempotency is its invariant. |
| 2   | The `CHECK` constraints on `relationships.schema_version`, `type`, `lifecycle`, `scope_kind`, `source_kind`, `target_kind`, `created_at`, `updated_at`, `confidence`, `summary` are present and exhaustive. | grep the V5 SQL.                                                                                 |
| 3   | The `UNIQUE` partial indexes for `produces-evidence` (source) and `starts-workflow` (target) are present.                                                                                                   | grep the V5 SQL.                                                                                 |
| 4   | The indexes cover every documented query route from [storage.md §3.3](storage.md).                                                                                                                          | grep + a hand-walk of the routes.                                                                |
| 5   | The corrupt-DB quarantine flow inherits unchanged from the existing UI-persistence store ([`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts)).                          | code review.                                                                                     |

## 12. Retention

| #   | Item                                                                                                                                                              | Reviewer verifies                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | DELETE is a soft delete: the row transitions to `lifecycle = 'revoked'` and is **not** removed from the table.                                                    | test asserts row count before / after DELETE.               |
| 2   | The retention sweep never deletes a `revoked` row that still appears in a non-retired `EvidenceManifest.relationships?` section.                                  | test asserts the evidence-reference invariant (issue #543). |
| 3   | The retention sweep evicts the oldest `revoked` rows first; the most recent `revoked` row per `(source, target, type)` is retained while either endpoint is live. | test.                                                       |
| 4   | The lifecycle history is bounded to 32 rows per relationship; the sweep evicts oldest-first.                                                                      | test.                                                       |

## 13. Cross-cutting

| #   | Item                                                                                                                                                                                                                                                                           | Reviewer verifies                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | No new third-party dependency. `package.json` files outside the relationship-engine modules are unchanged.                                                                                                                                                                     | `git diff` against the integration base; the only `package.json` changes are version bumps for the existing packages (if any). |
| 2   | No new credential surface. No new env var pattern. No new file path for secrets.                                                                                                                                                                                               | code review.                                                                                                                   |
| 3   | All new regex (if any) is linear-character-class + single-quantifier per the CodeQL `js/polynomial-redos` gate documented in [`packages/keiko-security/src/redaction.ts`](../../packages/keiko-security/src/redaction.ts).                                                     | CodeQL pass in CI.                                                                                                             |
| 4   | All new TypeScript respects `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. The "absent vs. null" idiom from [`packages/keiko-memory-vault/src/edges.ts:42`](../../packages/keiko-memory-vault/src/edges.ts) is applied to optional columns. | typecheck pass.                                                                                                                |
| 5   | All ESM, no CJS shims. `keiko-contracts` remains a leaf per [ADR-0019](../adr/ADR-0019-modular-package-architecture.md) and [`boundary.test.ts`](../../packages/keiko-contracts/src/boundary.test.ts).                                                                         | `npm run arch:check` is green.                                                                                                 |
| 6   | The relationship engine does not depend on a graph DB, a graph layout library, a state management library, or any other new package. The visualization uses the existing `ConnectionsLayer.tsx` / `connector-graph.tsx` patterns.                                              | code review.                                                                                                                   |
| 7   | No console.log, debugger, or commented-out code in production sources.                                                                                                                                                                                                         | code review.                                                                                                                   |

## 14. Test obligations summary

Implementers of #538 – #542 collectively MUST land:

- Unit tests for every validator branch (every `denied/*` code has at least one positive and one negative case).
- Integration tests for every API route (every error code from [api-contract.md §10](api-contract.md) has a test).
- A scope-isolation test (one workspace's rows invisible to another workspace's caller).
- A redactor wire-boundary test (secret-shaped `summary` returns scrubbed).
- A cardinality-conflict test (DB-level `UNIQUE` partial index fires).
- A bounded-walk test (impact analysis truncates and reports the cap).
- An evidence-reference retention test (issue #543).
- A migration idempotency test (V5 applies once, runs again, no-op).

## 15. Escalation triggers

Any PR that proposes any of the following STOPS for explicit reviewer approval, with the trigger named:

- A new third-party dependency.
- A new credential surface or env var.
- A new database file or persistence backend.
- A new arch:check or dependency-cruiser rule.
- A change to `keiko-security/redaction.ts` or any new redactor.
- Removing or narrowing a `CHECK` constraint on the relationship schema.
- Removing or narrowing a `UNIQUE` partial index on the relationship schema.
- A schema version bump (`"1"` → `"2"`).
- A change that grants a privilege based on relationship existence (forbidden by [taxonomy.md §2](taxonomy.md)).

## 16. References

- [architecture.md](architecture.md), [api-contract.md](api-contract.md), [storage.md](storage.md)
- [taxonomy.md](taxonomy.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md), [compatibility-matrix.md](compatibility-matrix.md)
- [gap-analysis.md](gap-analysis.md), [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [adr-candidates.md](adr-candidates.md)
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#535](https://github.com/oscharko-dev/Keiko/issues/535).
