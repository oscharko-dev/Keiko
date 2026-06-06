# Epic #532 — Relationship Engine Extension Rules

Status: Wave 4 deliverable for [issue #538](https://github.com/oscharko-dev/Keiko/issues/538) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md), [architecture.md](architecture.md).

Date: 2026-06-06.

## Purpose

This document lists the rules a contributor MUST follow when extending the relationship engine — adding a new relationship type, a new object kind, a new lifecycle state, or a new denial code. The rules pin the additive-evolution invariant restated in [taxonomy.md §3.2](taxonomy.md): the schema evolves by extending closed sets, never by mutating existing members.

The implementation seam is the contract module at `packages/keiko-contracts/src/relationships.ts` plus the deterministic validator at `packages/keiko-contracts/src/relationships-validation.ts`.

## 1. Schema-version invariant

The `RELATIONSHIP_SCHEMA_VERSION` literal is `"1"`.

| Change kind                                                                                                                    | Bumps `RELATIONSHIP_SCHEMA_VERSION`? |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Adding a new relationship type to `RELATIONSHIP_TYPES`                                                                         | No                                   |
| Adding a new object kind to `RELATIONSHIP_OBJECT_KINDS`                                                                        | No                                   |
| Promoting a forward-looking kind into `RELATIONSHIP_SUPPORTED_OBJECT_KINDS` because its owning registry has landed             | No                                   |
| Adding a new lifecycle state to `RELATIONSHIP_LIFECYCLE_STATES`                                                                | No                                   |
| Adding a new transient activity state to `RELATIONSHIP_ACTIVITY_STATES`                                                        | No                                   |
| Adding a new denial code to `RELATIONSHIP_DENIAL_CODES`                                                                        | No                                   |
| Renaming any existing member of any closed set                                                                                 | Yes — bump to `"2"` AND amend ADR    |
| Removing any existing member of any closed set                                                                                 | Yes — bump to `"2"` AND amend ADR    |
| Narrowing the type of any existing field (e.g. `metadata?` becomes required, `etag: number` becomes `etag: string`)            | Yes — bump to `"2"` AND amend ADR    |
| Changing the semantics of an existing denial code (e.g. cardinality enforcement for `produces-evidence` becoming 1:N from 1:1) | Yes — bump to `"2"` AND amend ADR    |

A breaking bump introduces a NEW literal `RELATIONSHIP_SCHEMA_VERSION = "2"` and lands an ADR superseding ADR-0031. Readers of an older schema version receive `denied/schema-version-unsupported`; the validator never silently coerces the new shape into the old shape.

## 2. Adding a new relationship type

1. **Append** the new id to `RELATIONSHIP_TYPES` in `relationships.ts`. Order is taxonomy.md §5.8 order extended with the new id at the end.
2. **Add** a `RELATIONSHIP_TYPE_DEFINITIONS` entry. Every field is mandatory; the validator indexes by every field. The entry MUST cite:
   - `validSourceKinds` and `validTargetKinds` (subsets of `RELATIONSHIP_OBJECT_KINDS`);
   - `cardinality` (1:1 / 1:N / N:1 / N:N);
   - `direction` (directed / undirected);
   - `lifecycle` flags (creatable, immutable, reconnectable, deletable, archivable);
   - `evidenceRelevance` (none / reference / produces);
   - `ownerPackage` and `trustBoundary`.
3. **Update** [taxonomy.md §5.8](taxonomy.md) (the id list), [compatibility-matrix.md §2](compatibility-matrix.md) (a row + column entry per existing kind), and [compatibility-matrix.md §4](compatibility-matrix.md) (at least one allowed-pair example).
4. **Update** [denial-reasons.md §"Catalog"](denial-reasons.md) only if the new type introduces a denial code not already in the closed set (it should not — reuse the catalog).
5. **Update** [reuse-matrix.md](reuse-matrix.md): cite the existing edge subsystem the new type anchors to. If no such subsystem exists, file a `new-capability-gap` row in [gap-analysis.md](gap-analysis.md).
6. **Add tests**:
   - One happy-path row in `relationships-validation.test.ts` ("happy paths") covering a `validSourceKinds × validTargetKinds` pair.
   - At least one denied example in the test file matching the new type's denial reasons.
7. **Do NOT bump** `RELATIONSHIP_SCHEMA_VERSION`. The addition is additive.

## 3. Adding a new object kind

1. **Append** the new kind to `RELATIONSHIP_OBJECT_KINDS` in alphabetical position (the validator iterates this tuple; reviewers cross-walk the order against the compatibility matrix).
2. **If forward-looking** (the owning registry has NOT landed yet):
   - Omit the kind from `RELATIONSHIP_SUPPORTED_OBJECT_KINDS`.
   - Document the kind as "forward-looking" in [taxonomy.md §4](taxonomy.md) with an owning-package "(not yet owned)" entry.
   - The validator will reject any proposal naming the kind with `denied/object-kind-not-yet-supported`. No test changes beyond a small denial test are needed.
3. **If supported now**:
   - Add the kind to `RELATIONSHIP_SUPPORTED_OBJECT_KINDS`.
   - Document the identity source (`<package>/<file.ts>:<line>`) in [taxonomy.md §4](taxonomy.md).
   - Update the `validSourceKinds` / `validTargetKinds` arrays of every applicable `RELATIONSHIP_TYPE_DEFINITIONS` entry that the new kind participates in.
   - Add a row + column to [compatibility-matrix.md §2](compatibility-matrix.md).
4. **Add tests**:
   - For a forward-looking kind: one test that the validator rejects with `denied/object-kind-not-yet-supported`.
   - For a supported kind: at least one happy-path row and at least one denied example per type the kind participates in.
5. **Do NOT bump** `RELATIONSHIP_SCHEMA_VERSION`.

## 4. Promoting a forward-looking kind to supported

When the owning registry for a forward-looking kind lands:

1. **Move** the kind from "forward-looking only" to "supported": add it to `RELATIONSHIP_SUPPORTED_OBJECT_KINDS`.
2. **Wire** the kind into every applicable `RELATIONSHIP_TYPE_DEFINITIONS` entry's `validSourceKinds` / `validTargetKinds` and update [compatibility-matrix.md §2](compatibility-matrix.md).
3. **Promote** the previous `denied/object-kind-not-yet-supported` test rows to either happy paths or `denied/source-kind-not-allowed` / `denied/target-kind-not-allowed` / `denied/kind-incompatible` as the matrix dictates.
4. **Do NOT bump** `RELATIONSHIP_SCHEMA_VERSION`.

## 5. Deprecating a relationship type or object kind

Deprecation is ADR-gated. The rules:

1. **Announce** in an ADR amendment to ADR-0031. The amendment names the deprecated member, the migration window (at least one schema-version cycle), and the replacement (if any).
2. **Keep the member** in the closed set for the entire migration window. Activity and audit emitters MAY stop emitting it at the next schema-version bump (taxonomy.md §3.3); readers MUST continue to accept it until the bump after that.
3. **Do NOT remove** the member in the same release as the deprecation announcement. A removal is a breaking change and requires a `RELATIONSHIP_SCHEMA_VERSION` bump per §1.
4. **Add tests**: existing tests for the deprecated member stay green for the migration window; new tests assert the deprecation surfaces a documented signal (e.g. an audit-event `summary` flag, per [audit-events.md](audit-events.md)).

## 6. Adding a new denial code

1. **Append** the new code to `RELATIONSHIP_DENIAL_CODES` in `relationships.ts`. The tuple order matches the normative "Resolution order" in [denial-reasons.md](denial-reasons.md); insert at the correct position.
2. **Update** [denial-reasons.md §"Catalog"](denial-reasons.md) with the new code's user-facing message, when-it-fires rule, and audit-event implication.
3. **Update** [denial-reasons.md §"Resolution order"](denial-reasons.md) to include the new code at its slot.
4. **Wire** the validator: add the corresponding pure helper in `relationships-validation.ts` AND call it from `validateRelationship` in the position dictated by the resolution order.
5. **Add tests**:
   - At least one negative test where the code fires;
   - At least one resolution-order test pinning the new code's position relative to its neighbours.
6. **Do NOT bump** `RELATIONSHIP_SCHEMA_VERSION`.

## 7. Adding a new lifecycle state

1. **Append** the new state to `RELATIONSHIP_LIFECYCLE_STATES`.
2. **Update** [lifecycle.md §1](lifecycle.md) (state list) AND [lifecycle.md §2](lifecycle.md) (transition table — every from-state needs an explicit entry for the new state, and the new state needs explicit entries for every to-state).
3. **Update** `LIFECYCLE_TRANSITIONS` in `relationships-validation.ts` to mirror the new table.
4. **Add tests**: at least one accepting transition and at least one rejecting transition test per state-pair touching the new state.
5. **Do NOT bump** `RELATIONSHIP_SCHEMA_VERSION`.

## 8. Adding a new activity state

1. **Append** the new state to `RELATIONSHIP_ACTIVITY_STATES`.
2. **Update** [activity-state.md §2](activity-state.md) with the state's meaning AND [activity-state.md §3](activity-state.md) with the source event stream the state is derived from. Activity states are transient and in-memory only; the validator does NOT touch them.
3. **No validator change required** — activity state is not persisted on the relationship record. The closed enumeration is surfaced from `keiko-contracts` so the UI can pin against a stable set.
4. **Do NOT bump** `RELATIONSHIP_SCHEMA_VERSION`.

## 9. Adding a forbidden metadata key substring

The validator rejects metadata keys whose lowercased + alphanumeric-stripped form contains any banned substring (`relationships-validation.ts` → `checkForbiddenMetadata`).

1. **Append** the new substring to `RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS` in `relationships.ts`. The substring MUST be lowercase, alphanumeric-only, and chosen so the obvious variant key names collapse to it (e.g. `apikey` matches `apiKey` / `API_KEY` / `api-key` / `apikey`).
2. **Update** [audit-events.md §8.3](audit-events.md)'s FORBIDDEN-field list if the new substring covers a category not already documented.
3. **Add tests**: at least one denied test exercising the new substring.
4. **Do NOT bump** `RELATIONSHIP_SCHEMA_VERSION`.

## 10. Cross-package coordination

A new relationship type or kind that touches an existing Keiko subsystem (memory vault, evidence store, workflow ledger, tools registry, workspace discovery, local-knowledge connector graph) MUST:

1. **Not** create a new credential surface, a new persistence backend, or a new third-party dependency. Restated from [audit.md §"Security and evidence invariants"](audit.md).
2. **Compose** the existing owning boundary via the resolver port (per [gap-analysis.md Gap 2](gap-analysis.md)); never bypass the boundary's authority gate.
3. **Reuse** the audit-event taxonomy in [audit-events.md](audit-events.md) and the redaction chokepoint in `packages/keiko-security/src/redaction.ts`; never introduce a new redactor.

## 11. References

- [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md), [activity-state.md](activity-state.md), [audit-events.md](audit-events.md), [architecture.md](architecture.md)
- [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity.md)
- Issue: [#538](https://github.com/oscharko-dev/Keiko/issues/538).
