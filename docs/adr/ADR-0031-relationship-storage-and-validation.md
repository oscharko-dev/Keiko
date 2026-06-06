# ADR-0031: Relationship engine — policy, validation, and storage

## Status

Proposed (Epic #532, issue #535, 2026-06-06). Locks the authority model for the semantic relationship engine: who validates, where records live, and how the engine composes with each existing Keiko trust boundary. ADR-0032 (issue #536) covers the audit / activity model; ADR-0033 (issue #537) covers the UI containment.

## Context

Epic [#532](https://github.com/oscharko-dev/Keiko/issues/532) introduces a cross-domain relationship engine that reifies edges between memories, capsules, capsule sets, workflow runs, evidence manifests, workspace paths, chats, tools, and patch proposals. The Wave 1 audit ([`docs/relationship-engine/audit.md`](../relationship-engine/audit.md)) established that every primitive the engine needs already ships in some Keiko subsystem and that a parallel substrate violates the reuse gate established by issue #529's deferral. The Wave 2 taxonomy ([`docs/relationship-engine/taxonomy.md`](../relationship-engine/taxonomy.md)) locked the closed sets for relationship type, endpoint kind, lifecycle state, and the body-free invariant.

What was still open after Wave 2:

- **Authority model**: who validates a relationship, where the validator runs, and how its decision composes with the existing trust boundaries owned by `keiko-model-gateway`, `keiko-tools`, `keiko-workspace`, `keiko-evidence`, `keiko-memory-governance`, `keiko-workflows`, and `keiko-local-knowledge`.
- **Storage ownership**: which existing Keiko persistence facility holds the relationship table, what the schema looks like, how it migrates, and how transactional invariants compose with redaction and audit.
- **API surface**: the complete HTTP contract — routes, request and response shapes, deterministic error codes, idempotency model, optimistic concurrency model, bounded-query caps.

These decisions cannot be safely inferred from the existing code or ADRs. ADR-0031 records the bindings.

## Decision

### 1. Validation is server-authoritative

The relationship validator is a pure deterministic function exported by `@oscharko-dev/keiko-contracts`. It runs **only on the server**, **inside the request handler**, and **inside the same SQL transaction** as the write. The UI may produce advisory hints (via `POST /api/relationships/validate`) but those hints are never trusted by the mutating routes.

Validator signature (binding for issue #538):

```
function validateRelationshipProposal(input: {
  readonly proposal: RelationshipProposal;
  readonly current: RelationshipStoreSnapshot;
  readonly resolver: RelationshipEndpointResolver;
  readonly clock: { readonly now: () => number };
}): Promise<RelationshipPolicyDecision>;
```

The validator:

- Is pure with respect to its inputs. It does not import provider SDKs, `node:net`, `node:child_process`, `node:fs`, `keiko-model-gateway` runtime, or `keiko-tools` runtime.
- Composes decisions in the order documented in [`docs/relationship-engine/denial-reasons.md`](../relationship-engine/denial-reasons.md): identity, kind compatibility, cardinality, cycle detection, scope, path containment, deny-list, lifecycle, endpoint liveness, payload-content, authority, schema-version.
- Returns `RelationshipPolicyDecision { allowed, reasons[] }` per [`docs/relationship-engine/gap-analysis.md`](../relationship-engine/gap-analysis.md) Gap 3.
- Is deterministic: identical inputs yield identical outputs.

Defence in depth: type-level parser (rejects malformed envelopes) → validator (deterministic decision) → SQL `STRICT` mode + `CHECK` constraints + `UNIQUE` partial indexes (third barrier). Even a buggy validator cannot persist a row that violates the schema invariants.

### 2. The validator lives in `@oscharko-dev/keiko-contracts`

No new `keiko-relationship` package is introduced. The contracts package is the established leaf for cross-domain types and pure validators per [ADR-0019](ADR-0019-modular-package-architecture.md) §"Required Dependency Direction". The existing pattern is `validateConnectorGraphState` at [`packages/keiko-contracts/src/local-knowledge-validation.ts:508`](../../packages/keiko-contracts/src/local-knowledge-validation.ts) using the `ValidationOk<T> | ValidationFail` shape at [`local-knowledge-validation.ts:29`](../../packages/keiko-contracts/src/local-knowledge-validation.ts).

A new package was rejected because:

- The epic budget is contract additions + a leaf SQL consumer + UI extensions. A new package would force a new `dependency-cruiser` direction rule and a new `arch:check` invariant for no benefit.
- The validator is pure and lives naturally in `keiko-contracts`. Splitting validator from contract would force a circular type/runtime relationship that `verbatimModuleSyntax` would reject.

### 3. Storage lives in the existing UI-persistence SQLite database

The relationship table is added as a V5 migration to the existing UI-persistence database owned by `@oscharko-dev/keiko-server` at [`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts), with the migration runner already in place at [`packages/keiko-server/src/store/schema.ts:94`](../../packages/keiko-server/src/store/schema.ts).

The DDL is documented normatively in [`docs/relationship-engine/storage.md`](../relationship-engine/storage.md) §3. Highlights:

- `STRICT` mode.
- `CHECK` constraints on every closed-set column (`schema_version`, `type`, `lifecycle`, `scope_kind`, `source_kind`, `target_kind`, `created_at`, `updated_at`, `confidence`, `summary`).
- Four covering indexes for the bounded-query routes (`source`, `target`, `type`, `lifecycle`), all keyed by `workspace_scope_id` first so cross-workspace queries are physically impossible without an index miss.
- Two `UNIQUE` partial indexes enforce cardinality at the DB level: `produces-evidence` (source) and `starts-workflow` (target) — defence-in-depth alongside the validator.
- A sibling `relationship_lifecycle_history` table with `ON DELETE CASCADE` for the bounded transition log.

No FK between the relationship table and any existing UI-persistence table. Endpoint liveness is resolved through the `RelationshipEndpointResolver` port (per [`docs/relationship-engine/gap-analysis.md`](../relationship-engine/gap-analysis.md) Gap 2).

Migration strategy: additive only, gated by `PRAGMA user_version` per the established Keiko convention. The runner already supports forward-only transactional migrations. The corrupt-DB quarantine flow (`.corrupt.<iso>` rename) inherits unchanged from the existing store.

### 4. API surface lives in `@oscharko-dev/keiko-server`

The eleven routes documented in [`docs/relationship-engine/api-contract.md`](../relationship-engine/api-contract.md) are registered as additive entries in the existing `API_ROUTES` array at [`packages/keiko-server/src/routes.ts:148`](../../packages/keiko-server/src/routes.ts). The dispatcher, deps injection (`UiHandlerDeps` at [`packages/keiko-server/src/deps.ts`](../../packages/keiko-server/src/deps.ts)), and redacted error envelope are unchanged.

Mutating routes require `Idempotency-Key`; PATCH and DELETE additionally require `If-Match`. Read routes are bounded (max `limit: 256`, max `maxDepth: 3`, max `maxNodes: 1024`). A bare `GET /api/relationships` (no selective parameter) returns 400.

The complete error code catalogue is in [`docs/relationship-engine/api-contract.md`](../relationship-engine/api-contract.md) §10.

### 5. Composition with existing trust boundaries

The relationship engine **never** grants authority on any existing boundary. Each boundary owns its gate; the engine is a sibling read substrate.

| Boundary                         | Engine composition                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model Gateway                    | The engine never originates a model call. No relationship type's semantics include "may invoke a model". A `starts-workflow` edge describes lineage; the run still goes through `keiko-model-gateway`'s capability check at [`packages/keiko-model-gateway/src/capabilities.ts`](../../packages/keiko-model-gateway/src/capabilities.ts).                   |
| Tool policy                      | A `uses-tool` edge is written **after** `keiko-tools` terminal-policy ([`terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts)) emits its decision. The engine never calls `isTerminalCommandAllowed` or `runCommand`.                                                                                                                |
| Workspace containment            | Every `workspace-path` endpoint passes `assertContainedRealPath` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)) plus `DEFAULT_DENY_PATTERNS` ([`ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts)) **before** the validator runs. Cross-workspace edges are forbidden by construction.            |
| Patch safety                     | A `proposes-patch` edge references the harness `PatchProposedEvent` envelope ([`packages/keiko-contracts/src/harness.ts:294`](../../packages/keiko-contracts/src/harness.ts)); the patch gate at [`packages/keiko-tools/src/patch.ts`](../../packages/keiko-tools/src/patch.ts) plus the realpath gate is the only apply path.                              |
| Evidence redaction + retention   | Every response, every persisted row, every audit envelope, every SSE event passes through `createAuditRedactor` and `deepRedactStrings` at [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts). A retired evidence manifest surfaces as `EndpointLiveness.status: "retired"`; the relationship becomes `stale`. |
| Workflow authority               | The `starts-workflow` edge is written **after** the workflow ledger acknowledges the run. The engine never starts, mutates, or applies a run. The validator enforces 1:1 target cardinality at the DB level via the `UNIQUE` partial index.                                                                                                                 |
| Memory governance                | A tombstoned memory's endpoint surfaces as `EndpointLiveness.status: "tombstoned"`. The validator returns `denied/endpoint-tombstoned`; existing relationships become `stale`. The engine never writes to `memory_edges` or `memories`.                                                                                                                     |
| Connector / capsule lifecycle    | The local-knowledge resolver returns `EndpointLiveness` for capsule and capsule-set endpoints. The engine never reads capsule content; clients fetch through the existing `/api/local-knowledge/*` routes ([`routes.ts:215`](../../packages/keiko-server/src/routes.ts)).                                                                                   |
| BFF UI persistence (ADR-0030 r5) | The new `relationships` table inherits the second-barrier redactor at write time (`deepRedactStrings`) and the corrupt-DB quarantine flow. No new credential surface; the engine carries no payload content per [`docs/relationship-engine/taxonomy.md`](../relationship-engine/taxonomy.md) §12.                                                           |

### 6. Why relationship existence grants ZERO authority

Restated normatively for the issue acceptance criterion:

- **Models**: a relationship row carries no API key, no model id authorisation, and no gateway capability. The gateway re-resolves capabilities on every call.
- **Tools**: a relationship row does not appear in the terminal-policy allow-list. The allow-list is the only allow-list.
- **Files**: a relationship row does not pre-resolve a realpath. Every read goes through `assertContainedRealPath` + `DEFAULT_DENY_PATTERNS`.
- **Connectors / capsules**: a relationship row does not pin a capsule from retirement. The capsule lifecycle in `keiko-local-knowledge` is canonical.
- **Workflows**: a relationship row does not start, mutate, or apply a run. The workflow handlers are the only run-mutation surface.
- **Patches**: a relationship row carries no diff. The patch gate is the only apply path.
- **Evidence**: a relationship row does not pin an evidence manifest from retention. Retention defaults to `maxRuns: 50` per [`packages/keiko-contracts/src/evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts).
- **Local knowledge / connectors**: relationships reference identities only.
- **Memory**: a relationship row does not bypass `keiko-memory-governance`. Tombstones still cascade.

The non-authority invariant is enforced by composition: each boundary owns its gate; the relationship engine is a sibling read substrate, not a privilege grant.

### 7. Idempotency, optimistic concurrency, schema versioning

- **Idempotency**: mutating routes require an `Idempotency-Key` header. The BFF maintains a process-local LRU `{key → result}` with TTL 15 minutes and capacity 4096. A divergent body on replay returns HTTP 409 with `relationship/idempotency-replay-mismatch`.
- **Optimistic concurrency**: PATCH and DELETE require `If-Match: "<etag>"`. The etag is monotonic per row, formatted as `printf('%016x', updated_at) || '-' || lower(hex(randomblob(3)))`. Mismatch returns HTTP 412 with `relationship/optimistic-concurrency-conflict` and the current etag in the body.
- **Schema versioning**: every envelope carries `schemaVersion: "1"`. Additive changes (new relationship type, object kind, lifecycle state, denial code) extend the closed sets without bumping. Breaking changes (rename, narrowing, removal) require a new literal `"2"` plus an ADR amending or superseding ADR-0031.
- **Bounded queries**: max `limit: 256`, max `maxDepth: 3`, max `maxNodes: 1024`, max `maxRelationships: 2048`, max body size 16 KiB. Exceed → HTTP 400 with `relationship/bounded-query-exceeded`.

The complete contract is in [`docs/relationship-engine/api-contract.md`](../relationship-engine/api-contract.md) §§5–7.

### 8. No new dependency, no new credential surface, no new persistence backend

`package.json` files outside the relationship-engine modules are unchanged. The engine adds no provider SDK, no graph DB driver, no graph layout library, no state-management library. No new env var pattern; no new credential file path; no new OAuth flow. The relationship table lives in the existing UI-persistence SQLite database; no new database file is created.

## Consequences

### Positive

- A single deterministic authority for relationship validation, easy to test exhaustively.
- One SQL file owns the table, one migration runner owns the schema, one corrupt-DB quarantine flow covers it. Operational surface stays flat.
- The contract addition lives in `keiko-contracts` as a pure module; existing direction rules suffice. `arch:check` rule 3a remains the canonical provider-SDK isolation gate.
- Bounded queries by construction; the impact-analysis primitive (#542) inherits an in-memory edge index over indexed SQL lookups.
- Every consumer surface (UI inspector, controlled graph view, BFF API, audit ledger, activity stream) consumes the same closed-set contracts. Adding a new consumer never requires a new redactor, validator, or DB schema.

### Negative

- The validator runs inside the SQL transaction. A slow resolver implementation degrades write latency. Mitigation: resolvers MUST be plain DB or cached state reads; #543 hardening adds a per-resolver latency budget.
- The relationship table lives in the UI-persistence database. A schema-corruption event quarantines both the UI-persistence rows (chats, projects, chat messages) and the relationships. Mitigation: the corrupt-DB quarantine flow already handles this for chats and projects; the relationship table inherits the recovery story.
- Schema-version bumps require an ADR. This is intentional — silent schema evolution is a forbidden anti-pattern — but it does add ceremony for breaking changes.

### Neutral

- Forward-looking endpoint kinds (`agent`, `connector`, `data-source`, `skill`, `mcp-tool`) are enumerated in the schema's `CHECK` constraint so the schema is stable when the owning registries land. The validator rejects them until then. No row with a forward-looking kind ever exists in production at `schemaVersion: "1"`.

## Alternatives considered

### A. New `keiko-relationship` package

Considered for ownership of the validator, the store layer, the resolver port, and the route registration. **Rejected** because (a) the epic budget is contract additions + a leaf SQL consumer; (b) splitting validator from contract would create a circular type/runtime relationship that `verbatimModuleSyntax` would reject; (c) a new package needs new direction-cruiser rules and a new `arch:check` invariant for no benefit. The owner-package decision is documented in [`docs/relationship-engine/architecture.md`](../relationship-engine/architecture.md) §7.

### B. Graph database (Neo4j, RedisGraph, in-process LMDB)

Considered for storage. **Rejected** because (a) it adds a third-party dependency, violating the epic invariant; (b) the cross-domain relationship volume is bounded (tens of thousands of rows per workspace, see [`docs/relationship-engine/storage.md`](../relationship-engine/storage.md) §7.1); (c) `node:sqlite` + indexed lookups satisfy every bounded-query route at predictable cost; (d) the in-memory edge index built on SQL covers the impact-analysis primitive at single-digit-millisecond latency for the documented `maxNodes: 1024` cap.

### C. In-memory store only (no persistence)

Considered for the relationship table. **Rejected** because (a) the audit ledger needs durable references to relationship ids; (b) lifecycle history (the `superseded`, `revoked`, `stale` audit trail) needs persistence; (c) restarting the BFF would clear the graph, breaking the impact-analysis surface.

### D. Per-package edge tables

Considered: each owning package keeps its own relationship table (memory-vault's `memory_edges`, local-knowledge's connector edges, evidence's audit-section edges). **Rejected** because (a) cross-domain queries would have to fan out to every package's database, breaking the bounded-query cost model; (b) the dependency-walk and impact-analysis primitives need a single index over all edges; (c) the audit invariant (one redactor, one body-free contract) would have to be re-enforced per package; (d) it fragments authority and undermines the single-validator decision the issue requires.

### E. New separate SQLite file

Considered: a new `relationships.db` next to the existing UI-persistence database. **Rejected** because (a) it doubles the `node:sqlite` `--experimental-sqlite` flag activation surface (already a known footgun per the Issue #62 memory entry); (b) it forces a parallel corrupt-DB quarantine handler, a parallel backup story, and a parallel migration ledger; (c) no architectural gain — the relationship table is narrow and the UI-persistence database already has room.

### F. JSON ledger (evidence-store style)

Considered for storage. **Rejected** because O(N) per-row queries break the bounded-query cost model. The impact-analysis primitive would have to materialise an in-memory index on every call.

### G. Co-host relationships inside `memory_edges`

Considered: extend `memory_edges` with cross-domain endpoint types. **Rejected** because (a) it would weaken `MemoryEdgeId`'s per-vault identity brand; (b) the `FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE` contract at [`packages/keiko-memory-vault/src/schema.ts:71`](../../packages/keiko-memory-vault/src/schema.ts) is intentional and cannot be widened without dropping FK enforcement; (c) `memory_edges` is consumed by the memory consolidation and retrieval layers under specific semantic assumptions that cross-domain edges would break.

## Migration

Forward-only. The V5 migration adds the `relationships` and `relationship_lifecycle_history` tables to the existing UI-persistence database. Running the migration twice is a no-op. The existing `PRAGMA user_version` runner is the migration mechanism.

Rolling back a bad migration uses the corrupt-DB quarantine flow inherited from the existing store: rename to `.corrupt.<iso>` and start clean. The relationship table is recoverable from evidence manifest references (audit ledger is canonical for lineage); the operational story is documented in [`docs/relationship-engine/storage.md`](../relationship-engine/storage.md) §6.3.

Future schema evolution:

- Adding a relationship type, object kind, lifecycle state, or denial code is an additive migration that extends the relevant `CHECK` constraint.
- Renaming, narrowing, or removing a member requires `schemaVersion: "2"` plus a new ADR amending or superseding ADR-0031.

## Related

- [ADR-0019](ADR-0019-modular-package-architecture.md) — modular package architecture (direction rules).
- [ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md) — architecture gate (dependency-cruiser, `arch:check`).
- [ADR-0022](ADR-0022-connected-context-privacy.md) — connected-context privacy and the body-free invariant lineage.
- [ADR-0026](ADR-0026-workspace-substrate.md) — workspace substrate (forbids parallel canvas/graph substrate).
- [ADR-0027](ADR-0027-workspace-state-ownership.md) — workspace state ownership (`evidence-reference` persistence pattern).
- [ADR-0029](ADR-0029-workspace-object-registry.md) — object registry validator (descriptor closed enums).
- [ADR-0030](ADR-0030-workspace-security-evidence.md) — five inviolable workspace rules (the trust boundaries this ADR composes with).
- ADR-0032 (issue [#536](https://github.com/oscharko-dev/Keiko/issues/536), pending) — relationship audit and activity model.
- ADR-0033 (issue [#537](https://github.com/oscharko-dev/Keiko/issues/537), pending) — relationship UI containment.

## Source material

- [`docs/relationship-engine/audit.md`](../relationship-engine/audit.md), [`reuse-matrix.md`](../relationship-engine/reuse-matrix.md), [`gap-analysis.md`](../relationship-engine/gap-analysis.md), [`adr-candidates.md`](../relationship-engine/adr-candidates.md)
- [`docs/relationship-engine/taxonomy.md`](../relationship-engine/taxonomy.md), [`compatibility-matrix.md`](../relationship-engine/compatibility-matrix.md), [`denial-reasons.md`](../relationship-engine/denial-reasons.md), [`lifecycle.md`](../relationship-engine/lifecycle.md)
- [`docs/relationship-engine/architecture.md`](../relationship-engine/architecture.md), [`api-contract.md`](../relationship-engine/api-contract.md), [`storage.md`](../relationship-engine/storage.md), [`security-checklist.md`](../relationship-engine/security-checklist.md)
- [`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts), [`store/schema.ts`](../../packages/keiko-server/src/store/schema.ts), [`routes.ts:148`](../../packages/keiko-server/src/routes.ts)
- [`packages/keiko-contracts/src/local-knowledge-validation.ts`](../../packages/keiko-contracts/src/local-knowledge-validation.ts), [`memory.ts:72`](../../packages/keiko-contracts/src/memory.ts), [`memory.ts:191`](../../packages/keiko-contracts/src/memory.ts), [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts), [`evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts), [`evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)
- [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)
- [`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts), [`ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts)
- [`packages/keiko-tools/src/terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts), [`patch.ts`](../../packages/keiko-tools/src/patch.ts)
- [`packages/keiko-memory-vault/src/schema.ts:68`](../../packages/keiko-memory-vault/src/schema.ts), [`tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#535](https://github.com/oscharko-dev/Keiko/issues/535).
