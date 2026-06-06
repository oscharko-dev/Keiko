# Epic #532 — Audit and Activity Implementation Checklist

Status: Wave 3 deliverable for [issue #536](https://github.com/oscharko-dev/Keiko/issues/536) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [audit-events.md](audit-events.md), [activity-state.md](activity-state.md), [evidence-references.md](evidence-references.md), [retention-and-privacy.md](retention-and-privacy.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md).

Date: 2026-06-06.

## 1. Purpose

This checklist is the binding implementation contract for issues [#539](https://github.com/oscharko-dev/Keiko/issues/539) (relationship APIs) and [#541](https://github.com/oscharko-dev/Keiko/issues/541) (privacy-preserving activity visualization), and the verification slot list for [#543](https://github.com/oscharko-dev/Keiko/issues/543) (hardening pass).

Each item below has a normative statement, the contract surface it derives from, and a verifiable test obligation.

No new database, no new package, no new third-party dependency.

## 2. Mutation route obligations

### 2.1 Every mutating route emits the correct audit-event kind

| Route                              | Audit-event kind(s) emitted                                                                                                                                                                                  | Surface                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST /api/relationships`          | `relationship.created` on accept; `relationship.validation-denied` or `relationship.policy-denied` on deny.                                                                                                  | Sibling table (and evidence manifest for run-scoped per [audit-events.md §5.3](audit-events.md)). |
| `PATCH /api/relationships/:id`     | `relationship.updated` on accept; `relationship.policy-denied` on deny. May emit `relationship.activity-transitioned` if `lifecycle` is in `changedFields`.                                                  | Same.                                                                                             |
| `DELETE /api/relationships/:id`    | `relationship.deleted` on accept; `relationship.policy-denied` on deny.                                                                                                                                      | Same.                                                                                             |
| `POST /api/relationships/validate` | None (dry-run; no row touched).                                                                                                                                                                              | N/A.                                                                                              |
| Health-check pass (route 10)       | `relationship.health-finding` per relationship inspected; `relationship.activity-transitioned` when committing `* → stale` or `stale → active`. The reconnection case also emits `relationship.reconnected`. | Sibling table (and evidence manifest if run-context).                                             |
| `GET /api/relationships/impact`    | `relationship.impact-analysis-bounded` when `truncated: true`.                                                                                                                                               | Sibling table.                                                                                    |

**Verification**: a route-level test per row inserts a known input, observes the emitted audit kind(s), and asserts the absence of unrelated kinds.

### 2.2 Audit-row placement obeys the per-row-class rule

The placement rule from [audit-events.md §5.3](audit-events.md):

- `sourceKind === "workflow-run"` with an in-flight `evidenceRunId` ⇒ `EvidenceManifest.relationships?`.
- Otherwise ⇒ `relationship_audit_entries` sibling table.

The dual-write prohibition is structural: each event handler MUST select exactly one surface and document the selection in the call site.

**Verification**: a placement test asserts that for each mutation kind and each source-kind permutation, the audit row appears in exactly one of the two surfaces.

## 3. Redaction obligations

### 3.1 Single call site

Every audit-row writer routes through:

```ts
const redact = createAuditRedactor(redactionConfig, env);          // src/security/redaction.ts:96
const safePayload = deepRedactStrings(payload, redact) as ...;     // src/security/redaction.ts:114
```

No additional redactor, no additional regex, no additional shape detector.

**Verification**: a redaction-before-persist test seeds a payload containing every known secret shape from `BUILTIN_PATTERNS` ([`packages/keiko-security/src/redaction.ts:34`](../../packages/keiko-security/src/redaction.ts)) plus a known KEIKO_DEFAULT_API_KEY value; the persisted row contains `[REDACTED]` in place of each.

### 3.2 `redaction_state` column wired correctly

- Sibling-table writes set `"redacted-on-write"`.
- Evidence-manifest writes set `"redacted-on-write-and-persist"`.

**Verification**: a `redaction_state` test inserts both kinds and reads back the column.

### 3.3 Persist-time deep-redact retained for the evidence path

The persist-time pass at [`packages/keiko-evidence/src/persist.ts:50`](../../packages/keiko-evidence/src/persist.ts) is not bypassed for the new `relationships?` section.

**Verification**: a defense-in-depth test runs the evidence build with a deliberately-leaky builder mock; the persisted manifest still contains `[REDACTED]`.

## 4. Workspace-scope obligations

### 4.1 Every read filters by workspace

All read routes ([api-contract.md §4](api-contract.md)) inject a `workspaceId` clause as the first SQL filter. No route reaches the database without one.

**Verification**: a scope-filter test creates audit rows in workspaces A and B; a reader in A sees only A's rows.

### 4.2 Cross-workspace denial carries no id

`relationship.policy-denied` with `reasons[].code === "denied/cross-workspace"` MUST NOT include `proposedSourceId` or `proposedTargetId` in the persisted payload.

**Verification**: a cross-workspace-leak test issues a deliberately cross-workspace proposal; the persisted denial row's `payload_json` does not contain either id.

### 4.3 Evidence refs are workspace-scoped

`RelationshipEvidenceRef.manifestPath` resolves only to the caller's workspace evidence root.

**Verification**: a workspace-evidence-isolation test attempts to register a ref pointing to a foreign workspace's evidence file; the validator returns `denied/path-not-contained`.

## 5. Activity-state obligations

### 5.1 Computation is pure and bounded

The activity-derivation function is pure (no side effects beyond reading injected ports) and O(active-workflows) per workspace per derivation tick (per [activity-state.md §5.1](activity-state.md)).

**Verification**: a determinism test runs the derivation twice with the same in-memory event log and the same durable snapshot; both runs produce byte-identical `RelationshipActivity` arrays.

A bounded-derivation test creates 10,000 inactive relationships and 5 active workflows; the derivation cost is dominated by the 5 active runs, not the 10,000 rows.

### 5.2 No activity payload field appears in any stored row

The FORBIDDEN list from [audit-events.md §8.3](audit-events.md) plus the activity-specific bans from [activity-state.md §7](activity-state.md) are enforced at the type level (no field exists) and at the call-site level (no code path writes one).

**Verification**: a no-activity-persistence test asserts that the activity-derivation module's import graph contains zero `fs.write*` calls and zero `db.prepare("INSERT" | "UPDATE")` calls.

### 5.3 Bounded-render cap

At most `N_VISIBLE = 25` animated activity states render concurrently in the controlled graph view; beyond that, an aggregate badge.

**Verification**: a bounded-render test mounts the inspector with 100 relationships all in `processing`; the DOM contains 25 animated badges plus one aggregate badge.

### 5.4 Accessibility — no color-only, no motion-only

Per [activity-state.md §6](activity-state.md). Every badge has text label + ARIA description + icon hint as load-bearing; color and motion are optional accents.

**Verification**:

- A no-color test renders the activity badge with CSS disabled; jest-axe + visual snapshot still distinguishes the state by shape and label.
- A reduced-motion test sets `prefers-reduced-motion: reduce` in the test renderer; the `processing` badge is static.
- An ARIA test inspects every badge and asserts `role="status"`, `aria-live="polite"`, a non-empty `aria-description` / visually-hidden description, and a visible text label.

## 6. Append-only obligations

### 6.1 No UPDATE on `relationship_audit_entries`

Outside the migration runner, no code path issues `UPDATE relationship_audit_entries`. The `(workspace_id, sequence)` UNIQUE index is the second barrier.

**Verification**: an append-only test attempts to update a row; the validation gate ([storage.md §4](storage.md)) rejects it.

### 6.2 Sequence monotonicity per workspace

Every audit insert acquires the next sequence atomically inside the transaction; gaps in `sequence` per workspace are diagnostic, not silent.

**Verification**: a sequence-monotonicity test inserts 1000 audit rows under concurrency; the resulting sequence column has no duplicates and no gaps.

### 6.3 Tombstones outlive linked evidence

Per [evidence-references.md §5](evidence-references.md) and [retention-and-privacy.md §3.5](retention-and-privacy.md): a `revoked` relationship row is not evicted while any non-retired `EvidenceManifest.relationships?` entry names it.

**Verification**: a retention-coupling test creates a relationship, runs an evidence-emitting workflow against it, deletes the relationship, runs the retention sweep with the manifest still retained; the row remains.

## 7. FORBIDDEN-field reject

### 7.1 Type-level rejection

The TypeScript types in [audit-events.md §4](audit-events.md) do not include any FORBIDDEN field (per [audit-events.md §8.3](audit-events.md)). A caller cannot construct a payload carrying one without `as any` (which the lint rule bans).

**Verification**: a type-narrowing test asserts that `keyof RelationshipAuditEnvelope` and the per-kind unions do not include `"prompt" | "rawOutput" | "stdout" | "stderr" | "patchBody" | "documentBody" | "apiKey" | "token" | "credential" | "pii" | "email"`.

### 7.2 Runtime rejection of bypass attempts

If a future code path attempts to add a field via `payload_json` directly (bypassing the typed builder), the validator at [`packages/keiko-server/src/store/validation.ts`](../../packages/keiko-server/src/store/validation.ts) — extended by #538 — rejects the row before insert.

**Verification**: a forbidden-field-runtime test crafts a raw insert with `payload_json` containing a forbidden key; the validator rejects.

## 8. SSE wire obligations

### 8.1 Per-kind subscription

The SSE activity stream at `GET /api/relationships/events` uses `addEventListener("relationship:accepted", …)` style per-kind subscription (per [lifecycle.md §4](lifecycle.md) and the Epic #13 event-name discipline).

**Verification**: an SSE subscription test asserts that an unrelated event kind does not fire the `accepted` listener.

### 8.2 Body-free wire payloads

SSE messages carry `relationshipId`, `kind`, `occurredAt`, `scope`, optional bounded `summary` (≤240 chars, redacted). Nothing else.

**Verification**: an SSE wire-shape test inspects an emitted SSE frame; the parsed body has only the documented keys.

## 9. Health-check obligations

### 9.1 Bounded health pass

A single pass walks at most `limit: 64` rows by default (capped at 256 per [api-contract.md §4.10](api-contract.md)) and emits at most one `relationship.health-finding` per inspected relationship.

**Verification**: a bounded-health test creates 1000 relationships and one health-pass invocation; the audit-row delta is ≤64.

### 9.2 Health pass writes `stale` and emits `relationship.reconnected` on recovery

Per [audit-events.md §4.4](audit-events.md): the only path that emits `relationship.reconnected` is the health pass observing a `stale → active` recovery.

**Verification**: a recovery test sets up a `stale` relationship whose endpoint becomes `live`; the next pass emits exactly one `relationship.reconnected` and one `relationship.activity-transitioned`.

## 10. Local-only obligations

### 10.1 No new outbound network code

The relationship engine code (under the new `src/` paths added by #538 / #539) does NOT import `node:http`, `node:https`, `node:net`, or any third-party HTTP/network library.

**Verification**: an import-graph test parses the relationship-engine module set and asserts the absence of those imports.

### 10.2 No new logger sinks

Audit summaries are written to local SQLite columns only. No `console.error(... payload ...)`, no third-party logger transport, no remote stream.

**Verification**: a logger-leak test runs the audit writers under a stubbed `console.error` spy; the spy receives no FORBIDDEN-field content.

## 11. Retention obligations

### 11.1 Bounded retention sweep

The sweep evicts at most 1024 rows per pass (per [retention-and-privacy.md §3.2](retention-and-privacy.md)) and is gated by the always-keep-newest and evidence-pin rules.

**Verification**: a bounded-sweep test creates 2048 evictable rows; the sweep evicts exactly 1024 in pass 1 and 1024 in pass 2.

### 11.2 Always-keep-newest

The most recent audit row per `(workspace_id, relationship_id, kind)` is retained while the relationship row exists.

**Verification**: a keep-newest test creates 10 audit rows of the same kind for one relationship; the sweep with `maxAuditEntriesPerWorkspace = 5` retains the newest one regardless of total cap.

## 12. Sign-off matrix

A `#536` reviewer can answer each of the issue's acceptance criteria by pointing at the corresponding row.

| Acceptance criterion                                                                                                                        | Section(s) carrying the contract                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Model distinguishes durable audit events from transient activity state.                                                                     | [audit-events.md](audit-events.md) and [activity-state.md](activity-state.md) — entirely disjoint schemas and write paths. |
| No activity state requires raw prompts, document contents, file contents, tool output, model output, secrets, credentials, or private logs. | [activity-state.md §3, §7](activity-state.md), [audit-events.md §8.3](audit-events.md).                                    |
| Audit events are redacted, scoped, and append-oriented.                                                                                     | [audit-events.md §7, §9, §10](audit-events.md), [retention-and-privacy.md §4](retention-and-privacy.md).                   |
| Evidence references point to existing evidence artifacts instead of duplicating evidence content.                                           | [evidence-references.md](evidence-references.md) entirely.                                                                 |
| Activity states can be rendered accessibly without relying on color or motion alone.                                                        | [activity-state.md §6](activity-state.md).                                                                                 |
| No new dependency is proposed.                                                                                                              | Every doc in the set; no `package.json` edits.                                                                             |

## 13. References

- [audit-events.md](audit-events.md), [activity-state.md](activity-state.md), [evidence-references.md](evidence-references.md), [retention-and-privacy.md](retention-and-privacy.md)
- [storage.md](storage.md), [api-contract.md](api-contract.md), [lifecycle.md](lifecycle.md), [denial-reasons.md](denial-reasons.md), [security-checklist.md](security-checklist.md), [architecture.md](architecture.md)
- [`packages/keiko-security/src/redaction.ts`](../../packages/keiko-security/src/redaction.ts), [`packages/keiko-evidence/src/persist.ts`](../../packages/keiko-evidence/src/persist.ts), [`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts)
- [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#536](https://github.com/oscharko-dev/Keiko/issues/536).
