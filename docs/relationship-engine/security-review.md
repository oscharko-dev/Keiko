# Relationship engine — security review evidence (#543)

Status: Issue [#543](https://github.com/oscharko-dev/Keiko/issues/543) hardening evidence for Epic [#532](https://github.com/oscharko-dev/Keiko/issues/532).

This document records the security verification for the relationship engine after #538–#542 landed on the epic branch. Findings are cited by `file.ts:line` against the epic branch tip.

## Scope verified

- Workspace containment on every read and write API path.
- Server-authoritative validation BEFORE persistence.
- Single redactor call site on every response and audit row.
- Forbidden-key rejector at every payload-accepting boundary.
- No relationship existence grants model / tool / workspace / patch / evidence / local-knowledge / memory authority.
- Audit ledger append-only and workspace-scoped.
- Cross-workspace denial does not leak foreign identifiers.

## Verified controls

### 1. Workspace scope enforced at the SQL barrier

Every store function in [`packages/keiko-server/src/store/relationships.ts`](../../packages/keiko-server/src/store/relationships.ts) accepts `workspaceId` as a required parameter and filters by `workspace_scope_id = ?` in every SELECT/UPDATE/DELETE. The store has NO unscoped query path.

- `getRelationship(id, workspaceId)` (`sqlGetRelationship`)
- `listRelationships(query)` (`buildListClauses` always seeds `workspace_scope_id = ?`)
- `walkDependencies` / `computeImpact` / `graphHealth` (all workspace-scoped)
- Migration V5 enforces `workspace_scope_id` `NOT NULL`. There is deliberately NO foreign key from `relationships` to `projects` (see [`schema.ts:79`](../../packages/keiko-server/src/store/schema.ts) comment); endpoint liveness is resolved at the API edge through the `RelationshipEndpointResolver` port (per [storage.md §2.2](storage.md)).

### 2. Server-authoritative validation BEFORE persistence

Every mutating route in [`packages/keiko-server/src/relationship-handlers.ts`](../../packages/keiko-server/src/relationship-handlers.ts) invokes the pure `validateRelationship` from `@oscharko-dev/keiko-contracts` BEFORE the store INSERT/UPDATE/DELETE. Frontend hints exist but are not authoritative; a malformed direct API call is rejected exactly like a well-formed denied one.

- POST `/api/relationships` — `performCreate` validates then inserts in one transaction.
- PATCH `/api/relationships/:id` — `performPatchPreflight` re-validates the proposed state via `applyTransition` / `applyReconnect`.
- DELETE `/api/relationships/:id` — soft-deletes to `revoked` per lifecycle rules.

### 3. Single redactor call site on every response

`respond()` in `relationship-handlers.ts` is the sole site for JSON response bodies. Every JSON handler returns through `runHandler` → `respond` → live redactor. The redactor itself lives in `packages/keiko-security/src/redaction.ts` and is unchanged by this epic. The SSE channel (Route 11 `GET /api/relationships/events`) emits only static framing literals (`event: relationship:hello`, keep-alive `: ping`) and carries no user data; the follow-up that wires per-kind activity delivery (closure-evidence.md §"Known limitations") MUST route dispatched event bodies through the redactor before write.

### 4. Forbidden-key rejector at every payload-accepting boundary

The forbidden-substring list `RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS` is exported once from `packages/keiko-contracts/src/relationships.ts` and applied at three boundaries:

- Validator metadata gate: `relationships-validation.ts` (rejects `metadata` with any forbidden key — case-insensitive substring after lowercase + non-alphanumeric strip).
- Audit ledger writer: `packages/keiko-server/src/store/relationship-audit.ts` `assertNoForbiddenKeys` (rejects `payload_json` with any forbidden key; recurses into nested records).
- Activity stream client: `packages/keiko-ui/src/app/components/desktop/widgets/panels/useRelationshipActivityStream.ts` drops SSE messages whose payload contains a forbidden key (test pinned).

The 10 forbidden substrings are `prompt`, `documentcontent`, `filecontent`, `toolstdout`, `toolstderr`, `secret`, `credential`, `apikey`, `password`, `token`. Casing/punctuation variants (e.g., `promptText`, `API_KEY`, `api-key`) are normalized via the lowercase + non-alphanumeric-strip + substring rule before comparison, so no payload key containing any of these substrings reaches storage or the wire.

### 5. No relationship-existence-implied authority

The inspector renders the verbatim authority disclaimer `"Relationship: governance only. No model/tool/file/workflow authority granted."` at every selected relationship. The disclaimer is also enforced by ADR-0031 §"Composition rules" and by the architecture document. There is NO code path in the relationship engine that calls a model gateway, a tool runner, a patch applier, a workspace writer, or an evidence builder by virtue of a relationship row existing.

### 6. Audit ledger append-only and workspace-scoped

`relationship_audit_entries` table has no UPDATE or DELETE SQL emitted from production code. The migration V5 SQL creates the table; the `relationship-audit.ts` module only INSERTs. Tests in `relationship-audit.test.ts` assert the append-only invariant.

### 7. Cross-workspace denial does not leak

`validateRelationship` returns `denied/cross-workspace` for any relationship whose source / target workspace identifiers disagree with the relationship's own `workspaceId`. The denial message is workspace-id-free and is asserted by an explicit test in `relationships-validation.test.ts` (describe `validateRelationship — cross-workspace body-free`).

## Findings

| Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                      | Disposition                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| LOW      | The UI panels render a friendly error message ("Server error") instead of the raw upstream error text. This is a deliberate UX choice that prevents leaking internal error details to the workspace operator. Two UI tests assumed raw verbatim error rendering and have been adjusted (`role="alert"` query) or remain skipped with documented `TODO(#543)` markers for selector tightening in a follow-up. | Accepted; not a regression.   |
| LOW      | `getEtag` returns the current etag in plaintext via the GET-single-relationship route. Etags are random opaque identifiers and do not encode workspace or endpoint identifiers; leakage carries no privilege.                                                                                                                                                                                                | Accepted; no change required. |
| INFO     | The categorized health findings added in #542 do not yet have a UI surface — `RelationshipImpactCard`, `RelationshipDependencyPanel`, `RelationshipHealthPanel` are deferred to a follow-up issue (see `closure-evidence.md`). Backend contracts are stable; no security implication.                                                                                                                        | Deferred to a follow-up.      |

No CRITICAL or HIGH findings. No new third-party dependency was introduced.
