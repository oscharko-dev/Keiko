# Local Knowledge: Knowledge Pods

Status: implementation note for Epic #1815, embedding-space governance in Epic #1818,
and sealed model-use policy in Epic #1819.

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

For task-ready Knowledge Pod Sets, `KnowledgePodSummary` also exposes an optional
`setReadiness` object on `kind: "pod-set"` summaries. It is derived from member pod
projections and contains only nonnegative counts plus closed reason codes: ready,
draft, degraded, unavailable, denied, indexing, stale, error, missing, and the safe
reasons that explain those buckets. It intentionally does not include member document
names, source roots, paths, endpoints, raw diagnostics, excerpts, or vector scores.

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

Embedding-space governance adds a redacted profile layer over the existing
`EmbeddingModelIdentity` metadata. A summary may expose:

- `embeddingProfileKey` after evidence-safe validation;
- `embeddingCompatibilityStatus` as `same`, `unknown`, `incompatible`, `unavailable`,
  or `opaque`;
- `embeddingCompatibilityReason` as a closed Keiko-owned reason code;
- `reindexRecommended` when compatibility is unknown or incompatible;
- `queryEmbeddingAllowed` when policy allows semantic query embedding for the profile.

Legacy pods that do not carry hardening fields such as normalization, instruction
version, and embedding-space fingerprint are `unknown`, not silently compatible. They
remain usable through lexical retrieval, but the UI can present local reindex guidance.
Incompatible or unavailable semantic lanes fail closed for vector retrieval and do not
pretend to be successful dense searches.

Query-time retrieval embeds once per distinct compatible embedding identity. Dense
candidates are ranked inside their embedding lane first. RRF then fuses lane-local dense
ranks with lexical ranks; it never sorts dense candidates from heterogeneous lanes by
raw vector score. This preserves ADR-0036: raw vector scores are only meaningful inside
one embedding space.

The retrieval diagnostics include redacted embedding lane evidence: lane id, participating
pod ids, vector count, dense candidate count, query-embedding participation, and a closed
lane status such as `searched`, `identity-incompatible`, `embedding-failed`, or
`no-vectors`. Lane ids are opaque and do not expose provider endpoints, source paths, raw
queries, vectors, or scores.

## Model-use policy

Knowledge Pods carry an additive `modelUsePolicy` contract that resolves to a
body-free operation matrix. New UI-created pods default to explicit standard policy so
existing indexing and grounded-answer behavior remains available when a user creates a
normal pod. Legacy persisted rows without an explicit policy resolve as `sealed-local`,
which fails closed for operations that would release pod content to external model
providers.

The sealed-local default denies:

- external embedding generation for indexing and query-time dense retrieval;
- external reranking over pod excerpts;
- answer synthesis and raw-content release to a model context.

It allows local embeddings, local reranking, and redacted evidence persistence so future
local-only implementations can reuse the same contract without relaxing the boundary.
When a capsule set or hybrid grounded answer combines multiple pods, deny wins per
operation. A single sealed pod disables shared external reranking for the combined
candidate set to avoid leaking sealed excerpts through a cross-source reranker.

Policy denial is surfaced through closed reason codes only. Indexing emits
`POLICY_DENIED`; retrieval diagnostics use `policy-denied` lanes; grounded answers and
retrieval activity render denied or degraded pod states with `local-only` and `sealed`
modes. These projections do not include source text, excerpts, model prompts, provider
endpoints, or raw diagnostics.

Semantic reranker diagnostics follow the same rule. The browser-facing
`GroundedRerankerDiagnostics` object carries only a closed status, a closed mode
(`none`, `local-only`, or `provider-backed`), candidate/document/kept counts, optional
latency, and a closed failure kind such as `not-configured`, `policy-denied`, `timeout`,
`transport`, or `invalid-response`. It must not contain the user query, candidate
excerpts, provider payloads, endpoints, credentials, paths, or free-form error text.
If a reranker is not configured, denied by policy, unavailable, times out, throws, or
returns an invalid mapping, Keiko preserves the fused retrieval order and records the
redacted no-op/degraded diagnostics instead of failing the grounded answer.

## Retrieval activity projection

Grounded local-knowledge and hybrid answers may include a `retrievalActivity` object.
The object is an additive, browser-safe projection owned by
`KnowledgePodRetrievalActivity` in `@oscharko-dev/keiko-contracts`; callers that do not
understand it can ignore the field without changing answer content, citations, or
context-pack behavior.

The projection answers a narrow question: which selected Knowledge Pods were searched,
skipped, degraded, denied, unavailable, or not selected for answer context. It is not a
new retrieval engine, evidence store, or manifest format. The server assembles activity
from existing Local Knowledge retrieval diagnostics, selected references, grounded
citations, reranker diagnostics, capsule lifecycle state, and redacted Knowledge Pod
summary counts.

Allowed activity evidence:

- pod id, pod kind, safe display name, safe source ids, and counts;
- state, mode, and reason-code enums owned by `keiko-contracts`;
- dense, lexical, and fused candidate counts;
- selected reference and cited-evidence counts;
- privacy flags that must keep raw content, raw query text, private paths, and direct
  vector score comparisons disabled.

Forbidden activity evidence:

- raw user query text, prompt text, model output beyond the normal answer, source
  bodies, excerpts, vectors, absolute paths, provider endpoints, tokens, API keys, or
  PII-like display metadata;
- raw per-document vector scores or any direct cross-space score comparison;
- provider-specific diagnostic blobs that are not normalized into Keiko-owned reason
  codes.

Current local activity modes are `local-only`, `lexical`, `vector`, `hybrid`, and
`reranked`. `sealed`, `remote`, and `federated` are reserved compatibility modes so
future governed pod designs can use the same UI contract without changing the shape.

Server consumers must validate every emitted activity object with
`validateKnowledgePodRetrievalActivity()`. UI consumers should render only the supplied
safe counts and labels. If activity is absent, an answer remains valid and the existing
grounded-evidence disclosure is still canonical.

When a grounded answer is persisted in the UI message store, `retrievalActivity` remains
answer metadata rather than a separate evidence manifest. The store validates the activity
on write and again on read; malformed or unsafe stored metadata is rejected instead of
being silently dropped. Canonical operator evidence still lives in the existing context
packs, retrieval diagnostics, and redacted evidence manifests.

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
metadata are `improvements` for terminology and activity transparency,
`state-or-compatibility-changes` for additive browser-safe contracts, and `ui-polish`
for visible copy updates. Priority is high when a change affects primary Local
Knowledge selection language or grounded-answer evidence disclosure. The structured
release-impact catalog remains the authoritative release source once release-owner
review evidence is recorded; pending entries must not be added if they would make the
machine-checked catalog fail before release-owner approval exists.

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
- `packages/keiko-contracts/src/local-knowledge-embedding-profiles.test.ts`
- `packages/keiko-contracts/src/local-knowledge-retrieval-activity.test.ts`
- `packages/keiko-local-knowledge/src/knowledge-pods.test.ts`
- `packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.test.ts`
- `packages/keiko-server/src/local-knowledge-grounded-qa.rescue.test.ts`
- `packages/keiko-server/src/grounded-qa-hybrid.test.ts`
- `packages/keiko-server/src/local-knowledge-handlers.test.ts`
- `packages/keiko-ui/src/app/components/desktop/GroundedAnswer.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/GroundedAnswer.a11y.test.tsx`
- `packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx`
- `packages/keiko-ui/src/app/local-knowledge/capsule-set-compose.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/widgets/cards/ConnectorPickerWidget.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/RunLauncher.test.tsx`

The older capsule tests remain relevant because they pin the persisted state and API
backward-compatibility that Knowledge Pods intentionally preserve.

The task-ready Knowledge Pod Set rollout is tracked in
[`knowledge-pod-sets-ledger.md`](knowledge-pod-sets-ledger.md).
