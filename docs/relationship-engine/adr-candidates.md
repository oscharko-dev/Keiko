# Epic #532 — ADR Candidate List for the Semantic Relationship Engine

Status: Wave 1 deliverable for [issue #533](https://github.com/oscharko-dev/Keiko/issues/533) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md).

Audit date: 2026-06-06.

Historical note: these are Wave 1 candidate scopes, not the final adopted ADRs. On current `dev`, the implemented decisions are captured in [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md), and [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).

## Purpose

This document lists the ADRs whose decisions cannot be safely inferred from current code or existing ADRs. Each candidate is numbered to follow the present ADR series (latest accepted: [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)). The candidates here are **scope statements**, not the ADRs themselves — drafting the ADR bodies is the work of issues #535, #536, and #537.

## ADR-0031 — Relationship Type System

### Scope

Lock the `RelationshipKind` closed set, the lifecycle vocabulary (`RelationshipLifecycle`), and the type-compatibility matrix (which source/target endpoint kinds may participate in which relationship kind).

### Decisions required

1. The closed set of `RelationshipKind` values and their semantic intent (depends-on, supersedes, derived-from, evidences, applies-to, conflicts-with, related — final list per #534).
2. The closed set of `RelationshipLifecycle` values and the legal transitions between them.
3. The compatibility matrix as a pure function returning the `ValidationOk<T> | ValidationFail` shape established in [`local-knowledge-validation.ts:29`](../../packages/keiko-contracts/src/local-knowledge-validation.ts).
4. The relationship between `RelationshipKind` and the existing `MemoryEdgeKind` enum: are the two enums independent (recommended), aliased, or merged? Recommendation from this audit is **independent**: memory-graph edges remain in their own contract because their semantics (consolidation, supersession of memory facts) are vault-local and the FK contract in `memory_edges` cannot be widened.
5. Whether `RelationshipKind` is open for future extension via a versioned `RELATIONSHIP_KINDS` array (per Keiko convention) or sealed at v1.

### Options being weighed

- **Independent enums** (recommended). `RelationshipKind` ≠ `MemoryEdgeKind`. Each is purpose-built; mismatched names are deliberate. Cost: developer education that the two graphs are different.
- **Merged enum.** A single union over both vocabularies. Cost: every `MemoryEdge` consumer must filter; the memory layer's compatibility checks are weakened.
- **Aliased enum.** `MemoryEdgeKind` becomes a subset of `RelationshipKind`. Cost: forces a memory-layer contract change for an epic that does not own the memory layer.

### Dependencies on other ADR candidates

- ADR-0032 depends on this ADR for the storage shape's `kind` column constraint.
- ADR-0033 depends on this ADR for the audit-event-kind enumeration.

### Source material

- [audit.md](audit.md) §"Concept 2 — RelationshipType"
- [gap-analysis.md](gap-analysis.md) Gap 4
- [reuse-matrix.md](reuse-matrix.md) rows 2, 3, 28
- [`packages/keiko-contracts/src/memory.ts:191`](../../packages/keiko-contracts/src/memory.ts)

## ADR-0032 — Relationship Storage Choice

### Scope

Decide where relationship records live, how the schema evolves, and how cross-domain endpoints satisfy the "live?" question without cross-database FK.

### Decisions required

1. **Hosting**: new SQLite file (recommended), new table in the memory vault DB, new table in the UI persistence DB, or JSON ledger.
2. **Owning package**: where the SQL access layer lives (between `keiko-server` consumer, a new leaf consumer module, or a host package extension consistent with [ADR-0019](../adr/ADR-0019-modular-package-architecture.md) direction rules).
3. **Schema evolution**: confirm `PRAGMA user_version` migration pattern is reused unchanged.
4. **`node:sqlite` `--experimental-sqlite` flag strategy**: confirm the three-site activation strategy (CLI re-exec, vitest `execArgv`, no flag for `tsc`) is reused unchanged.
5. **Cross-database endpoint liveness**: lock the `RelationshipEndpointResolver` port (Gap 2) as the chokepoint; specify the resolver implementations each owning package exposes.
6. **Corrupt-DB handling**: confirm the `.corrupt.<iso>` quarantine pattern from the existing `keiko-server` / `keiko-memory-vault` stores is reused.
7. **Atomic-write convention**: confirm the realpath-contained + `O_EXCL` convention from [`packages/keiko-evidence/src/store.ts`](../../packages/keiko-evidence/src/store.ts) is reused for any non-DB ledger surfaces.

### Options being weighed

- **New SQLite file** (recommended). Clean separation; survives memory-vault retention sweeps; uses the established `node:sqlite` plumbing.
- **New table in memory vault DB.** Couples cross-domain relationships to vault retention and scope semantics.
- **New table in UI persistence DB.** Conflates UI-durable layout (session-scoped) with audit-bearing records.
- **JSON ledger.** O(N) per-row queries; rejected by impact-analysis cost model.

### Dependencies on other ADR candidates

- Depends on ADR-0031 for the `kind` and `lifecycle` columns' closed-string-set constraints.
- ADR-0033 depends on this ADR for the persisted record shape that the audit ledger references by id.
- ADR-0034 depends on this ADR via the inspector's read path.

### Source material

- [audit.md](audit.md) §"Concept 3 — RelationshipEdge"
- [gap-analysis.md](gap-analysis.md) Gaps 1, 2, 5, 9
- [reuse-matrix.md](reuse-matrix.md) rows 4, 5, 23, 24
- [`packages/keiko-memory-vault/src/schema.ts:68`](../../packages/keiko-memory-vault/src/schema.ts)
- [`docs/workspace/518-architecture-blueprint.md`](../workspace/518-architecture-blueprint.md)
- [`packages/keiko-server/src/store/schema.ts`](../../packages/keiko-server/src/store/schema.ts)
- [`packages/keiko-server/src/store/db.ts`](../../packages/keiko-server/src/store/db.ts)

## ADR-0033 — Relationship Audit / Activity Model

### Scope

Lock the audit-event family (`relationship:*`), the live-stream activity envelope, the `EvidenceManifest` extension, and the redaction contract.

### Decisions required

1. **Audit-event family**: closed set of `RelationshipActivityKind` values (`relationship:proposed | relationship:accepted | relationship:rejected | relationship:retracted | relationship:superseded | relationship:archived | relationship:impacted`).
2. **Envelope**: reuse `BaseWorkflowEvent` shape vs. introducing a relationship-specific envelope. Recommendation: reuse the shape with a new event-family file in `keiko-contracts`.
3. **`EvidenceManifest` extension**: add the optional `relationships?: EvidenceRelationshipAudit` section as specified in [gap-analysis.md](gap-analysis.md) Gap 7.
4. **`evidenceSchemaVersion` bump**: bump to `"2"` to flag the new optional section, with explicit backwards-compatibility handling at read time. Alternative: keep `"1"` because the field is optional. Recommendation: bump and emit a versioned read-time error if a `"2"` manifest is opened by a `"1"` reader.
5. **Redaction chokepoint**: `createAuditRedactor` + `deepRedactStrings` per [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts). No new redactor.
6. **Body-free invariant**: re-state the invariant from [`memory-audit-events.ts:19`](../../packages/keiko-contracts/src/memory-audit-events.ts) so the relationship audit pipeline can be tested against it (a fixture-based negative test rejecting any audit record that embeds endpoint content).
7. **Activity vs. audit separation**: SSE-driven activity events (Gap 6) are body-free but ephemeral; audit entries (Gap 7) are body-free but durable and retention-bound. The two surfaces share the kind enum but never share the payload.
8. **Retention**: relationship audit entries inherit the run's retention via `DEFAULT_RETENTION` ([`packages/keiko-contracts/src/evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)). No new retention lever.
9. **Activity visibility scope**: a viewer sees activity for relationships whose scope intersects their own, mirroring [connected-context-privacy.md](../connected-context-privacy.md) and the `MemoryScope` discriminator.

### Options being weighed

- **Reuse `BaseWorkflowEvent` shape with a new event family** (recommended).
- **New event envelope shape.** Rejected: divergence from the established pattern.
- **Mix relationship audit into existing `MemoryAuditRecord`.** Rejected: would force memory governance to know about cross-domain endpoints.

### Dependencies on other ADR candidates

- Depends on ADR-0031 for the `kind` enumeration.
- Depends on ADR-0032 for the `relationshipId` reference.
- ADR-0034 depends on this ADR for the activity event-name discipline the UI subscribes to.

### Source material

- [audit.md](audit.md) §§"Concept 5 — RelationshipActivity", "Concept 6 — RelationshipAuditEvent"
- [gap-analysis.md](gap-analysis.md) Gaps 6, 7
- [reuse-matrix.md](reuse-matrix.md) rows 8, 9, 10, 11, 18

## ADR-0034 — Relationship UI Containment

### Scope

Lock the UI surface for the relationship inspector and the controlled relationship graph view within the existing workspace substrate (ADR-0026) and object registry contract (ADR-0029).

### Decisions required

1. **New `WindowType` entries**: `"relationships"` (controlled graph view) and `"relationship-inspector"` (single-record panel) added to the `WindowType` enum in [`packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts`](../../packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts).
2. **Descriptor fields**: each new entry declares `trustBoundary`, `authority`, `persistence`, `lifecycle` from the closed enums in ADR-0029.
3. **Renderer reuse**: the controlled graph view reuses the `ConnectionsLayer.tsx` SVG conventions and the `connector-graph.tsx` a11y patterns. No parallel substrate — ADR-0026 forbids it.
4. **No new pointer-gesture surface**: commands routed through the existing command palette + per-window controls. Multi-selection within the controlled graph view follows the bounded extension from [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md) (if landed; deferred otherwise).
5. **Inspector last-viewed state**: stored in the existing UI persistence DB as `persistence: "durable.ui"`, id-only.
6. **Accessibility floor**: WCAG 2.2 AA, ≥30×30 hit targets, focus rings, `aria-live="assertive"` error alerts, keyboard-reachable controls — explicit per the audit lessons from Epics #63, #66, #67.
7. **Redaction at the BFF boundary**: every string the UI receives is already redacted server-side; the UI MUST NOT re-fetch raw endpoint content.
8. **Static-export route convention**: relationship inspector deep links use query-param routes (see [`docs/workspace/518-architecture-blueprint.md`](../workspace/518-architecture-blueprint.md)), not dynamic routes.
9. **SSE consumer pattern**: `addEventListener(kind, …)` per relationship-activity kind (see [`packages/keiko-ui/src/lib/useSSE.ts`](../../packages/keiko-ui/src/lib/useSSE.ts)).

### Options being weighed

- **New `WindowType` entries + ADR-0029 extension** (recommended).
- **New top-level UI shell area** (rejected — ADR-0026 locks the shell).
- **Modal-only inspector** (rejected — modal trap is forbidden by the workspace UX blueprint).

### Dependencies on other ADR candidates

- Depends on ADR-0031 for the kind vocabulary the inspector renders.
- Depends on ADR-0032 for the read path's typed responses.
- Depends on ADR-0033 for the SSE event-name discipline.
- Does not depend on (and does not amend) [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md): the new entries land on the existing extension contract.

### Source material

- [audit.md](audit.md) §"Concept 8 — Visualization"
- [gap-analysis.md](gap-analysis.md) Gap 10
- [reuse-matrix.md](reuse-matrix.md) rows 14, 15, 16, 19
- [518-canvas-graph-deferral.md](../workspace/518-canvas-graph-deferral.md)
- [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md)

## What is intentionally not an ADR candidate

- **A new `keiko-relationship` package.** Not proposed. The epic budget is contract additions + a leaf SQL consumer + UI extensions. Introducing a new package would require a new direction-cruiser rule and a new `arch:check` invariant; the existing direction matrix is sufficient.
- **A new dependency.** Forbidden by the epic invariant and the issue stop condition.
- **An ADR amending ADR-0026/0027/0029/0030.** Not required; the new work fits the existing extension contracts.
- **An ADR adopting WebRTC, a graph layout engine, or a state-management library.** Out of scope per [ADR-0030 §"WebRTC"](../adr/ADR-0030-workspace-security-evidence.md) and [ADR-0026 §"Alternatives considered"](../adr/ADR-0026-workspace-substrate.md).

## References

- [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md)
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
