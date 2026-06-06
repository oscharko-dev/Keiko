# ADR-0032: Relationship engine — audit, evidence, and activity-state model

## Status

Proposed (Epic #532, issue #536, 2026-06-06). Locks the privacy and durability contract for the semantic relationship engine: which mutations write durable audit events, how those events are shaped and persisted, how evidence is referenced without duplication, and why activity state is transient by construction. ADR-0031 (issue #535) covers policy, validation, and storage; ADR-0033 (issue #537) covers UI containment.

## Context

Epic [#532](https://github.com/oscharko-dev/Keiko/issues/532) introduces a cross-domain relationship engine. ADR-0031 locked the storage placement (relationship rows live in the existing UI-persistence SQLite database) and the validation surface (server-authoritative, deterministic, pure function). [`docs/relationship-engine/storage.md §4.3`](../relationship-engine/storage.md) explicitly deferred the audit-row table shape, the redaction wiring for the new persistence sites, and the activity model to issue #536.

What was still open after ADR-0031:

- **Durable audit-event vocabulary**: the closed set of relationship audit kinds, the per-kind schema, the field classification (durable / transient / FORBIDDEN), the persistence-surface-per-row-class.
- **Activity-state model**: whether activity state is persisted (it must NOT be), the closed set of states, the source-event-stream-per-state, the bounded-render contract, the non-color / non-motion accessibility rules.
- **Evidence-reference shape**: how a relationship points at an evidence manifest without duplicating its content, how tombstones survive deletion while still referenced.
- **Local-only invariant**: the explicit non-telemetry guarantee for the activity layer.

These decisions cannot be safely inferred from the existing code or ADRs. ADR-0032 records the bindings.

## Decision

### 1. Durable audit events: append-only, redacted-on-write, workspace-scoped

The relationship engine emits a **closed set** of nine audit-event kinds (per [`docs/relationship-engine/audit-events.md §3`](../relationship-engine/audit-events.md)):

1. `relationship.created`
2. `relationship.updated`
3. `relationship.deleted`
4. `relationship.reconnected`
5. `relationship.validation-denied`
6. `relationship.policy-denied`
7. `relationship.activity-transitioned`
8. `relationship.impact-analysis-bounded`
9. `relationship.health-finding`

Each event carries a versioned envelope (`relationshipAuditSchemaVersion: "1"`, `eventId`, monotone `sequence` per workspace, `workspaceId`, `occurredAt`, redacted `actor`, `redactionState`, bounded `summary`) plus kind-specific fields (per [`audit-events.md §4`](../relationship-engine/audit-events.md)). The vocabulary mirrors the existing memory audit pattern at [`packages/keiko-contracts/src/memory-audit-events.ts:41`](../../packages/keiko-contracts/src/memory-audit-events.ts).

### 2. Two persistence surfaces, one per row-class, never both

Audit rows land on exactly one of:

- **`EvidenceManifest.relationships?` section** — added additively to the existing `EvidenceManifest` ([`packages/keiko-contracts/src/evidence.ts:276`](../../packages/keiko-contracts/src/evidence.ts)) for run-scoped mutations. Persisted via the existing `persistEvidence` pipeline ([`packages/keiko-evidence/src/persist.ts:39`](../../packages/keiko-evidence/src/persist.ts)); inherits `DEFAULT_RETENTION: { maxRuns: 50 }` ([`evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)).
- **`relationship_audit_entries` sibling table** — added in the same V5 SQLite migration as `relationships` in the existing UI-persistence database ([`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts)). Co-located so the audit insert shares the relationship row's `BEGIN`/`COMMIT`.

The placement rule (per [`audit-events.md §5.3`](../relationship-engine/audit-events.md)) is **deterministic per row**:

- `sourceKind === "workflow-run"` with an in-flight `evidenceRunId` ⇒ manifest section.
- Otherwise ⇒ sibling table.

Dual writes are forbidden; every audit event lives in exactly one place. The DDL of the sibling table is in [`audit-events.md §5.5`](../relationship-engine/audit-events.md).

### 3. Redaction-on-write via the existing redactor

Every persisted audit payload passes through the existing [`packages/keiko-security/src/redaction.ts`](../../packages/keiko-security/src/redaction.ts) pipeline at the persist boundary:

1. `createAuditRedactor(config, env)` ([`redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)) builds the redactor closure;
2. `deepRedactStrings(payload, redact)` ([`redaction.ts:114`](../../packages/keiko-security/src/redaction.ts)) re-applies it across every string leaf.

The pipeline is idempotent ([`redaction.ts:111`](../../packages/keiko-security/src/redaction.ts)). Sibling-table rows record `redactionState: "redacted-on-write"`; evidence-manifest rows record `"redacted-on-write-and-persist"` (the persist-time pass at [`persist.ts:50`](../../packages/keiko-evidence/src/persist.ts) re-runs).

No new redactor, no new regex, no new secret-shape detector.

### 4. Activity state is transient, derived, never persisted

The `RelationshipActivity` model (per [`docs/relationship-engine/activity-state.md`](../relationship-engine/activity-state.md)) defines nine **in-memory-only** states (`inactive`, `queued`, `active`, `processing`, `completed`, `failed`, `blocked`, `degraded`, `high-throughput`). Each state is derived from existing event streams (harness/workflow/bug events at [`packages/keiko-contracts/src/harness.ts:189`–`321`](../../packages/keiko-contracts/src/harness.ts), [`unit-test-events.ts:58`–`135`](../../packages/keiko-contracts/src/unit-test-events.ts), [`bug-investigation-events.ts:63`–`146`](../../packages/keiko-contracts/src/bug-investigation-events.ts)) plus already-redacted durable rows (`relationships.lifecycle`, `relationship_audit_entries`).

**No code path under the activity derivation writes to disk or to the network.** State is recomputed from the durable sources on every restart. The derivation cost is O(active-workflows) per workspace, bounded by `N_VISIBLE = 25` concurrently-animated badges in the UI and an aggregate-count fallback beyond.

### 5. Non-color, non-motion accessibility

Each activity state carries four descriptors: stable text label, semantic ARIA description, icon/pattern hint, optional color hint. A renderer MUST use at least the first three; color and motion are accents. `prefers-reduced-motion: reduce` and `prefers-contrast: more` are honoured (per [`activity-state.md §6`](../relationship-engine/activity-state.md)). This satisfies the issue #536 acceptance criterion and aligns with the dark-Keiko-palette WCAG discipline established by [ADR-0014 lineage](https://github.com/oscharko-dev/Keiko/issues/63).

### 6. Evidence references are pointers, not embeddings

`RelationshipEvidenceRef` (per [`docs/relationship-engine/evidence-references.md §2`](../relationship-engine/evidence-references.md)) is a four-field opaque pointer (`evidenceRunId`, `manifestPath`, `manifestSchemaVersion`, `kind`). It never inlines evidence content. The read API at `GET /api/relationships/:id/explain` returns refs but never proxies evidence bytes; the UI navigates to the existing evidence viewer.

Deleting a relationship that has active evidence refs creates a tombstone (the row transitions to `lifecycle = "revoked"`; the row is retained until the last referencing manifest ages out under `DEFAULT_RETENTION: { maxRuns: 50 }`). This mirrors the memory-vault tombstone pattern at [`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts) but applied at the index layer: the relationship row IS the tombstone.

### 7. Local-only, no telemetry

Audit rows, activity state, and evidence references **never leave the local Keiko runtime** (per [`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md) and [`retention-and-privacy.md §2`](../relationship-engine/retention-and-privacy.md)). No remote analytics endpoint, no third-party logger, no cloud sync. The activity layer is presentation only; it is **not** a telemetry stream and may not be re-purposed as one without superseding this ADR.

## Alternatives considered

### A. Persisting activity state (rejected)

Storing activity state on disk would let the inspector show a longer activity history across restarts. Rejected because:

- It introduces a fourth durable surface that has no privacy benefit — the durable signal (lifecycle column, audit entries, evidence) already records every meaningful event;
- It creates a new exfiltration target — an attacker who reads the on-disk activity log learns operator behaviour over time;
- It risks duplicate retention semantics (activity vs. audit) without adding signal not already in the audit rows;
- The cited engineering note ("activity is presentation, durability lives in audit") is the operating principle.

### B. Separate audit database (rejected)

A new SQLite file dedicated to relationship audit rows. Rejected because:

- It doubles the `--experimental-sqlite` activation surface (already a known footgun from Issue #62);
- It doubles the corrupt-DB quarantine and backup story;
- It would still need to coordinate with `relationships` writes for atomicity, defeating the gain.

### C. Telemetry endpoint for activity counts (rejected)

A remote endpoint receiving anonymised activity-state counts. Rejected because:

- It violates the local-only invariant ([`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md));
- It introduces a network egress where ADR-0031 explicitly forbids one;
- The privacy benefit is zero (the data flows the wrong way);
- "No new dependency" excludes any HTTP client choice that would be palatable.

### D. Embedding evidence content into the relationship row (rejected)

Storing a copy of `EvidenceManifest` excerpts in `relationships.summary` or a new column. Rejected because:

- It duplicates the evidence content (the explicit AC violation);
- It bloats the relationship table without bounded retention coupling;
- It complicates redaction (now two copies of the same string must agree).

### E. Mutating audit rows for "policy correction" (rejected)

Allowing later policy decisions to back-mutate an earlier audit row's payload. Rejected because:

- It violates the append-only invariant;
- It breaks the `(workspace_id, sequence)` monotonicity contract;
- The correct shape is a NEW audit row (`relationship.activity-transitioned` or `relationship.policy-denied`) referencing the earlier `relationshipId`.

## Consequences

### Positive

- A reviewer can answer the six issue #536 acceptance criteria by citing concrete contract sections (see [`audit-activity-checklist.md §12`](../relationship-engine/audit-activity-checklist.md)).
- The redaction story is single-call-site: one redactor, one persist boundary, idempotent re-redact.
- The privacy boundary is structural at the type level (no FORBIDDEN field exists in the audit shapes) AND at the persistence level (no code path writes activity state).
- Existing patterns are reused without modification: redactor, evidence persist, memory audit envelope, tombstone discipline.
- The SQLite migration is additive (V5 ships both `relationships` and `relationship_audit_entries`).
- Activity is cheap: O(active-workflows) per derivation tick, capped at 25 animated badges in the UI.

### Negative

- The dual-surface placement adds a per-mutation branch in the audit writer; the branch is deterministic and tested but requires discipline.
- Audit retention is decoupled from evidence retention (sibling table uses `maxAuditEntriesPerWorkspace`, manifest uses `maxRuns`), so two settings exist. The default values are picked conservatively.
- Operators expecting a persistent activity timeline will need to consult audit rows instead. The inspector surface re-derives the live view; the audit view answers the durable question.

### Risks and mitigations

- **Forbidden-field leak via `payload_json`**: mitigated by type-level rejection (§4 of audit-events.md) plus a runtime validator gate (`relationship_audit_entries.validation` extension by #538).
- **Cross-workspace existence leak via denial payload**: mitigated by the `denied/cross-workspace` payload subtlety (`proposedSourceId` / `proposedTargetId` omitted; only `endpoint` side recorded).
- **Activity layer accidentally persisted**: mitigated by import-graph test (per [`audit-activity-checklist.md §5.2`](../relationship-engine/audit-activity-checklist.md)).
- **Unbounded audit growth**: mitigated by bounded retention sweep (1024 rows per pass) plus the always-keep-newest pin.

## Compliance with epic invariants

- **No new third-party dependency**: confirmed; the implementation reuses `node:sqlite`, the existing redactor, and the existing evidence builder.
- **No new database**: confirmed; the sibling table is a new table in the existing UI-persistence database.
- **No new package**: confirmed; types land in `@oscharko-dev/keiko-contracts`, persistence lands in `@oscharko-dev/keiko-server`, redaction uses `@oscharko-dev/keiko-security`.
- **No content duplication**: confirmed; refs are pointers (§6); audit row summaries are bounded and redacted.
- **No new authority**: confirmed; this ADR adds no model, tool, FS, evidence, memory, workflow, or UI authority. Routes that already grant authority continue to do so; the audit layer is observation only.

## Related ADRs

- [ADR-0029](ADR-0029-workspace-object-registry.md) — workspace object registry (endpoint kinds).
- [ADR-0030](ADR-0030-workspace-security-evidence.md) — workspace security and evidence boundaries.
- [ADR-0031](ADR-0031-relationship-storage-and-validation.md) — relationship storage and validation (the immediate predecessor; defers audit-table shape to this ADR).
- ADR-0033 (issue #537, forthcoming) — UI containment.

## References

- [`docs/relationship-engine/audit-events.md`](../relationship-engine/audit-events.md), [`activity-state.md`](../relationship-engine/activity-state.md), [`evidence-references.md`](../relationship-engine/evidence-references.md), [`retention-and-privacy.md`](../relationship-engine/retention-and-privacy.md), [`audit-activity-checklist.md`](../relationship-engine/audit-activity-checklist.md)
- [`docs/relationship-engine/storage.md`](../relationship-engine/storage.md), [`api-contract.md`](../relationship-engine/api-contract.md), [`lifecycle.md`](../relationship-engine/lifecycle.md), [`taxonomy.md`](../relationship-engine/taxonomy.md), [`denial-reasons.md`](../relationship-engine/denial-reasons.md), [`security-checklist.md`](../relationship-engine/security-checklist.md), [`architecture.md`](../relationship-engine/architecture.md)
- [`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md), [`docs/security-and-audit-boundaries.md`](../security-and-audit-boundaries.md)
- [`packages/keiko-contracts/src/memory-audit-events.ts`](../../packages/keiko-contracts/src/memory-audit-events.ts), [`evidence.ts`](../../packages/keiko-contracts/src/evidence.ts), [`harness.ts`](../../packages/keiko-contracts/src/harness.ts), [`unit-test-events.ts`](../../packages/keiko-contracts/src/unit-test-events.ts), [`bug-investigation-events.ts`](../../packages/keiko-contracts/src/bug-investigation-events.ts)
- [`packages/keiko-security/src/redaction.ts`](../../packages/keiko-security/src/redaction.ts), [`secrets.ts`](../../packages/keiko-security/src/secrets.ts)
- [`packages/keiko-evidence/src/build.ts`](../../packages/keiko-evidence/src/build.ts), [`persist.ts`](../../packages/keiko-evidence/src/persist.ts), [`types.ts`](../../packages/keiko-evidence/src/types.ts)
- [`packages/keiko-memory-vault/src/tombstones.ts`](../../packages/keiko-memory-vault/src/tombstones.ts), [`edges.ts`](../../packages/keiko-memory-vault/src/edges.ts)
- [`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#536](https://github.com/oscharko-dev/Keiko/issues/536). Downstream: [#538](https://github.com/oscharko-dev/Keiko/issues/538), [#539](https://github.com/oscharko-dev/Keiko/issues/539), [#541](https://github.com/oscharko-dev/Keiko/issues/541), [#542](https://github.com/oscharko-dev/Keiko/issues/542), [#543](https://github.com/oscharko-dev/Keiko/issues/543).
