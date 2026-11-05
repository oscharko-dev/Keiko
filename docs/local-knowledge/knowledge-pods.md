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
  Sets instead of low-level capsule terminology. Each pod row emphasizes its name and
  workspace action; details and disconnect use the existing pod actions menu. Indexing
  actions appear once a source is attached, and cancellation remains available while indexing.
  The next required action remains visible: an empty pod offers **Add documents**, an
  unindexed source offers **Index**, and a ready pod offers its workspace action without an
  initial-indexing button. Detailed lifecycle badges and embedding guidance remain in the
  detail view (`design-system/components.html`).
  Embedded Jira Live Pods use the same compact list treatment; connection metadata remains
  in connector settings, while actionable connection problems keep their repair controls.
- **Create** — the ordinary Create Knowledge Pod dialog asks only for a name. It creates
  an existing Local Knowledge capsule under the hood, using the server's existing `standard`
  model-use policy default. Successful creation opens that exact pod's source setup;
  connecting a source and indexing remain separate actions. Switching pods clears the source
  form's old selection, and late detail reads from a previous pod cannot replace the active
  pod's view.
  Creating a pod set still creates a capsule set over existing pod ids. The separate **Add HTML
  manual** creation feature is retired; HTML files remain supported through ordinary file/folder
  sources, and existing indexed manual pods retain their refresh and citation paths.
- **Inspect** — the detail page shows pod readiness, connected sources, document
  counts, indexing state, diagnostics, and actions through the current BFF routes.
- **Attach** — Conversation Center, the existing source picker, Quality Intelligence, and voice
  grounding surfaces refer to selected local knowledge as Knowledge Pods while keeping
  existing `capsule` and `capsule-set` wire discriminants.
  Attached scopes also expose document inventory, scoped search, source reading and semantic
  review through the existing managed MCP host. Local Knowledge tools do not require a Jira
  connection. Their read authority is bound to the current actor, Chat and selected scopes;
  changing the selection invalidates that authority. Document inventory and paged source reads
  cover the supported file and folder sources, independently of retrieval's ranked answer window.
- **Remove** — deleting a pod deletes the local pod index only; source files on disk
  are not deleted. Removing a pod from a set preserves the underlying pod.

Synthetic task examples:

- **Vendor Review** — create local pods for security questionnaire answers, signed
  architecture notes, and approved legal responses, then compose them into a Vendor
  Review Knowledge Pod Set for grounded answer drafting.
- **Project Architecture** — group ADRs, design-system guidance, and package-boundary
  notes into one Knowledge Pod Set so engineering review prompts attach the same local
  evidence without copying vectors or documents.
- **Compliance Pack** — collect audit procedure notes, control-mapping references, and
  release-readiness criteria as separate local pods, then attach the composed set to a
  review chat or Quality Intelligence run.

These examples use only local pods over the existing `capsules.db` store. The owner decision
of 2026-11-04 keeps Knowledge Pods local, with no sharing roadmap or sharing placeholders.
The creation dialog has no Access or Model use choice. Local pod storage does not imply
local model providers: the installation's central gateway configuration controls model routing.

Product vocabulary:

| Product vocabulary   | Meaning                                                                     | Current behavior                    |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| Local Knowledge Pod  | A pod backed by the local `capsules.db` store                               | Supported                           |
| Knowledge Pod Set    | A logical composition over existing local pods                              | Supported                           |
| Sealed Knowledge Pod | A pod whose reconstructive content follows the Local Knowledge store policy | Documented posture; no new UI badge |

Private local documents and project documentation fit the same product vocabulary by
changing the source, not the retrieval registry. Supported local pod sources include the
`folder`, `repository`, and `files` source kinds. Existing compatibility vocabulary for
unsupported pod variants does not advertise planned features or add choices to creation.

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
- `governance.sealingPosture: "local-store-policy"` for a standard local pod, or
  `"sealed-pod-policy"` when the model-use policy seals an operation
- `governance.policyPosture: "not-declared"` for a legacy or default pod, or `"policy-pack"`
  when an explicit model-use policy is present
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
- source kinds such as `folder`, `repository`, `files`, `policy`, `remote`,
  `federated`, `ephemeral`, or `unknown`;
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

## Keiko's own assessment

A Knowledge Pod answer cites what the pod's sources say. A question about Keiko's own view, such as
"Which Java version do you suggest?" after the documents set none, gets a source-backed part and
then Keiko's own assessment. The chat shows the assessment apart from the cited text under the label
"Keiko's own assessment · not from the sources". The assessment is never cited or treated as
evidence (ADR-0144). The operator sets the policy in `keiko.config.json`:

```json
{ "groundedAnswers": { "ownAssessment": "disabled" } }
```

`allowed` is the default. `disabled` keeps answers to the sources only; a block the model writes
anyway is dropped. Any other value fails the configuration load. The Activity Log records each answer's outcome on `search.answer.assessed`
(sizes only, never the text).

## Project document formats

Chat can inspect an attached Pod through the existing managed MCP catalog. `knowledge.documents`
pages a document inventory, literal searches and source reads across the formats below; inventory
also names files whose extraction failed. It does not substitute a ranked excerpt set for the
document inventory. Overlapping Pod and Pod Set connections enumerate each document once. Every
read rechecks the attached scope, lifecycle and model-use policy, and revision-bound cursors refuse
changed sources. The inventory is bounded to 10,000 document descriptors and the existing complete
text reader to 4,000,000 characters per document; exclusions remain explicit.

Before synthesis, each accepted Chat tool turn with selected Pods records one metadata inventory
page through that same managed tool, authority and cancellation path. The first model request
receives up to 20 document descriptors, the total count and any next cursor; the visible transcript
marks the call as runtime initiated. The inventory consumes the normal tool budget. If it exhausts
that budget, the turn returns a partial result without a model call. Larger inventories retain their
pagination and incomplete-coverage facts. This step reads no source text, runs no semantic review
and supplies no evidence for claims about document contents; further reads and reviews use explicit
tool calls.

`knowledge.requirements` retains the deterministic requirement and source acceptance-criterion
inventory. `knowledge.review` is a separate, explicit model call over one 6,000-character source
window, using the active Chat model and its existing turn budget and cancellation. Its output
reserve follows the model's canonical context profile, provider capacity and context fit; its
managed invocation uses the gateway's normal buffered bound without a second, shorter deadline.
A complete outer JSON code fence is normalized before strict schema and anchor validation;
partial responses, surrounding prose and multiple blocks remain invalid. It returns
source-anchored **proposals** for missed obligations, acceptance criteria, conflicts, omissions and
targeted questions. It never changes the source or silently turns a proposed criterion into an
original requirement. Successful reviews are cached by document text revision, model configuration
and content projection; no review runs during Pod connection or ordinary requirement paging.
Finding bodies have a bounded cache; separate bounded window coverage retains the fact that a
review completed after its cached body is evicted. The model's review is not proof of semantic
exhaustiveness, and an invalid, unavailable, truncated or unanchored review does not count as a
completed window. Body-free Activity Log evidence records each inventory, search, read and review.

A pod indexes the text of Word (`.docx`), Excel (`.xlsx`), CSV, PowerPoint (`.pptx`) and PDF
files, with the source location a citation points at: the paragraph or sheet row, the slide
(`Slide N: <title>`, including table rows, chart and SmartArt text, and speaker notes) or the page.
Images and other embedded objects are not read, and scanned documents are not recognized (no OCR).

A PDF stores glyph runs, not paragraphs, so its pages are rebuilt from the layout: reading order
of rows, columns and table cells, the paragraph a wrapped line belongs to, also across a page
break, list items, headings as sections, and page headers and footers a document repeats are
removed with a count. Where the layout gives no evidence, a line stays a line.

Every format follows one block rule in the stored text: a blank line ends a block, and only the
items of one list and the rows of one table stay on adjacent lines. Retrieval and the requirement
inventory rely on this rule, so a new or changed parser has to keep it.

Content a person does not see is reported, never silently dropped or passed off as visible: hidden
Word text, unfilled placeholders and HTML marked `hidden` or `display:none` are excluded with a
count, Word comments are not indexed with a count, and hidden Excel sheets, rows and columns and
hidden slides stay indexed with a count.

A repeated page line whose only change is a page counter (`Seite 3 von 12`, `Page 3`) counts as the
same page furniture; a line whose number changes without a page word stays document text. JSON
records keep their nested fields and exact number spellings within one object budget. CSV, Excel and
the other formats share one parse deadline per document, and every Office container, Excel included,
passes the same ZIP controls.

The stored text is what a parser made of a file, so a refresh reads an unchanged file again when
its parser has changed since and records `PARSER_VERSION_CHANGED`. A repaired parser therefore
reaches existing pods without touching the files.

A file that cannot be indexed is named by a closed reason and never contributes partial text:

| Condition                                               | Diagnostic code      |
| ------------------------------------------------------- | -------------------- |
| Password-protected Word, Excel or PowerPoint file       | `ENCRYPTED_DOCUMENT` |
| Password-protected PDF                                  | `ENCRYPTED_PDF`      |
| Corrupt, truncated or empty file; unsupported structure | `MALFORMED_INPUT`    |
| File larger than the parser byte limit                  | `OVERSIZED_FILE`     |
| PDF without a text layer (scan)                         | `UNSUPPORTED_FORMAT` |

A password-protected Office file is not a ZIP package: Office wraps it in an OLE2 compound file
(signature `D0 CF 11 E0 A1 B1 1A E1`), which the shared OOXML reader recognizes before it opens
the archive. Remove the password and reindex the file. The diagnostic message is fixed text; it
never carries the file name, path or content.

## Model-use policy

Knowledge Pods carry an additive `modelUsePolicy` contract that resolves to a body-free
operation matrix. The ordinary creation dialog submits only `{ displayName }`; the existing
server-side create handler supplies `standard`. An indexed pod can then use the installation's
configured embedding, reranking and answer models without a per-pod settings step. Model
selection and routing remain in the central gateway configuration. These providers may be
local or external; the location of the pod store does not determine provider locality.

API and connector create requests that omit the policy receive the same `standard` default.
Existing explicit policies and their enforcement remain supported. Legacy persisted rows
without an explicit policy resolve as `sealed-local`; removing the creation choices does
not change those rows or relax their guards. Containment, authentication and body-free audit
evidence are unchanged.

The sealed-local default denies:

- external embedding generation for indexing and query-time dense retrieval;
- external reranking over pod excerpts;
- answer synthesis and raw-content release to a model context.

It allows local embeddings, local reranking, and redacted evidence persistence so future
local-only implementations can reuse the same contract without relaxing the boundary.
When a capsule set or hybrid grounded answer combines multiple pods, deny wins per
operation. A single sealed pod disables shared external reranking for the combined
candidate set to avoid leaking sealed excerpts through a cross-source reranker.

Sealed-local also denies `rawContentRelease`, and that single operation gates both
retrieval lanes: the dense lane's per-capsule policy check and the lexical/BM25 lane's
`collectLexicalCandidatesForCapsule` check both key off it. Combined with `localEmbeddings`
having no runtime consumer today (it is reserved forward-compatible surface, like
`localReranking` above), a sealed-local pod out of the box is **not searchable or citable
at all** — neither dense nor lexical evidence is ever surfaced, even for a purely local
query that never leaves the device. This is a maximally conservative default, not a
partial one: "locally searchable, not externally released" requires an explicit `custom`
policy with `rawContentRelease: "allow"` (see the `standardPodModelUsePolicy()` preset for
the fully-open comparison and the custom-policy composition test in
`scoped-vector-search.test.ts`), not the `sealed-local` preset.

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

Three clarifications on the current behavior:

- `mode: "local-only"` on a policy-denied result does not mean a local reranker executed.
  Keiko ships no local reranker yet, so a sealed or reranking-denied pod falls back to a
  redacted no-op that preserves the fused retrieval order — this is a policy denial,
  reported via the `policy-denied` reason code, not a degradation. The `localReranking`
  policy operation is reserved forward-compatible surface for a future local reranker and
  has no runtime consumer today; only `externalReranking` currently gates the provider
  call.
- A reranker that is simply not configured is a fully-supported state, though not always the
  default one: Gateway Setup discovers the rerank models the gateway hosts (a declared
  `mode: "rerank"`, or an id that names one, such as `bge-reranker-v2-m3`) and wires the first
  that passes a live two-document probe as the retrieval reranker, unless a reranker is already
  configured. On such a gateway reranking is active after setup; `not-configured` remains the
  state when the gateway hosts no reranker or none passes the probe. It is reported as
  `status: "disabled"` with failure kind `not-configured` and is treated as an ordinary searched
  pod, not a degraded one, on both the single-scope and hybrid grounding paths. Only genuine
  failures (unavailable, timeout, transport, invalid-response) degrade the pod activity row.
- Reranker input is bounded by the existing grounding budgets. The Knowledge Pod path caps
  candidate count and excerpt length with `maxPromptReferences` and `maxExcerptChars` (its
  input is already rank-capped upstream, so it needs no separate pre-fusion pool budget),
  while the connector+folder hybrid path additionally applies `hybridMaxCandidates` and
  `hybridMaxExcerptBytes` to bound its pre-fusion RRF candidate pool.

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
`reranked`. `sealed`, `remote`, and `federated` remain reserved compatibility values in the
contract; they do not represent supported remote retrieval or a sharing roadmap.

Server consumers must validate every emitted activity object with
`validateKnowledgePodRetrievalActivity()`. UI consumers should render only the supplied
safe counts and labels. If activity is absent, an answer remains valid and the existing
grounded-evidence disclosure is still canonical.

When a grounded answer is persisted in the UI message store, `retrievalActivity` remains
answer metadata rather than a separate evidence manifest. The store validates the activity
on write and again on read; malformed or unsafe stored metadata is rejected instead of
being silently dropped. Canonical operator evidence still lives in the existing context
packs, retrieval diagnostics, and redacted evidence manifests.

## Local-only scope

Knowledge Pod indexes and state remain local. Remote, federated, ephemeral, shared,
hosted and managed-service pod variants are not offered, and sharing is not on the product
roadmap (owner decision, 2026-11-04). Do not expose Coming soon placeholders for them.
Existing reserved contract values remain compatibility data, not feature promises.
This storage scope does not change supported source connectors or the centrally configured
model providers. Existing model-use policy, source containment and redacted audit boundaries
continue to apply.

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
- Only local pod storage and retrieval are offered; there is no sharing roadmap.
- Remote, hosted, managed-service, policy-pack, federated and ephemeral pod retrieval
  are not implemented; retained compatibility vocabulary is not a planned-feature list.
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
