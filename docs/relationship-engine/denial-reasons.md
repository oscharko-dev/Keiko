# Epic #532 — Relationship Denial Reason Catalog

Status: Wave 2 deliverable for [issue #534](https://github.com/oscharko-dev/Keiko/issues/534) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [lifecycle.md](lifecycle.md).

Issue date: 2026-06-06.

## Purpose

This document is the closed catalog of denial reason codes emitted by the relationship engine's validator and policy evaluator. Codes are stable identifiers; the user-facing message is the professional English string the BFF and the inspector UI surface to the operator. Every code is the value of `RelationshipPolicyReason.code` per [gap-analysis.md Gap 3](gap-analysis.md).

The catalog is normative for issues [#535](https://github.com/oscharko-dev/Keiko/issues/535), [#536](https://github.com/oscharko-dev/Keiko/issues/536), [#538](https://github.com/oscharko-dev/Keiko/issues/538), and [#539](https://github.com/oscharko-dev/Keiko/issues/539). Adding a new code follows the additive-evolution rule in [taxonomy.md §3.2](taxonomy.md).

## Resolution order

When more than one denial code applies to the same proposal, the validator returns reasons in the following order so the operator sees the most-structural failure first:

1. `denied/non-existent-source`
2. `denied/non-existent-target`
3. `denied/object-kind-not-yet-supported`
4. `denied/source-kind-not-allowed`
5. `denied/target-kind-not-allowed`
6. `denied/kind-incompatible`
7. `denied/cardinality-exceeded`
8. `denied/cycle-forbidden`
9. `denied/cross-workspace`
10. `denied/path-not-contained`
11. `denied/denied-by-deny-list`
12. `denied/lifecycle-illegal-transition`
13. `denied/endpoint-tombstoned`
14. `denied/endpoint-retired`
15. `denied/endpoint-unavailable`
16. `denied/payload-content-not-permitted`
17. `denied/authority-insufficient`
18. `denied/schema-version-unsupported`

A single `RelationshipPolicyDecision` MAY include more than one reason; the validator does not short-circuit unless an upstream identity check (codes 1, 2, or 3) fails.

## Catalog

### `denied/non-existent-source`

- **User-facing message**: "The source endpoint does not exist."
- **When it fires**: The validator receives an endpoint id that the endpoint-resolver port (per [gap-analysis.md Gap 2](gap-analysis.md)) cannot resolve to any record in the owning package.
- **Audit-event implication**: Yes. The relationship engine writes a `denied` audit event (per [taxonomy.md §6](taxonomy.md) and [audit.md §"Concept 6"](audit.md)). The exact ledger shape is owned by issue #536; this catalog only states that a `denied`-shaped record is required, that it MUST be body-free, and that it MUST flow through `createAuditRedactor` ([`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts)).

### `denied/non-existent-target`

- **User-facing message**: "The target endpoint does not exist."
- **When it fires**: Mirror of `denied/non-existent-source` for the target endpoint.
- **Audit-event implication**: Yes. Same shape as `denied/non-existent-source`.

### `denied/object-kind-not-yet-supported`

- **User-facing message**: "The selected object kind is reserved for a future release."
- **When it fires**: The proposal names a forward-looking endpoint kind (per [taxonomy.md §4.2](taxonomy.md): `agent`, `connector`, `data-source`, `skill`, `mcp-tool`) whose owning registry has not yet landed.
- **Audit-event implication**: Yes. Recorded so operators can observe forward-looking usage attempts; useful for sizing the eventual registries.

### `denied/source-kind-not-allowed`

- **User-facing message**: "The source object kind is not permitted for this relationship type."
- **When it fires**: The proposed source kind is absent from the relationship type's valid-source set in [taxonomy.md §5](taxonomy.md) (e.g. `tool` source, `evidence-run` source, `patch-proposal` source, `workspace-path` source for any type, `chat` source for `chat` target).
- **Audit-event implication**: Yes.

### `denied/target-kind-not-allowed`

- **User-facing message**: "The target object kind is not permitted for this relationship type."
- **When it fires**: The proposed target kind is absent from the relationship type's valid-target set in [taxonomy.md §5](taxonomy.md) (e.g. `chat` target, `workflow-run → chat` target).
- **Audit-event implication**: Yes.

### `denied/kind-incompatible`

- **User-facing message**: "The relationship type is not compatible with this combination of source and target."
- **When it fires**: Both source and target kinds are listed as valid for the relationship type individually, but the specific (source, target) pair is denied by the compatibility matrix (per [compatibility-matrix.md §3](compatibility-matrix.md)). The canonical example is `agent → evidence-run`: both kinds participate in other relationships, but the pair is denied because evidence is produced by runs, not by agents.
- **Audit-event implication**: Yes.

### `denied/cardinality-exceeded`

- **User-facing message**: "Adding this relationship would exceed the allowed number of relationships for the type."
- **When it fires**: A second `produces-evidence` is proposed for a source `workflow-run` that already has one (1:1 violation), or a second `starts-workflow` is proposed for a target `workflow-run` that already has an origin (1:1 violation on target side), or a per-relationship-type cap defined by the cardinality rule in [taxonomy.md §7](taxonomy.md) is reached.
- **Audit-event implication**: Yes.

### `denied/cycle-forbidden`

- **User-facing message**: "The relationship would create a forbidden cycle."
- **When it fires**: A `depends-on` whose `(source, target)` reverses an existing `depends-on` (per [taxonomy.md §5.7](taxonomy.md)); or any self-loop where source and target are the same endpoint id. Transitive-closure cycle detection is delegated to issue #542's impact-analysis traversal; this code covers only the two-edge and self-loop cases the validator can detect in O(1).
- **Audit-event implication**: Yes.

### `denied/cross-workspace`

- **User-facing message**: "Source and target belong to different workspaces."
- **When it fires**: After scope resolution per [taxonomy.md §9](taxonomy.md), the source and target endpoints resolve to incompatible `MemoryScope` instances (different `workspaceId`, or different `projectId` where both are project-scoped, with no shared global or user scope).
- **Audit-event implication**: Yes. Cross-workspace attempts are interesting signals; the audit ledger records them.

### `denied/path-not-contained`

- **User-facing message**: "The workspace path is outside the project boundary or matches a deny-listed pattern."
- **When it fires**: A `workspace-path` endpoint fails `assertContainedRealPath` ([`packages/keiko-workspace/src/realpath.ts`](../../packages/keiko-workspace/src/realpath.ts)) or matches `DEFAULT_DENY_PATTERNS` ([`packages/keiko-workspace/src/ignore.ts:9`](../../packages/keiko-workspace/src/ignore.ts)). Restates the workspace chokepoint rule from [audit.md §"Security and evidence invariants"](audit.md) rule 6.
- **Audit-event implication**: Yes. Path-containment failures are first-class security signals; the audit ledger records them.

### `denied/denied-by-deny-list`

- **User-facing message**: "The endpoint is excluded by the project deny list."
- **When it fires**: A `workspace-path` endpoint passes realpath containment but matches the project's configured deny list beyond `DEFAULT_DENY_PATTERNS`. Distinct from `denied/path-not-contained` to give operators clearer remediation guidance.
- **Audit-event implication**: Yes.

### `denied/lifecycle-illegal-transition`

- **User-facing message**: "The requested lifecycle transition is not permitted from the current state."
- **When it fires**: The proposed transition is not in the legal-transition table in [lifecycle.md §3](lifecycle.md). For example, attempting `revoked → active` (revocation is terminal) or `archived → draft` (archive is terminal except via supersession).
- **Audit-event implication**: Yes.

### `denied/endpoint-tombstoned`

- **User-facing message**: "An endpoint has been forgotten and cannot be referenced."
- **When it fires**: The endpoint-resolver port returns `EndpointLiveness.status: "tombstoned"`. Common for memory endpoints that the user has forgotten via `keiko-memory-governance/forget.ts`. The relationship that referenced the endpoint transitions to `stale` (per [taxonomy.md §6.1](taxonomy.md)) on the next health check; new proposals naming the tombstoned id are rejected with this code.
- **Audit-event implication**: Yes.

### `denied/endpoint-retired`

- **User-facing message**: "An endpoint has been retired by retention and is no longer available."
- **When it fires**: The endpoint-resolver returns `status: "retired"`. Typical for `evidence-run` endpoints that aged past `DEFAULT_RETENTION: maxRuns: 50` ([`evidence.ts:315`](../../packages/keiko-contracts/src/evidence.ts)).
- **Audit-event implication**: Yes.

### `denied/endpoint-unavailable`

- **User-facing message**: "An endpoint is temporarily unavailable."
- **When it fires**: The endpoint-resolver returns `status: "unavailable"` with a free-form rationale. Typical for capsule sources whose underlying connector is offline, or workspace paths whose realpath resolution failed for a transient reason.
- **Audit-event implication**: Yes, but the audit entry's `summary` flags the unavailability as transient so operators do not mistake it for revocation.

### `denied/payload-content-not-permitted`

- **User-facing message**: "The relationship may not carry endpoint content."
- **When it fires**: The proposal includes a field outside the closed set listed in [taxonomy.md §12](taxonomy.md) ("A relationship record MAY carry…"). The most common cause is a client mistakenly attaching a document excerpt or a prompt to the `summary` field. The redactor would scrub it, but the validator rejects upstream so the operator sees the rejection rather than a silent redaction.
- **Audit-event implication**: Yes. The audit entry records the violation without recording the offending payload.

### `denied/authority-insufficient`

- **User-facing message**: "The requesting surface does not have the authority to mutate this relationship."
- **When it fires**: The mutation request lacks an `initiatorSurface` ([`memory-operations.ts`](../../packages/keiko-contracts/src/memory-operations.ts) `MemoryAuditInitiatorSurface`) that the relationship's descriptor accepts. For example, a UI request to mutate a relationship whose source workflow run already terminated. Reuses the `AuthorityRequirement` closed enum from [ADR-0029](../adr/ADR-0029-workspace-object-registry.md).
- **Audit-event implication**: Yes.

### `denied/schema-version-unsupported`

- **User-facing message**: "The relationship envelope uses a schema version the engine does not support."
- **When it fires**: A client submits a relationship record whose `schemaVersion` literal is unknown to the running engine. Forward-only: a `"1"` engine rejects a `"2"` envelope. Mirrors the typed `SchemaError` shape in [`packages/keiko-evidence/src/index-api.ts`](../../packages/keiko-evidence/src/index-api.ts) (Issue #10 memory entry).
- **Audit-event implication**: Yes. Schema-version mismatches are operationally interesting; the audit ledger records them.

## Cross-cutting invariants

Every denial entry in the catalog inherits the following invariants:

1. **Body-free**: the user-facing message and the audit-event `summary` MUST NOT echo endpoint content. Both are bounded by `MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS` (240 chars, per [`memory-audit-events.ts:35`](../../packages/keiko-contracts/src/memory-audit-events.ts)). The redactor at [`packages/keiko-security/src/redaction.ts:96`](../../packages/keiko-security/src/redaction.ts) runs idempotently at emit time.
2. **Stable codes**: the `denied/*` slug is the stable identifier. The user-facing message MAY be re-worded for clarity in a future copy-pass; the slug MUST NOT change without a schema-version bump per [taxonomy.md §3.2](taxonomy.md).
3. **No authority granted by absence**: a non-denied proposal is **eligible**, not **authorised**. The non-authority invariant from [taxonomy.md §2](taxonomy.md) applies.
4. **No additional capability**: the validator and policy evaluator are pure functions over the relationship record, the endpoint-resolver liveness report, the compatibility matrix, and the lifecycle table. They MUST NOT originate model calls, tool calls, network I/O, or file I/O (per [gap-analysis.md Gap 3](gap-analysis.md)).

## References

- [taxonomy.md](taxonomy.md), [compatibility-matrix.md](compatibility-matrix.md), [lifecycle.md](lifecycle.md)
- [audit.md](audit.md), [reuse-matrix.md](reuse-matrix.md), [gap-analysis.md](gap-analysis.md), [adr-candidates.md](adr-candidates.md)
- [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
- Issue: [#534](https://github.com/oscharko-dev/Keiko/issues/534).
