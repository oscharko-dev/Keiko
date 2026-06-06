# Epic #532 — Relationship Engine API Contract

Status: Wave 3 deliverable for [issue #535](https://github.com/oscharko-dev/Keiko/issues/535) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [architecture.md](architecture.md), [storage.md](storage.md), [security-checklist.md](security-checklist.md), [taxonomy.md](taxonomy.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md).

Date: 2026-06-06.

## 1. Purpose

This document is the binding API specification for the relationship engine's HTTP surface. It enumerates every route, fixes every request and response shape, and lists every deterministic error code. The shapes are written so that a reviewer of issue [#539](https://github.com/oscharko-dev/Keiko/issues/539) can land the routes without re-litigating the contract.

The contract is additive over the existing BFF routes registered in [`packages/keiko-server/src/routes.ts`](../../packages/keiko-server/src/routes.ts). Every route is implemented as a `RouteDefinition` entry in the `API_ROUTES` array ([`routes.ts:148`](../../packages/keiko-server/src/routes.ts)). Every handler returns a `RouteResult` envelope through the existing dispatch machinery; non-2xx bodies use the redacted error envelope already documented in the header comment at [`routes.ts:6`](../../packages/keiko-server/src/routes.ts):

```
{ "error": { "code": string, "message": string } }
```

## 2. Route catalogue

The eleven new routes:

| #   | Method | Pattern                               | Handler concern                                                                          |
| --- | ------ | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | POST   | `/api/relationships/validate`         | Preview-only validation. Never persists.                                                 |
| 2   | POST   | `/api/relationships`                  | Create. Requires `Idempotency-Key`.                                                      |
| 3   | GET    | `/api/relationships`                  | Bounded query by source / target / type / scope.                                         |
| 4   | GET    | `/api/relationships/:id`              | Single relationship read.                                                                |
| 5   | PATCH  | `/api/relationships/:id`              | Lifecycle transition or reconnection. Requires `If-Match` and `Idempotency-Key`.         |
| 6   | DELETE | `/api/relationships/:id`              | Soft delete (transition to `revoked`). Requires `If-Match` and `Idempotency-Key`.        |
| 7   | GET    | `/api/relationships/:id/dependencies` | Bounded dependency walk (single hop default).                                            |
| 8   | GET    | `/api/relationships/impact`           | Bounded impact analysis for a focal endpoint.                                            |
| 9   | GET    | `/api/relationships/:id/explain`      | Denial / lifecycle explanation, redacted.                                                |
| 10  | GET    | `/api/relationships/health`           | Graph health summary: counts, stale, orphan, last-validated-at.                          |
| 11  | GET    | `/api/relationships/events`           | SSE stream of `relationship:*` activity events. Issue #541 wires per-kind subscriptions. |

Routes 1, 3, 4, 7, 8, 9, 10, and 11 are read-only; routes 2, 5, 6 are mutating.

## 3. Common envelope conventions

### 3.1 Wire base

Every request and response body carries `schemaVersion: "1"`. Restated from [taxonomy.md §3](taxonomy.md).

### 3.2 Identifiers

- `RelationshipId` is the branded string from [gap-analysis.md Gap 4](gap-analysis.md). On the wire, a string of `[A-Za-z0-9._-]{8,128}`.
- `RelationshipEndpoint` is the discriminated union from [gap-analysis.md Gap 1](gap-analysis.md):

  ```
  type RelationshipEndpoint =
    | { kind: "memory"; id: MemoryId }
    | { kind: "capsule"; id: KnowledgeCapsuleId }
    | { kind: "capsule-set"; id: CapsuleSetId }
    | { kind: "workflow-run"; id: WorkflowRunId }
    | { kind: "evidence-run"; id: EvidenceManifestId }
    | { kind: "workspace-path"; relPath: string }
    | { kind: "chat"; id: ChatId }
    | { kind: "tool"; id: ToolId }
    | { kind: "patch-proposal"; id: PatchProposedEventId };
  ```

  Forward-looking kinds (`agent`, `connector`, `data-source`, `skill`, `mcp-tool`) are enumerated in the schema but the validator rejects them with `denied/object-kind-not-yet-supported`.

### 3.3 Scope

`MemoryScope` is reused from [`packages/keiko-contracts/src/memory.ts:72`](../../packages/keiko-contracts/src/memory.ts):

```
type MemoryScope =
  | { kind: "user"; userId: UserId }
  | { kind: "workspace"; workspaceId: WorkspaceId }
  | { kind: "project"; projectId: ProjectId }
  | { kind: "workflow"; workflowDefinitionId: WorkflowDefinitionId }
  | { kind: "global" };
```

Every read route filters by the caller's active workspace; cross-workspace reads are rejected with `relationship/scope-not-permitted` (HTTP 403).

### 3.4 Error envelope

Every non-2xx response uses:

```
{ "error": { "code": string, "message": string } }
```

The `code` is the deterministic identifier listed in §10. The `message` is a short, redacted, professional English sentence safe for direct display. Restated from the existing convention in [`routes.ts:6`](../../packages/keiko-server/src/routes.ts).

### 3.5 Headers

| Header            | Direction | Routes              | Purpose                                                                                                |
| ----------------- | --------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `Idempotency-Key` | Request   | POST, PATCH, DELETE | Replay protection (per §5). Bounded `[A-Za-z0-9._-]{8,64}`.                                            |
| `If-Match`        | Request   | PATCH, DELETE       | Optimistic concurrency precondition (per §6). Value is the current row's etag.                         |
| `ETag`            | Response  | -                   | Current implementation returns the opaque row etag in the JSON body (`body.etag`), not an HTTP header. |
| `X-Truncated`     | Response  | -                   | Current implementation reports truncation in the JSON body only.                                       |
| `Cache-Control`   | Response  | All                 | `no-store` for mutating routes and any route that returns user-scoped data; the BFF default.           |

The BFF's existing CSP and security headers ([`packages/keiko-server/src/csp.ts`](../../packages/keiko-server/src/csp.ts), [`headers.ts`](../../packages/keiko-server/src/headers.ts)) apply unchanged.

### 3.6 Redaction guarantee

Every response body and every persisted record is passed through `createAuditRedactor` and `deepRedactStrings` at [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts) before serialization or persistence. This is restated normatively in [security-checklist.md §3](security-checklist.md). No relationship route returns a string that has not crossed the redactor.

## 4. Route specifications

### 4.1 `POST /api/relationships/validate`

Preview-only. Runs the validator and returns the decision without persisting. The handler is the same pure function used by `POST /api/relationships`; this route exists so the UI can show validity hints inline.

**Request**

```
POST /api/relationships/validate
Content-Type: application/json

{
  "schemaVersion": "1",
  "proposal": {
    "type": "depends-on",
    "source": { "kind": "capsule", "id": "cap_..." },
    "target": { "kind": "workflow-run", "id": "run_..." },
    "scope": { "kind": "workspace", "workspaceId": "ws_..." },
    "summary": "..."   // optional, <= 240 chars
  }
}
```

**Response (200)**

```
{
  "schemaVersion": "1",
  "decision": {
    "allowed": true,
    "reasons": []
  },
  "hints": [
    { "code": "info/forward-looking-target-coming", "message": "..." }
  ]
}
```

When `allowed` is `false`, `reasons` is non-empty; each reason follows the shipped `RelationshipValidationError` shape:

```
{
  "field": "source.kind" | "target.kind" | "type" | "scope.kind",
  "code": "<denied/*>",
  "message": "..."
}
```

`hints` is informational only (e.g., advance-notice on a forward-looking kind, or a cardinality warning that does not yet trigger denial). The UI MAY surface hints; mutating routes ignore them.

**Redaction**: `summary` (input) is bounded to 240 chars and passed through the redactor before the validator inspects it. `summary` (output, in reasons) is generated server-side and is redactor-clean by construction.

**Audit obligation**: None. Validate-only routes do not emit audit events. The route does not write to the database.

**Error codes (this route)**

- `relationship/payload-too-large` (HTTP 413): body exceeds 16 KiB.
- `relationship/schema-version-unsupported` (HTTP 422): unknown `schemaVersion`.
- `relationship/bad-request` (HTTP 400): malformed envelope (caught by the parser).

### 4.2 `POST /api/relationships`

Create a new relationship.

**Request**

```
POST /api/relationships
Content-Type: application/json
Idempotency-Key: <opaque 8..64 chars>

{
  "schemaVersion": "1",
  "proposal": { ...same as 4.1.proposal },
  "confidence": 0.83   // optional, [0, 1]
}
```

**Response (201)**

```
{
  "schemaVersion": "1",
  "relationship": {
    "id": "rel_...",
    "schemaVersion": "1",
    "type": "depends-on",
    "source": { ... },
    "target": { ... },
    "scope": { ... },
    "lifecycle": "active",
    "createdAt": "2026-06-06T12:00:00.000Z",
    "updatedAt": "2026-06-06T12:00:00.000Z",
    "etag": 0,
    "confidence": 0.83,
    "summary": "..."
  },
  "etag": "<etag>"
}
```

**Replay**: an identical `Idempotency-Key` with an identical body returns the original 201 with the original `id` and `etag`. An identical key with a divergent body returns `relationship/idempotency-replay-mismatch` (HTTP 409). See §5.

**Audit obligation**: persist one durable audit row (`relationship.created`) on success or `relationship.validation-denied` on denial. The live SSE activity stream remains a stub in the current implementation.

**Error codes (this route)**

- `relationship/idempotency-key-required` (HTTP 400).
- `relationship/idempotency-replay-mismatch` (HTTP 409).
- `relationship/policy-denied` (HTTP 422): the validator returned `allowed: false`. Body includes the `reasons` array.
- `relationship/payload-too-large` (HTTP 413): body exceeds 16 KiB.
- `relationship/schema-version-unsupported` (HTTP 422).
- `relationship/bad-request` (HTTP 400).
- `relationship/scope-not-permitted` (HTTP 403): caller scope does not include the proposal scope.

### 4.3 `GET /api/relationships`

Bounded list query.

**Query parameters**

| Name         | Type                       | Default | Cap                            |
| ------------ | -------------------------- | ------- | ------------------------------ |
| `sourceKind` | `RelationshipEndpointKind` | absent  | -                              |
| `sourceId`   | string                     | absent  | bounded by id schema           |
| `targetKind` | `RelationshipEndpointKind` | absent  | -                              |
| `targetId`   | string                     | absent  | -                              |
| `type`       | `RelationshipType`         | absent  | -                              |
| `lifecycle`  | `RelationshipLifecycle`    | absent  | -                              |
| `scopeKind`  | `MemoryScope.kind`         | absent  | filtered to caller's scope set |
| `scopeId`    | string                     | absent  | filtered to caller's scope set |
| `limit`      | integer                    | 64      | max 256                        |

At least one of `sourceKind+sourceId`, `targetKind+targetId`, `type`, or `lifecycle` MUST be present. A bare `GET /api/relationships` returns `relationship/bounded-query-required` (HTTP 400). This prevents accidental unbounded scans.

**Response (200)**

```
X-Truncated: false

{
  "schemaVersion": "1",
  "entries": [ <Relationship>, ... ],
  "limit": 64,
  "truncated": false,
  "nextCursor": null
}
```

`truncated` is `true` when `entries.length === limit` and at least one more row matches. `nextCursor` is non-null in that case.

**Audit obligation**: None. Reads do not emit audit events.

**Error codes (this route)**

- `relationship/bounded-query-required` (HTTP 400): no selective parameters.
- `relationship/bounded-query-exceeded` (HTTP 400): `limit > 256` or other cap exceeded.
- `relationship/bad-request` (HTTP 400): malformed query (e.g., unknown `sourceKind`).
- `relationship/scope-not-permitted` (HTTP 403).

### 4.4 `GET /api/relationships/:id`

Single relationship read.

**Response (200)**

```
{
  "schemaVersion": "1",
  "relationship": { <Relationship> },
  "etag": "<etag>"
}
```

**Error codes (this route)**

- `relationship/not-found` (HTTP 404): unknown id, or id in a workspace the caller cannot see.
- `relationship/scope-not-permitted` (HTTP 403): the caller's scope set does not include the row's scope.

### 4.5 `PATCH /api/relationships/:id`

Lifecycle transition or reconnection (e.g., `references-document` rebind when a path is renamed).

**Request**

```
PATCH /api/relationships/:id
Content-Type: application/json
If-Match: "<etag>"
Idempotency-Key: <opaque>

{
  "schemaVersion": "1",
  "transition": {
    "to": "archived",
    "summary": "operator archived"        // optional, <= 240 chars
  }
}
```

Valid `to` values come from the closed `RelationshipLifecycle` set ([taxonomy.md §6.1](taxonomy.md)). Reconnection is encoded as a second optional `reconnect` field:

```
{
  "schemaVersion": "1",
  "reconnect": {
    "target": { "kind": "workspace-path", "relPath": "src/new/path.ts" },
    "summary": "..."
  }
}
```

Exactly one of `transition` or `reconnect` MUST be present. Both present → `relationship/bad-request`.

**Response (200)**

```
{
  "schemaVersion": "1",
  "relationship": { <Relationship with updated lifecycle / endpoint> },
  "etag": "<new-etag>"
}
```

**Audit obligation**: persist one durable audit row (`relationship.updated`) on success. The current implementation does not emit a live `relationship:*` SSE mutation event here.

**Error codes (this route)**

- `relationship/optimistic-concurrency-conflict` (HTTP 412).
- `relationship/policy-denied` (HTTP 422): includes `denied/lifecycle-illegal-transition` or `denied/path-not-contained` etc.
- `relationship/idempotency-key-required` (HTTP 400).
- `relationship/idempotency-replay-mismatch` (HTTP 409).
- `relationship/not-found` (HTTP 404).
- `relationship/payload-too-large` (HTTP 413).

### 4.6 `DELETE /api/relationships/:id`

Soft-delete: transitions to `revoked` per [lifecycle.md](lifecycle.md). No row is removed from storage; revoked rows are retained for audit. Hard-deletion is reserved for retention sweeps (see [storage.md §5](storage.md)).

**Request**

```
DELETE /api/relationships/:id
If-Match: "<etag>"
Idempotency-Key: <opaque>
```

(No body.)

**Response (200)**

```
{
  "schemaVersion": "1",
  "relationship": { <Relationship with lifecycle: "revoked"> },
  "etag": "<new-etag>"
}
```

**Audit obligation**: persist one durable audit row (`relationship.deleted`). The current implementation does not emit a live `relationship:retracted` SSE event here.

**Error codes (this route)**: same set as PATCH.

### 4.7 `GET /api/relationships/:id/dependencies`

Bounded dependency walk from the focal relationship.

**Query parameters**

| Name        | Type                             | Default | Cap      |
| ----------- | -------------------------------- | ------- | -------- |
| `direction` | `outgoing` / `incoming` / `both` | `both`  | -        |
| `maxDepth`  | integer                          | 1       | max 3    |
| `maxNodes`  | integer                          | 256     | max 1024 |

**Response (200)**

```
{
  "schemaVersion": "1",
  "report": {
    "rootRelationshipId": "rel_...",
    "depthReached": 1,
    "truncated": false,
    "truncationReason": null,
    "relationships": [ <Relationship>, ... ],
    "endpoints": [ <RelationshipEndpoint>, ... ]
  }
}
```

The shape mirrors the `ImpactReport` from [gap-analysis.md Gap 8](gap-analysis.md). Truncation is signalled in-band via `truncated` and `truncationReason` (`"max-depth" | "max-nodes" | "max-relationships"`) and out-of-band via the `X-Truncated` header.

**Error codes (this route)**

- `relationship/bounded-query-exceeded` (HTTP 400): caller-requested cap exceeds the hard cap.
- `relationship/not-found` (HTTP 404).
- `relationship/scope-not-permitted` (HTTP 403).

### 4.8 `GET /api/relationships/impact`

Bounded impact analysis from a focal endpoint (not from a relationship id). Powers the inspector's "what depends on this?" view.

**Query parameters**

| Name               | Type                             | Default | Cap      |
| ------------------ | -------------------------------- | ------- | -------- |
| `endpointKind`     | `RelationshipEndpointKind`       | -       | required |
| `endpointId`       | string                           | -       | required |
| `direction`        | `outgoing` / `incoming` / `both` | `both`  | -        |
| `maxDepth`         | integer                          | 1       | max 3    |
| `maxNodes`         | integer                          | 256     | max 1024 |
| `maxRelationships` | integer                          | 512     | max 2048 |

For `workspace-path` endpoints, `endpointId` is the relative path string, which is passed through `assertContainedRealPath` before the walk starts.

**Response (200)**

```
{
  "schemaVersion": "1",
  "report": { <ImpactReport> }
}
```

**Error codes (this route)**

- `relationship/bounded-query-exceeded` (HTTP 400).
- `relationship/path-not-contained` (HTTP 400): for `workspace-path` endpoints.
- `relationship/scope-not-permitted` (HTTP 403).
- `relationship/bad-request` (HTTP 400).

### 4.9 `GET /api/relationships/:id/explain`

Returns the most recent `RelationshipPolicyDecision` for the relationship plus a body-free lifecycle history. Powers the inspector's "why is this `blocked`?" view.

**Response (200)**

```
{
  "schemaVersion": "1",
  "decision": {
    "allowed": false,
    "reasons": [
      { "endpoint": "target", "code": "denied/endpoint-tombstoned", "summary": "..." }
    ]
  },
  "lifecycle": [
    { "from": "draft", "to": "active",  "occurredAt": 1731000000000 },
    { "from": "active", "to": "stale",  "occurredAt": 1731010000000 }
  ]
}
```

Lifecycle history is bounded to the last 32 transitions (per [storage.md §4](storage.md)).

**Error codes (this route)**

- `relationship/not-found` (HTTP 404).
- `relationship/scope-not-permitted` (HTTP 403).

### 4.10 `GET /api/relationships/health`

Graph health summary: counts plus categorized findings already present in the relationship store. The current implementation does not paginate this route.

**Response (200)**

```
{
  "schemaVersion": "1",
  "checkedAt": 1731000000000,
  "totals": {
    "active": 1234,
    "stale": 17,
    "blocked": 2,
    "revoked": 89
  },
  "findings": {
    "orphanedEndpoints":          [{ "kind": "<RelationshipObjectKind>", "id": "<endpoint-id>" }],
    "orphanedEndpointsTruncated": false,
    "staleRelationships":         [{ "id": "rel-...", "type": "depends-on", "source": { ... }, "target": { ... }, "lifecycle": "stale" }],
    "staleRelationshipsTruncated": false,
    "blockedRelationships":        [{ "id": "rel-...", "lifecycle": "blocked", "...": "..." }],
    "blockedRelationshipsTruncated": false,
    "failedRelationships":         [{ "id": "rel-...", "lifecycle": "revoked", "...": "..." }],
    "failedRelationshipsTruncated": false,
    "invalidReferences":           [{ "id": "rel-...", "...": "..." }],
    "invalidReferencesTruncated":  false,
    "cycleParticipants":           [{ "id": "rel-...", "...": "..." }],
    "cycleScanTruncated":          false
  },
  "entries": [],
  "truncated": false,
  "nextCursor": null
}
```

The six finding categories are bounded per-category at `MAX_RELATIONSHIPS_PER_QUERY = 2048`. Each per-category `*Truncated` flag (and `cycleScanTruncated` for the cycle scan input) is set to `true` when the underlying scan would have returned more rows than the cap; partial results are still surfaced so the operator sees the most-relevant subset.

`failedRelationships` aliases the lifecycle terminal state `revoked` (the post-deletion/soft-revoke state per [lifecycle.md](lifecycle.md)). The wire-level field uses the operator-facing word "failed" while the store column stays `lifecycle = 'revoked'`; clients should treat `failedRelationships[*].lifecycle === "revoked"` as the canonical shape and not infer a separate lifecycle state.

`cycleParticipants` replaces the original "unused" category from issue [#542](https://github.com/oscharko-dev/Keiko/issues/542) acceptance criterion AC4. "Unused" would have required a workspace-object inventory port that the relationship store does not own; cycle detection covers the operationally critical health defect (relationship graphs that pin themselves into permanent re-evaluation loops) with the same bounded-scan budget. The substitution is recorded in [closure-evidence.md](closure-evidence.md).

The top-level `truncated` field is the back-compat signal for pre-#542 clients of routes 7/8 ([gap-analysis.md Gap 9](gap-analysis.md)). It is `true` when any per-category truncation flag inside `findings` is `true`, so a back-compat client that polls only the top-level signal still observes that the data is incomplete. The new categorized surface remains the recommended consumption path; the top-level `entries`/`nextCursor` are kept null for shape compatibility only.

Health is the current store-backed graph summary surface from [gap-analysis.md Gap 9](gap-analysis.md). The shipped implementation reads the existing relationship rows and returns a categorized summary; resolver-driven liveness mutation remains follow-up work.

**Audit obligation**: None. Health is read-only.

**Error codes (this route)**

- `relationship/scope-not-permitted` (HTTP 403).

### 4.11 `GET /api/relationships/events`

Server-Sent Events stub scoped to the caller. The current implementation opens the stream, emits a bootstrap `relationship:hello` event, and sends keepalive pings; per-kind `relationship:*` delivery remains follow-up work.

**Response (200, text/event-stream)**

Each event:

```
event: relationship:hello
data: {"schemaVersion":"1","kind":"relationship:hello"}

```

The bootstrap event is sufficient for stream-health checks. Per-kind subscriptions are reserved for the later activity-delivery work.

**Audit obligation**: None at the route boundary; the events themselves are emitted as a consequence of mutations elsewhere.

**Error codes (this route)**

- `relationship/scope-not-permitted` (HTTP 403): scope mismatch.

## 5. Idempotency

The replay-protection model. Restated from [architecture.md §6.1](architecture.md).

- Mutating routes (POST, PATCH, DELETE) MUST carry `Idempotency-Key: <opaque 8..64 chars>`. Absent → `relationship/idempotency-key-required` (HTTP 400).
- The current implementation applies replay caching only to `POST /api/relationships`. It maintains a process-local `Map` with TTL 10 minutes and capacity 1024.
- On replay (identical key):
  - Identical body hash → return the cached result with HTTP 200/201 as appropriate (the original status).
  - Divergent body hash → `relationship/idempotency-replay-mismatch` (HTTP 409).
- On cache miss (no record) → execute the mutation, cache the result, return.

**Body hash** in the current implementation is a deterministic djb2-style hash over the raw JSON request body.

The cache is **not** durable: a server restart invalidates the cache. This is acceptable because the deployed BFF is a single process. A cross-process cache is explicitly out of scope (per [architecture.md §6.1](architecture.md)).

## 6. Optimistic concurrency

The stale-write protection model. Restated from [architecture.md §6.2](architecture.md).

- Every relationship row carries an `etag` column populated by the server on every write. The etag is a monotonic-per-row token (`printf('%016x', updated_at) || '-' || random_suffix`, where `updated_at` is in epoch ms and the suffix is a 6-char random alphabetic tiebreaker for sub-millisecond collisions). The complete algorithm is in [storage.md §4](storage.md).
- PATCH and DELETE MUST carry `If-Match: "<etag>"`. Absent → `relationship/optimistic-concurrency-required` (HTTP 428).
- The server compares the supplied etag against the current row's etag before the store mutation. Mismatch → `relationship/optimistic-concurrency-conflict` (HTTP 412). Body:

  ```
  {
    "error": {
      "code": "relationship/optimistic-concurrency-conflict",
      "message": "The relationship was modified by another writer."
    }
  }
  ```

- The client refetches via `GET /api/relationships/:id` and retries with the new etag.

## 7. Bounded queries

The unbounded-walk-protection model. Restated from [architecture.md §6.5](architecture.md).

| Concern               | Default | Hard cap | Error on exceed                       |
| --------------------- | ------- | -------- | ------------------------------------- |
| `limit` (list)        | 64      | 256      | `relationship/bounded-query-exceeded` |
| `maxDepth`            | 1       | 3        | `relationship/bounded-query-exceeded` |
| `maxNodes`            | 256     | 1024     | `relationship/bounded-query-exceeded` |
| `maxRelationships`    | 512     | 2048     | `relationship/bounded-query-exceeded` |
| Request body size     | -       | 16 KiB   | `relationship/payload-too-large`      |
| Idempotency-Key TTL   | -       | 10 min   | (POST replay cache only)              |
| ETag tiebreaker chars | 6       | 6        | server-controlled                     |

The truncation contract: a server-applied cap (e.g., `maxNodes` reached before `maxDepth`) populates `truncated: true` and `truncationReason: "max-nodes"` in the body. The walk never throws; it returns a partial report and the client decides whether to follow up.

## 8. Response redaction

Every response body, every persisted row, every audit envelope, and every SSE event is passed through `createAuditRedactor` and `deepRedactStrings` from [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts).

Concretely:

- The handler builds the response object.
- Before serialization, the handler invokes `deepRedactStrings(body)` (the helper is idempotent).
- The serializer writes the redacted JSON.

This is the same two-barrier convention the BFF UI persistence layer applies for `durable.ui` writes (per [ADR-0030 rule 5](../adr/ADR-0030-workspace-security-evidence.md)).

A test in [`packages/keiko-server/src/`](../../packages/keiko-server/src/) (issue #539) MUST assert that a relationship row whose `summary` field is engineered to look like an API key returns a redacted string at the wire boundary. The existing `conversation-audit.test.ts` shape at [`packages/keiko-server/src/conversation-audit.test.ts`](../../packages/keiko-server/src/conversation-audit.test.ts) is the template.

## 9. Audit obligations

Every mutation persists a durable audit entry. The exact ledger shape — including future `EvidenceManifest` embedding — is owned by ADR-0032 (issue #536). Live `relationship:*` SSE activity remains stubbed in the current implementation.

| Route                           | Durable audit entry kind                                   |
| ------------------------------- | ---------------------------------------------------------- |
| POST `/api/relationships`       | `relationship.created` or `relationship.validation-denied` |
| PATCH `/api/relationships/:id`  | `relationship.updated`                                     |
| DELETE `/api/relationships/:id` | `relationship.deleted`                                     |
| Truncated impact analysis       | `relationship.impact-analysis-bounded`                     |

Every emitted summary is body-free per [taxonomy.md §12](taxonomy.md) and bounded to 240 chars per `MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS` at [`packages/keiko-contracts/src/memory-audit-events.ts:35`](../../packages/keiko-contracts/src/memory-audit-events.ts).

## 10. Deterministic error code catalogue

All transport-layer error codes the BFF can emit. The `denied/*` codes ride on top of `relationship/policy-denied` (HTTP 422) and are listed in [denial-reasons.md](denial-reasons.md).

| Code                                           | HTTP | Where                                                    |
| ---------------------------------------------- | ---- | -------------------------------------------------------- |
| `relationship/bad-request`                     | 400  | Any                                                      |
| `relationship/bounded-query-required`          | 400  | GET list                                                 |
| `relationship/bounded-query-exceeded`          | 400  | GET list, GET dependencies, GET impact, GET health       |
| `relationship/cursor-expired`                  | 400  | GET list, GET impact, GET health                         |
| `relationship/idempotency-key-required`        | 400  | POST, PATCH, DELETE                                      |
| `relationship/path-not-contained`              | 400  | GET impact (workspace-path), POST, PATCH                 |
| `relationship/scope-not-permitted`             | 403  | Any cross-workspace attempt                              |
| `relationship/sse-not-permitted`               | 403  | GET events                                               |
| `relationship/not-found`                       | 404  | GET single, PATCH, DELETE, GET dependencies, GET explain |
| `relationship/idempotency-replay-mismatch`     | 409  | POST, PATCH, DELETE                                      |
| `relationship/optimistic-concurrency-required` | 428  | PATCH, DELETE                                            |
| `relationship/optimistic-concurrency-conflict` | 412  | PATCH, DELETE                                            |
| `relationship/payload-too-large`               | 413  | POST, PATCH                                              |
| `relationship/policy-denied`                   | 422  | POST, PATCH (body carries the `denied/*` reasons)        |
| `relationship/schema-version-unsupported`      | 422  | Any                                                      |
| `relationship/internal-error`                  | 500  | Any (last-resort)                                        |

The `denied/*` codes inside `policy-denied` are enumerated in [denial-reasons.md §"Catalog"](denial-reasons.md): `denied/non-existent-source`, `denied/non-existent-target`, `denied/object-kind-not-yet-supported`, `denied/source-kind-not-allowed`, `denied/target-kind-not-allowed`, `denied/kind-incompatible`, `denied/cardinality-exceeded`, `denied/cycle-forbidden`, `denied/cross-workspace`, `denied/path-not-contained`, `denied/denied-by-deny-list`, `denied/lifecycle-illegal-transition`, `denied/endpoint-tombstoned`, `denied/endpoint-retired`, `denied/endpoint-unavailable`, `denied/payload-content-not-permitted`, `denied/authority-insufficient`, `denied/schema-version-unsupported`.

## 11. Wire-shape testing obligation (binding for #539)

Issue #539 MUST add to [`packages/keiko-server/src/routes.test.ts`](../../packages/keiko-server/src/routes.test.ts) (or a sibling test file) the following assertions:

1. Each of the eleven routes in §2 is registered in `API_ROUTES`.
2. Each mutating route rejects a missing `Idempotency-Key`.
3. Each PATCH / DELETE rejects a missing `If-Match`.
4. The validator runs **before** persistence (test: a denied proposal returns 422 with `policy-denied` and the row count is unchanged).
5. The redactor runs on every response (test: an injected secret-shaped `summary` is scrubbed at the wire boundary).
6. The bounded-query caps are enforced (test: `limit=500` returns 400 with `bounded-query-exceeded`).
7. The scope filter rejects cross-workspace reads (test: a row created in workspace A is invisible to a caller resolved to workspace B).
8. The SSE stream emits per-kind events with correct `event:` field names.

The tests are scoped to the BFF and do not require the validator engine itself to be implemented (issue #538). Stubs are acceptable for issue #539's red phase.

## 12. References

- [architecture.md](architecture.md), [storage.md](storage.md), [security-checklist.md](security-checklist.md)
- [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md)
- [gap-analysis.md](gap-analysis.md), [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [adr-candidates.md](adr-candidates.md)
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#535](https://github.com/oscharko-dev/Keiko/issues/535).
