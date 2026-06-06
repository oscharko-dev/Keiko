# Epic #532 — Relationship Engine Architecture Blueprint

Status: Wave 3 deliverable for [issue #535](https://github.com/oscharko-dev/Keiko/issues/535) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md), [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md), [api-contract.md](api-contract.md), [storage.md](storage.md), [security-checklist.md](security-checklist.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md).

Date: 2026-06-06.

## 1. Purpose

This document specifies the authority model for the relationship engine: which component performs validation, where the validator runs, where relationship records live, how the API surface composes with existing Keiko trust boundaries, and why the existence of a relationship grants **zero** authority on any consumer surface.

The blueprint is binding for issues:

- [#536](https://github.com/oscharko-dev/Keiko/issues/536) — audit and activity model (ADR-0032);
- [#537](https://github.com/oscharko-dev/Keiko/issues/537) — UI blueprint;
- [#538](https://github.com/oscharko-dev/Keiko/issues/538) — contracts and deterministic validation engine;
- [#539](https://github.com/oscharko-dev/Keiko/issues/539) — relationship APIs;
- [#540](https://github.com/oscharko-dev/Keiko/issues/540) — inspector and controlled graph view;
- [#541](https://github.com/oscharko-dev/Keiko/issues/541) — privacy-preserving activity visualization;
- [#542](https://github.com/oscharko-dev/Keiko/issues/542) — bounded impact analysis and health checks.

The blueprint is reuse-first. Every layer below is anchored to an existing Keiko subsystem (cited as `package/file:line`) or is flagged as a documented gap from [gap-analysis.md](gap-analysis.md). The blueprint introduces no new persistence backend, no new credential surface, no new third-party dependency, and no new architecture direction rule.

## 2. Layered architecture

The relationship engine is a thin cross-domain layer over existing Keiko subsystems. The layers, in dependency order:

| #   | Layer           | Owning package                                                                                                                                        | What it adds                                                                                                                                                                                                                                                                                                              | What it composes (UNCHANGED)                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Contracts       | `@oscharko-dev/keiko-contracts`                                                                                                                       | Closed-set enums (`RelationshipEndpointKind`, `RelationshipType`, `RelationshipLifecycle`, `RelationshipPolicyCode`, `RelationshipActivityKind`), records (`Relationship`, `RelationshipEndpoint`, `RelationshipPolicyDecision`, `RelationshipActivityEvent`), and the typed `RelationshipEndpointResolver` port (Gap 2). | `MemoryScope` ([`memory.ts:72`](../../packages/keiko-contracts/src/memory.ts)), `MemoryId` / `KnowledgeCapsuleId` / `CapsuleSetId` / `WorkflowRunId` / `EvidenceManifestId` brands, `ValidationOk<T> \| ValidationFail` ([`local-knowledge-validation.ts:29`](../../packages/keiko-contracts/src/local-knowledge-validation.ts)).                                                 |
| 2   | Validator       | `@oscharko-dev/keiko-contracts` (pure module)                                                                                                         | Deterministic single-pass function over (taxonomy, current store state via injected ports, request). Returns `RelationshipPolicyDecision` (per [gap-analysis.md Gap 3](gap-analysis.md)).                                                                                                                                 | The compatibility matrix from [compatibility-matrix.md](compatibility-matrix.md), the lifecycle table from [lifecycle.md](lifecycle.md), and the denial catalog from [denial-reasons.md](denial-reasons.md).                                                                                                                                                                      |
| 3   | Policy composer | `@oscharko-dev/keiko-contracts` (pure module)                                                                                                         | Composes per-endpoint liveness reports from the resolver port with the validator decision; never bypasses an owning boundary.                                                                                                                                                                                             | `RelationshipEndpointResolver` instances supplied by `keiko-memory-vault`, `keiko-local-knowledge`, `keiko-workflows`, `keiko-evidence`, `keiko-workspace`, and the chat surface in `keiko-server`.                                                                                                                                                                               |
| 4   | Store           | `@oscharko-dev/keiko-server` (extended in-place; see [storage.md](storage.md) and [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md)) | A new `relationships` table inside the existing UI-persistence SQLite database ([`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts), [`schema.ts`](../../packages/keiko-server/src/store/schema.ts)), migrated via the established `PRAGMA user_version` runner.                       | `runMigrations` ([`schema.ts:94`](../../packages/keiko-server/src/store/schema.ts)), `node:sqlite` with the `--experimental-sqlite` strategy already in production for issue #62, and the `O_EXCL` realpath-contained convention from [`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts) for the corrupt-DB quarantine path (`.corrupt.<iso>`). |
| 5   | API (BFF)       | `@oscharko-dev/keiko-server` (additive routes registered in [`routes.ts`](../../packages/keiko-server/src/routes.ts))                                 | HTTP routes specified in [api-contract.md](api-contract.md). Each route is registered as an `API_ROUTES` entry; the route dispatcher remains unchanged.                                                                                                                                                                   | The existing `RouteDefinition` / `RouteHandler` machinery in [`routes.ts:133`](../../packages/keiko-server/src/routes.ts); the `UiHandlerDeps` deps injection at [`deps.ts`](../../packages/keiko-server/src/deps.ts); the redacted error envelope `{ error: { code, message } }` already documented in [`routes.ts:6`](../../packages/keiko-server/src/routes.ts).               |
| 6   | UI hint         | `@oscharko-dev/keiko-ui`                                                                                                                              | Read-only inspector and controlled graph view per [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md). UI may produce a hint about validity for fast feedback but the hint is advisory.                                                                                                                            | The existing `WindowsRegistry.ts` extension contract ([`WindowsRegistry.ts:5`](../../packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts)), the descriptor validator from [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), and the SSE `addEventListener(kind, ...)` discipline from Epic #13.                                                       |

### 2.1 Diagram-as-table — write path

```
                   Client / UI                                Server (BFF)
                   ----------                                 ------------
                                                              (1) Route in API_ROUTES
   POST /api/relationships         --HTTP-->                 (2) UiHandlerDeps injected
   { source, target, type, scope }                            (3) Schema parser (contracts shape)
                                                              (4) Validator (pure, deterministic)
                                                              (5) Endpoint-resolver ports
                                                              (6) Policy composer
                                                              (7) Storage transaction
                                                              (8) Audit-event emit (issue #536)
                                                              (9) Redactor (response side)
   { id, lifecycle, policy }       <--HTTP--                 (10) RouteResult envelope
```

Steps (3)–(8) live in `keiko-contracts` (pure modules) plus the storage call into `keiko-server`. Step (9) is the existing `createAuditRedactor` chokepoint at [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts). The deps wiring follows the existing handler factory shape in [`packages/keiko-server/src/store-handlers.ts`](../../packages/keiko-server/src/store-handlers.ts).

### 2.2 Diagram-as-table — read path

```
                   Client / UI                                Server (BFF)
                   ----------                                 ------------
   GET /api/relationships?...      --HTTP-->                 (1) Route in API_ROUTES
                                                              (2) Bounded-query parser (cap N)
                                                              (3) Workspace-scope filter
                                                              (4) Store SELECT (indexed)
                                                              (5) Endpoint-liveness derivation
                                                              (6) Redactor (response side)
   { entries[], truncated, cap }   <--HTTP--                 (7) RouteResult envelope
```

Read paths never invoke the validator: validation is a write-side concern. Read paths still pass every output through the redactor.

### 2.3 Diagram-as-table — activity stream

```
                   Client / UI                                Server (BFF)
                   ----------                                 ------------
   GET /api/relationships/events   --SSE-->                  (1) Route in API_ROUTES
                                                              (2) EventSource opened
   addEventListener("relationship:proposed", ...)             (3) Per-kind event emit
   addEventListener("relationship:accepted", ...)             (4) Redactor at emit
   ...                                                        (5) Scope filter (caller scope only)
```

The activity envelope mirrors the `BaseWorkflowEvent` shape from [`packages/keiko-contracts/src/unit-test-events.ts:57`](../../packages/keiko-contracts/src/unit-test-events.ts). Per-kind `addEventListener` is the established UI subscription discipline (Epic #13 memory entry).

## 3. Server-authoritative validation

### 3.1 Single authority

The validator is a pure deterministic function exposed by `@oscharko-dev/keiko-contracts`. It runs **only on the server**, inside the request handler, inside the same database transaction as the write. The UI MUST NOT short-circuit a mutation because its local hint says the proposal is valid. The UI hint is advisory:

- Optimistic acceptance is allowed (the UI may show "proposing" state) but the relationship is not persisted until the server commits the transaction.
- A `POST /api/relationships/validate` route exists for preview-only feedback (see [api-contract.md §4.1](api-contract.md)). It returns `{ decision: { allowed, reasons }, hints: [] }` without persisting; the UI consumes it for inline validation.
- The mutating routes (`POST`, `PATCH`, `DELETE`) re-run the validator unconditionally; preview state from the validate route is not trusted.

### 3.2 Function signature (binding for #538)

```ts
function validateRelationship(
  input: unknown,
  ctx?: RelationshipValidationContext,
): ValidationOk<Relationship> | ValidationFail;
```

The function:

- Is **pure** with respect to the input snapshot and the resolver: it does not write, mutate, or originate model/tool/network calls.
- Rejects malformed or unsupported envelopes first (`schemaVersion`, unknown type/kind/lifecycle, missing required fields), then composes policy denials in the order specified by [denial-reasons.md §"Resolution order"](denial-reasons.md): endpoint identity first, then kind compatibility, then cardinality, then cycle detection, then scope, then path containment, then deny-list, then lifecycle, then deferred endpoint liveness, then payload-content, then authority.
- Returns `{ allowed: false, reasons: [...] }` whenever any single check fails; the decision is deterministic and stable across repeat invocations on identical inputs.
- Never short-circuits on policy denials **for reporting**: reasons accumulate so the UI inspector renders one panel per failure. The exceptions are the structural envelope prelude and missing-endpoint identity failures, which short-circuit because further evaluation is meaningless.

The validator is exhaustively tested in #538; reuse-first means the test harness shape comes from `boundary.test.ts` ([`packages/keiko-contracts/src/boundary.test.ts`](../../packages/keiko-contracts/src/boundary.test.ts)).

### 3.3 Defence in depth

The validator is one barrier of three:

1. **Type-level**: the request schema parser at the BFF rejects malformed envelopes before the validator runs. The schema parser uses the same closed-string-set shape used by `MemoryEdgeKind` and `MEMORY_EDGE_KINDS` ([`memory.ts:191`](../../packages/keiko-contracts/src/memory.ts), [`memory.ts:199`](../../packages/keiko-contracts/src/memory.ts)).
2. **Validator**: the deterministic decision documented in §3.2.
3. **Store invariant**: the `relationships` table declares `STRICT` mode, `CHECK` constraints on `kind` and `lifecycle` columns, and a `UNIQUE` partial index that enforces cardinality at the DB level for `produces-evidence` and `starts-workflow` (see [storage.md §3](storage.md)). Even a buggy validator cannot persist a record that violates the schema invariants.

## 4. Composition with existing trust boundaries

This section makes the non-authority invariant from [taxonomy.md §2](taxonomy.md) operational. Every existing Keiko trust boundary owns its authority. The relationship engine references identities but **never** authorises action on the owning boundary.

### 4.1 Model Gateway authority (`@oscharko-dev/keiko-model-gateway`)

- **Boundary**: Originating a model call must go through `keiko-model-gateway`. Restated from [ADR-0030 rule 1](../adr/ADR-0030-workspace-security-evidence.md).
- **Engine composition**: The relationship engine **never** originates a model call. The contract module is pure; the BFF handlers do not import any provider SDK; the store layer is pure SQL; the validator is a pure function. `arch:check` rule 3a already promotes provider-SDK isolation to error level for non-gateway packages.
- **Why a relationship cannot grant model access**: There is no relationship type whose semantics include "may invoke a model". A `starts-workflow` edge describes the lineage from chat to run; it does not pre-authorise the run's model calls. The run still goes through the gateway, which still performs its capability check.

### 4.2 Tool policy (`@oscharko-dev/keiko-tools`)

- **Boundary**: Tool execution is gated by the terminal-policy allow-list at [`packages/keiko-tools/src/terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts). Restated from [ADR-0030 rule 3](../adr/ADR-0030-workspace-security-evidence.md).
- **Engine composition**: The `uses-tool` relationship records that a registered tool was invoked from a run; the relationship is written **after** the tool gate emits its decision. The engine does not call `isTerminalCommandAllowed`, does not call `runCommand`, and does not import from `keiko-tools` for the purpose of executing.
- **Why a relationship cannot grant tool execution**: `uses-tool` is a structural lineage edge. Creating a `uses-tool` from a UI inspector does not invoke the tool; the validator denies any creation attempt whose `source` is not a `workflow-run` and whose `target` is not a registered tool id, and the tool itself is gated by `terminal-policy.ts` at execution time regardless of any prior relationship row.

### 4.3 Workspace containment (`@oscharko-dev/keiko-workspace`)

- **Boundary**: Every `workspace-path` endpoint must pass `assertContainedRealPath` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)) and the always-on `DEFAULT_DENY_PATTERNS` from [`packages/keiko-workspace/src/ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts). Restated from [ADR-0030 rule 2](../adr/ADR-0030-workspace-security-evidence.md).
- **Engine composition**: Every API route that names a `workspace-path` endpoint passes the relative-path string through `assertContainedRealPath` **before** the validator runs. Failure raises `denied/path-not-contained`. Workspace-scope filtering is applied to every store query and every store mutation: a relationship whose source resolves to workspace A and whose target resolves to workspace B is rejected with `denied/cross-workspace`.
- **Why a relationship cannot grant workspace access**: A `references-document` edge names a path; it does not open, read, or stream the file. Any consumer wanting to read the file calls back through the workspace discovery layer at [`packages/keiko-workspace/src/discovery.ts:211`](../../packages/keiko-workspace/src/discovery.ts), which re-applies the boundary/deny/realpath gate. The relationship is at most a hint about which file is interesting; it never bypasses the gate.

### 4.4 Patch safety (`@oscharko-dev/keiko-tools` patch pipeline)

- **Boundary**: Applying a patch is gated by the patch pipeline at [`packages/keiko-tools/src/patch.ts`](../../packages/keiko-tools/src/patch.ts) plus the workspace `assertContainedRealPath` chokepoint. Restated from [ADR-0030 rule 4](../adr/ADR-0030-workspace-security-evidence.md).
- **Engine composition**: The `proposes-patch` relationship references a `PatchProposedEvent` envelope id from the harness event stream ([`packages/keiko-contracts/src/harness.ts:294`](../../packages/keiko-contracts/src/harness.ts)). The relationship is written when the proposal exists; the relationship is not the apply trigger. The apply trigger is the existing `POST /api/runs/:runId/apply` handler in [`packages/keiko-server/src/run-handlers.ts`](../../packages/keiko-server/src/run-handlers.ts), which performs its own gate.
- **Why a relationship cannot grant patch apply**: The validator never accepts a payload field that would carry diff content; the relationship row stores only the harness event id and the target paths. The harness-level patch gate runs independently of any relationship row.

### 4.5 Evidence redaction and retention (`@oscharko-dev/keiko-evidence` + `@oscharko-dev/keiko-security`)

- **Boundary**: Evidence records flow through `createAuditRedactor` and `deepRedactStrings` at [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts) before persistence, and through atomic `O_EXCL` realpath-contained writes in [`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts). Restated from [ADR-0030 rule 5](../adr/ADR-0030-workspace-security-evidence.md).
- **Engine composition**: Every relationship API response, every persisted relationship row, and every relationship audit / activity envelope passes through `createAuditRedactor` (response side) and `deepRedactStrings` (persist side). The relationship engine does not introduce a parallel redactor.
- **Why a relationship cannot bypass redaction**: The contract layer's `Relationship` record carries no payload fields (per [taxonomy.md §12](taxonomy.md)). The optional `summary` field is bounded to 240 chars and runs through the deep redactor at the persist boundary. The validator rejects with `denied/payload-content-not-permitted` upstream so the client sees the rejection rather than a silently scrubbed value.

### 4.6 Workflow authority (`@oscharko-dev/keiko-workflows`)

- **Boundary**: Starting, mutating, or completing a workflow run is owned by the workflow descriptor and handoff envelopes in `keiko-workflows`, surfaced via the BFF routes `POST /api/runs`, `POST /api/runs/:runId/cancel`, and `POST /api/runs/:runId/apply` in [`packages/keiko-server/src/routes.ts:154`](../../packages/keiko-server/src/routes.ts).
- **Engine composition**: The `starts-workflow` relationship is written **after** the workflow ledger acknowledges the run (the validator enforces a 1:1 target cardinality so a run cannot be claimed twice). The engine does not start runs, cancel runs, or apply runs.
- **Why a relationship cannot grant workflow execution**: A `starts-workflow` from `chat` to `workflow-run` records lineage; the run identity belongs to the workflow ledger. A consumer wanting to act on the run still goes through the run handler, which performs its own authority checks.

### 4.7 Memory governance (`@oscharko-dev/keiko-memory-governance`)

- **Boundary**: Memory mutations (correction, suppression, forgetting, retention) are owned by `keiko-memory-governance`. Tombstoning is the canonical forget signal at [`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts).
- **Engine composition**: A relationship whose endpoint is a memory consults the memory-vault resolver implementation of `RelationshipEndpointResolver`. A tombstoned endpoint surfaces as `EndpointLiveness.status: "tombstoned"`; the validator returns `denied/endpoint-tombstoned`; the relationship transitions to `stale` on the next health check.
- **Why a relationship cannot grant memory mutation**: The relationship engine never writes to `memory_edges`, `memories`, or any vault table. The relationship row sits alongside the vault, not inside it.

### 4.8 Connector / capsule lifecycle (`@oscharko-dev/keiko-local-knowledge`)

- **Boundary**: Capsule and source lifecycle is owned by `keiko-local-knowledge` (`capsule-lifecycle.ts`, `source-lifecycle.ts`).
- **Engine composition**: A capsule endpoint consults the local-knowledge resolver. A retired capsule surfaces as `EndpointLiveness.status: "retired"`.
- **Why a relationship cannot grant capsule access**: The engine never reads capsule content. A `references-document` edge targeting a capsule stores the capsule id; capsule content is fetched through the local-knowledge layer's own routes (the `/api/local-knowledge/capsules/:capsuleId` family in [`routes.ts:215`](../../packages/keiko-server/src/routes.ts)).

### 4.9 BFF UI persistence (`@oscharko-dev/keiko-server` store)

- **Boundary**: The UI-durable layer at [`packages/keiko-server/src/store/`](../../packages/keiko-server/src/store/) (projects, chats, chat messages) is gated by [ADR-0030 rule 5](../adr/ADR-0030-workspace-security-evidence.md): no raw secrets, customer data, or token-bearing artifacts.
- **Engine composition**: The new `relationships` table lives **alongside** projects/chats/chat_messages in the existing SQLite database, governed by the same migration runner and the same second-barrier redactor at the write boundary. See [storage.md §2](storage.md) for the rationale.
- **Why colocation does not weaken any boundary**: Schema isolation is enforced by table; cross-table foreign keys are intentionally absent (per [gap-analysis.md Gap 2](gap-analysis.md), endpoint liveness is resolved through the port rather than via cross-database FK). The relationship table inherits the redactor and the corrupt-DB quarantine machinery the existing store already runs.

## 5. Why relationship existence grants ZERO authority — per boundary

This section is normative. It restates the issue acceptance criterion and answers, per boundary, why a relationship row cannot be treated as authorization.

1. **Models**: A relationship row carries no API key, no model id authorisation, and no `keiko-model-gateway` capability. The gateway re-resolves capabilities on every call ([`packages/keiko-model-gateway/src/capabilities.ts`](../../packages/keiko-model-gateway/src/capabilities.ts)). A `starts-workflow` row does not grant any gateway capability.
2. **Tools**: A relationship row does not appear in the terminal-policy allow-list at [`packages/keiko-tools/src/terminal-policy.ts:148`](../../packages/keiko-tools/src/terminal-policy.ts). The allow-list is the **only** allow-list; it is not consulted by the relationship engine and the relationship engine is not consulted by the allow-list.
3. **Files**: A relationship row does not pre-resolve a realpath. Every read goes through `assertContainedRealPath` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)) plus `DEFAULT_DENY_PATTERNS` ([`packages/keiko-workspace/src/ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts)). A `references-document` row pointing at a sensitive path is rejected with `denied/path-not-contained` at write time and the file is still gated at read time regardless.
4. **Connectors / capsules**: A relationship row does not pin a capsule from retirement. The capsule lifecycle in `keiko-local-knowledge` is canonical; a retired capsule surfaces as `EndpointLiveness.status: "retired"` and the relationship becomes `stale`.
5. **Workflows**: A relationship row does not start, mutate, or apply a run. The workflow handlers in [`packages/keiko-server/src/run-handlers.ts`](../../packages/keiko-server/src/run-handlers.ts) are the only run-mutation surface.
6. **Patches**: A relationship row carries no diff. The patch gate at [`packages/keiko-tools/src/patch.ts`](../../packages/keiko-tools/src/patch.ts) plus the realpath gate is the only apply path.
7. **Evidence**: A relationship row does not pin an evidence manifest from retention. Evidence retention defaults to `maxRuns: 50` ([`packages/keiko-contracts/src/evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)). A retired manifest surfaces as `EndpointLiveness.status: "retired"` and the relationship becomes `stale`.
8. **Local knowledge / connectors**: As §5.4. The local-knowledge layer owns its own routes (`/api/local-knowledge/*`); relationships reference identities only.
9. **Memory**: A relationship row does not bypass `keiko-memory-governance`. A tombstoned memory's endpoint surfaces as `EndpointLiveness.status: "tombstoned"`; the validator rejects new relationships referencing it; existing relationships transition to `stale`.

The non-authority invariant is therefore enforced by composition: each boundary owns its gate; the relationship engine is a sibling read substrate, not a privilege grant.

## 6. Idempotency, optimistic concurrency, and schema versioning

This section specifies the cross-cutting correctness guarantees the API contract relies on. The deterministic-error-code surface in [api-contract.md](api-contract.md) implements the contract specified here.

### 6.1 Idempotency

- Mutating routes (`POST`, `PATCH`, `DELETE`) require an `Idempotency-Key` header. The key is an opaque client-generated string (UUID v4 recommended), bounded to 64 chars.
- The current implementation applies replay caching only to `POST /api/relationships`. It records the key → `{ status, response, bodyHash }` in an in-memory bounded LRU cache scoped to a single server process. The cache TTL is 10 minutes; the maximum size is 1024 entries. (Restated from [api-contract.md §5](api-contract.md).)
- A replay (identical key, identical body) returns the original result. A replay with a divergent body returns `relationship/idempotency-replay-mismatch` (HTTP 409).
- The cache is process-local. In a single-process BFF (the deployed shape per [ADR-0011 D5](../adr/ADR-0025-forward-only-0-2-0-modular-baseline.md) lineage), this is sufficient. A cross-process cache is a future-work item and is **not** required by this epic.

### 6.2 Optimistic concurrency

- Every relationship row carries an `etag` column (TEXT, monotonic per row, populated via a server-side counter expressed as `printf('%016x', updated_at)` plus a tiebreaker). The full algorithm is specified in [storage.md §4](storage.md).
- `PATCH` and `DELETE` require an `If-Match: <etag>` header. The current implementation pre-checks the supplied etag against the current row before the store mutation and rejects mismatches with HTTP 412.
- A mismatch raises `relationship/optimistic-concurrency-conflict` (HTTP 412). The current response body carries the standard `{ error }` envelope only; callers re-fetch to learn the latest opaque etag.
- The server never accepts a write without an `If-Match` header on mutating routes. Restated from [api-contract.md §6](api-contract.md).

### 6.3 Schema versioning

- Every Wire envelope (request body, response body, activity event, audit entry) carries `schemaVersion: "1"`. Restated from [taxonomy.md §3](taxonomy.md).
- A `"2"` envelope opened by a `"1"` server raises `relationship/schema-version-unsupported` (HTTP 422). The server never coerces; readers reject and let the client up-grade.
- Adding a new relationship type, object kind, lifecycle state, or denial-reason code is an additive change at `"1"`. Removing or renaming requires `"2"` plus an ADR amending or superseding ADR-0031.

### 6.4 Stale writes

- A write whose row is later observed to be stale (the validator's snapshot was taken before another writer committed) is detected by the `If-Match` precondition. The conflicting write returns HTTP 412 and the caller must re-fetch to obtain the latest opaque etag.
- The store layer is the source of truth for staleness. The validator is pure; it cannot itself detect concurrent commits.

### 6.5 Bounded-query contract

- The list route accepts a `limit` query parameter (default 64, max 256). The current implementation does not consume a cursor parameter.
- Dependency-walk and impact routes accept `maxDepth` (default 1, max 3) and `maxNodes` (default 256, max 1024). These caps mirror the `ImpactBudget` defaults from [gap-analysis.md Gap 8](gap-analysis.md).
- Exceeding a cap raises `relationship/bounded-query-exceeded` with the truncation metadata (`{ truncated: true, truncationReason: "max-depth" | "max-nodes" | "max-relationships" }`). The server never serves an unbounded walk.

## 7. Owner-package decision

The relationship engine **does not** introduce a new package. The decision is recorded in ADR-0031 §"Decision" and §"Alternatives considered". The rationale, summarised:

- **Contracts**: types, enums, validator, policy composer, resolver port. Lives in `@oscharko-dev/keiko-contracts`. This package is the established leaf for cross-domain contracts; it imports from no other Keiko package (per [ADR-0019 §"Required Dependency Direction"](../adr/ADR-0019-modular-package-architecture.md), `contracts` is the leaf). The validator is a pure function; co-locating it in `keiko-contracts` is consistent with `validateConnectorGraphState` at [`local-knowledge-validation.ts:508`](../../packages/keiko-contracts/src/local-knowledge-validation.ts) and the `ValidationOk<T> | ValidationFail` shape at [`local-knowledge-validation.ts:29`](../../packages/keiko-contracts/src/local-knowledge-validation.ts).
- **Store**: SQL table, migration, transactional access. Lives in `@oscharko-dev/keiko-server` (the existing BFF) under the existing [`packages/keiko-server/src/store/`](../../packages/keiko-server/src/store/) module. This is the same module that owns projects, chats, and chat messages today; the relationship table is a sibling.
- **API**: HTTP routes. Lives in `@oscharko-dev/keiko-server` as `API_ROUTES` entries in [`routes.ts:148`](../../packages/keiko-server/src/routes.ts). The dispatcher, deps injection, and error envelope are unchanged.
- **Resolvers**: each owning package (`keiko-memory-vault`, `keiko-local-knowledge`, `keiko-workflows`, `keiko-evidence`, `keiko-workspace`, `keiko-server` for the chat surface) exposes its `RelationshipEndpointResolver` implementation through its existing module surface. No new direction rule is needed: `keiko-server` already imports from each of these packages.
- **UI**: the inspector and controlled graph view extend `WindowsRegistry.ts` per ADR-0034 (issue #537). No new UI package.

A new `keiko-relationships` package was **rejected** because:

- The epic budget is contract additions + a leaf SQL consumer + UI extensions. A new package would force a new direction rule in `dependency-cruiser` (per [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md)) and a new `arch:check` invariant for no benefit.
- The validator is pure and lives naturally in `keiko-contracts`. Splitting validator from contract would force a circular type/runtime relationship that `verbatimModuleSyntax` would reject.
- The store is one SQLite database with one migration runner. Adding a second database introduces the `node:sqlite` `--experimental-sqlite` flag at additional sites (already a known footgun per the Issue #62 memory entry) for no architectural gain.

## 8. Diagram of seams (textual)

```
  keiko-contracts (LEAF, pure)
    ├── Relationship, RelationshipEndpoint, RelationshipValidationError
    ├── validateRelationship(...)                  (PURE)
    └── RelationshipValidationContext (PORT SHAPE)

  keiko-memory-vault, keiko-local-knowledge, keiko-workflows, keiko-evidence,
  keiko-workspace, keiko-server (chat surface)
    └── (each) implements RelationshipEndpointResolver

  keiko-server
    ├── store/
    │   ├── relationships.ts          (NEW: CRUD + transactional)
    │   ├── relationships.schema.sql  (NEW: STRICT, indexes, CHECK)
    │   └── schema.ts                 (EXTENDED: V5 migration; PRAGMA user_version)
    ├── relationship-handlers.ts      (NEW: route handlers)
    └── routes.ts                     (EXTENDED: API_ROUTES entries)

  keiko-security
    └── redaction.ts                  (UNCHANGED chokepoint, reused)

  keiko-evidence
    └── (issue #536) optional manifest section relationships?

  keiko-ui
    └── windows/
        ├── relationship-inspector.tsx     (NEW; ADR-0033 / issue #540)
        └── relationship-graph.tsx         (NEW; ADR-0033 / issue #540)
```

Each new file is named for clarity; final filenames are at the implementing issue's discretion. The point is the seam ownership.

## 9. Open decisions deferred to later issues

These are flagged so future-me / future reviewers do not mistake an absence for a silent decision:

- **Activity envelope and audit-event embedding** are owned by ADR-0032 (issue #536). This blueprint specifies that activity events exist (per §2.3) but does not lock the audit-section embedding shape.
- **UI substrate and window-type descriptors** are owned by ADR-0033 (issue #537). This blueprint specifies that the UI is read-only and advisory (per §2 row 6) but does not lock the descriptor fields.
- **Inspector deep-link route convention** (static-export query-param routes per Epic #62 memory entry) is restated as a constraint but its concrete URL shape is owned by issue #540.
- **Cross-process idempotency cache** is explicitly out of scope (per §6.1). A future ADR may introduce it if the BFF deployment shape changes.

## 10. References

- [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md)
- [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md)
- [api-contract.md](api-contract.md), [storage.md](storage.md), [security-checklist.md](security-checklist.md)
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md), [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#535](https://github.com/oscharko-dev/Keiko/issues/535).
