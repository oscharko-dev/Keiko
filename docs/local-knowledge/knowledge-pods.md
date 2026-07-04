# Local Knowledge: Knowledge Pods

Status: implementation note for Epic #1815 and child issues #1827-#1831.

## Product term

**Knowledge Pod** is the user-facing name for the existing Local Knowledge capsule
capability. **Knowledge Pod Set** is the user-facing name for an existing capsule set.

The rename is a product and contract projection only. It does not rename persisted
tables, route parameters, internal discriminants, issue-era source kinds, or stored ids:

| User-facing term  | Existing internal term | Persisted state                                       |
| ----------------- | ---------------------- | ----------------------------------------------------- |
| Knowledge Pod     | capsule                | `<runtime-state>/local-knowledge/*/capsules.db`       |
| Knowledge Pod Set | capsule set            | `schema_meta` payload plus `capsule_set_members` rows |
| Pod source        | `KnowledgeSource`      | existing source rows and scope records                |
| Pod readiness     | capsule lifecycle      | existing lifecycle state and indexing jobs            |
| Pod evidence      | counts/status summary  | derived from existing local metadata                  |

Keeping the internal terms stable avoids a state migration, keeps existing Local Knowledge
payloads compatible, and preserves older clients that still consume `capsules` and
`capsuleSets` response fields.

## UX model

Knowledge Pods are selected and managed through the existing Local Knowledge surfaces.
The first release does not add a second app area or a second registry.

- **Discover** — users open Local Knowledge and see Knowledge Pods and Knowledge Pod
  Sets instead of low-level capsule terminology.
- **Create** — creating a pod still creates an existing Local Knowledge capsule under
  the hood. Creating a pod set still creates a capsule set over existing pod ids.
- **Inspect** — the detail page shows pod readiness, connected sources, document
  counts, indexing state, diagnostics, and actions through the current BFF routes.
- **Attach** — Conversation Center, the existing source picker, Quality Intelligence, and voice
  grounding surfaces refer to selected local knowledge as Knowledge Pods while keeping
  existing `capsule` and `capsule-set` wire discriminants.
- **Remove** — deleting a pod deletes the local pod index only; source files on disk
  are not deleted. Removing a pod from a set preserves the underlying pod.

Vocabulary rules for current and future variants:

| Product vocabulary   | Meaning in the initial release                                              | Current behavior                    |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| Local Knowledge Pod  | A pod backed by the local `capsules.db` store                               | Supported                           |
| Knowledge Pod Set    | A logical composition over existing local pods                              | Supported                           |
| Sealed Knowledge Pod | A pod whose reconstructive content follows the Local Knowledge store policy | Documented posture; no new UI badge |
| Policy-backed Pod    | A future pod constrained by an explicit policy pack                         | Reserved vocabulary                 |
| Remote/Federated Pod | A future non-local pod exposed through a governed source boundary           | Out of scope                        |

Private local documents, project documentation, and policy packs fit the same product
vocabulary by changing the source or policy posture, not by changing the retrieval
registry. Supported local pod sources are the current `folder`, `repository`, and
`files` source kinds. Policy packs and remote/federated pods require future governed
designs before implementation.

## Compatibility contract

The additive compatibility surface is:

- `KnowledgePodSummary` in `@oscharko-dev/keiko-contracts`.
- `listKnowledgePodSummaries()` in `@oscharko-dev/keiko-local-knowledge`.
- Optional `knowledgePods` fields on the BFF list responses when callers pass
  `includeKnowledgePods=1` or `knowledgePods=1`, returned alongside the existing
  `capsules` and `capsuleSets` fields.
- Primary Knowledge Pod list and selection surfaces request those opt-in summaries and
  prefer the summary display name for user-facing labels, so path-shaped or secret-shaped
  legacy display metadata falls back to redacted Knowledge Pod names.

This additive package and route direction follows
[ADR-0019](../adr/ADR-0019-modular-package-architecture.md): contract types live in
`keiko-contracts`, summary production reuses `keiko-local-knowledge`, and the BFF emits
only redacted contract-owned wire shapes.

The summary contract records compatibility explicitly:

- `compatibility.migrationRequired: false`
- `persistedStateRenamed: false`
- `compatibility.backingKind: "knowledge-capsule"` or `"capsule-set"`
- `governance.locationKind: "local"`
- `governance.sealingPosture: "local-store-policy"`
- `governance.policyPosture: "none"`
- `governance.managedServiceDependency: false`

Opening Keiko after this change must not require reindexing, vector regeneration, store
repair, or a one-time migration. Existing Local Knowledge stores remain authoritative.

## Redacted evidence shape

Knowledge Pod summaries are designed for manifest-producing surfaces, release notes,
review ledgers, and UI selectors. They are body-free and path-safe by construction.

Allowed summary evidence:

- stable ids and safe display names;
- pod kind, legacy compatibility kind, readiness, and lifecycle;
- counts for documents, chunks, vectors, sources, and pod-set members;
- source kinds such as `folder`, `repository`, `files`, `policy`, `remote`, or `unknown`;
- retrieval capability booleans and embedding identity metadata after safety checks;
- privacy flags that describe whether raw bodies, vectors, source paths, or diagnostics
  are included;
- governance posture fields for local/remote, sealed/policy, and managed-service status.

Forbidden summary evidence:

- document bodies, chunk text, excerpts, vectors, model prompts, model outputs, or raw
  diagnostics;
- absolute local paths, private home-directory paths, repository roots, URLs with query
  tokens, credentials, API keys, or PII;
- raw vector scores mixed across embedding spaces.

Unsafe display metadata is redacted before a summary is emitted. When redaction happens,
the mapper falls back to stable generic names such as `Knowledge Pod` or
`Knowledge Pod Set`.

Audit checklist:

- Validate every browser-facing summary with `validateKnowledgePodSummary()`.
- Confirm `privacy.rawContentExposed` and `privacy.privatePathsExposed` remain `false`.
- Confirm `compatibility.migrationRequired` and `compatibility.persistedStateRenamed`
  remain `false` for the initial release.
- Confirm source scope roots and document paths are represented only by source kind and
  counts, never by raw path strings.
- Confirm endpoint-like values with query tokens and secret-shaped strings are rejected
  or redacted before emission.

## Retrieval and score semantics

Knowledge Pods reuse the existing Local Knowledge retrieval and grounding path. A pod can
advertise lexical and vector availability, but it does not introduce a second retrieval
engine or a hosted retrieval service. Pod sets compose existing pods and do not duplicate
vectors.

Raw vector scores remain comparable only inside one embedding space. Cross-pod and
cross-space retrieval must continue to use rank fusion, metadata, and optional text-level
reranking rather than direct score mixing.

## Future remote or federated pods

Remote, federated, shared, or cloud-backed pods are out of scope for Epic #1815. Any
future non-local pod design must add or update an ADR before implementation and must
define:

- ownership and human-control boundaries;
- egress and model-provider policy;
- evidence redaction and manifest rules;
- compatibility with local-first operation;
- retrieval-score normalization without direct cross-space score mixing.

Future internal rename or migration work must be its own reviewed issue. It needs an
ADR when it changes persisted state, route contracts, evidence semantics, retrieval
ownership, or package direction. It must also include a rollback and compatibility
plan before any `capsule` storage term is renamed.

## Release impact and limits

Advisory release-note categories for the release owner to encode in governed
[ADR-0099](../adr/ADR-0099-governed-in-app-updates-and-release-impact-contract.md)
metadata are `improvements` for terminology, `state-or-compatibility-changes` for the
additive summary contract, and `ui-polish` for visible copy updates. Priority is high
because the change affects primary Local Knowledge selection language. The structured
release-impact catalog remains the authoritative release source once release-owner
review evidence is recorded.

Known limits:

- Existing API discriminants and route parameters still use `capsule` and
  `capsule-set` for compatibility.
- No remote, hosted, managed-service, policy-pack, or federated pod retrieval is
  implemented.
- No persisted Local Knowledge migration is performed.
- Linux CI remains authoritative for release evidence when platform-specific bundle
  fingerprints differ from a local developer machine.

## Verification anchors

The Knowledge Pod compatibility and redaction behavior is covered by:

- `packages/keiko-contracts/src/local-knowledge-pods.test.ts`
- `packages/keiko-local-knowledge/src/knowledge-pods.test.ts`
- `packages/keiko-server/src/local-knowledge-handlers.test.ts`
- `packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/widgets/cards/ConnectorPickerWidget.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/RunLauncher.test.tsx`

The older capsule tests remain relevant because they pin the persisted state and API
backward-compatibility that Knowledge Pods intentionally preserve.
