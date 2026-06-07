# ADR-0034: Hybrid multi-source grounding — folders and connectors in one chat

## Status

Proposed (Epic #189 ⨯ #532 integration, 2026-06-07). Locks the contract for grounding a single
Conversation Center chat against a **mix** of connected folders (lexical, Epic #177/#532) and Local
Knowledge connectors (vector, Epic #189) in one merged answer. [ADR-0022](ADR-0022-connected-context-privacy.md) and the #532 multi-source
work cover the folder side; Epic #189's ADRs cover the connector/vector side. This ADR adds the
*unification* layer only — it does not change either retrieval engine.

## Context

Two grounding capabilities shipped independently:

- **Connected repository context (#177/#532).** A chat binds N folder scopes (`connectedScopes`,
  `kind: workspace-root | directory | files`, optional external `root`). Retrieval is **lexical**
  (excerpt scan, ≤ 2 MB/file), already multi-source: `runMultiSourceAsk` retrieves each folder pack,
  merges them, answers once, and returns source-tagged `GroundedEvidenceCitation`s.
- **Local Knowledge connectors (#189).** A chat binds **one** connector (`localKnowledgeScope`,
  `kind: capsule | capsule-set`). Retrieval is **vector** (embedded chunks of large indexed
  documents — manuals, policies, offers). It returns `LocalKnowledgeEvidenceCitation`s with
  document/page/chunk references.

The two were **mutually exclusive**: `handleGroundedAsk` returned on `localKnowledgeScope !==
undefined` before ever reaching the folder path, and `GroundedAnswer` was a two-member union. A user
could not, e.g., draft an offer from marketing folders *and* a product-manual connector at once —
which is the core product need (a workspace for everyone, mixing fast small-file search with durable
large-document knowledge).

## Decision

### 1. Connectors become a second N+1 source list, mirroring `connectedScopes`

Add `Chat.localKnowledgeScopes?: readonly ChatLocalKnowledgeScope[]` (canonical), keeping
`localKnowledgeScope` as back-compat = `[0]`. Reader rule everywhere:
`chat.localKnowledgeScopes ?? (chat.localKnowledgeScope ? [chat.localKnowledgeScope] : [])`. Bounded
by `MAX_LOCAL_KNOWLEDGE_SOURCES = 16`. This deliberately copies the #532 `connectedScopes` shape,
store encoding (single-object-or-array in the existing `local_knowledge_scope_json` column — **no
migration**), and BFF validation (`optionalLocalKnowledgeScopes`, shape-only; capsule existence stays
a grounded-path check). The two source lists stay **separate fields** rather than one union, because
a folder scope (root + relativePaths) and a connector scope (capsuleId/capsuleSetId) are genuinely
different shapes; unifying them would churn both contracts for no behavioural gain. The UI presents
them uniformly (mixed pills) regardless.

### 2. A `hybrid` grounding mode merges heterogeneous evidence into one answer

`GroundedAnswer` gains a third member, `HybridGroundedAnswer` (`groundingKind: "hybrid"`), carrying
**both** source-tagged folder citations (`citations`) and source-tagged connector citations
(`knowledgeCitations`), a merged `contextPack`, and one `content`. The two citation arrays stay
distinct (rather than a single unified citation type) so each keeps its native provenance shape
(`file:line` vs `document/page/chunk`) and the existing renderers are reused.

The merge extends the proven #532 split: retrieve each folder pack (lexical, no model call) **and**
retrieve each connector's references (vector, no model call), format both into one gateway prompt
with per-source sections, call the model **once**, and tag every citation with its source label.
This keeps a single answer with honest, attributable evidence across engines.

### 3. The dispatcher branches on the combined source set

`handleGroundedAsk` resolves both lists and routes on four cases, preserving every existing path
byte-for-byte:

- **0 folders, 0 connectors** → the existing "no scope" error.
- **folders only** → the existing #532 single/multi folder path (AC5 unchanged).
- **connectors only** → the existing #189 local-knowledge path (single-connector behaviour
  unchanged; ≥ 2 connectors extend it).
- **mixed (≥ 1 folder AND ≥ 1 connector)** → the new `hybrid` path.

### 4. Composition primitive is the capsule-*set*, not a physical merge

"Combining connectors" (the product's *zusammenlegen*) is the existing **non-destructive** capsule-set
(a named composition referencing N capsule ids; no vector/data duplication). Each connector stays
independent, reusable, and individually deletable. A destructive physical merge was explicitly
rejected (see Alternatives).

## Consequences

- One chat can search folders and connectors together; the answer cites both, source-tagged.
- No schema migration; both existing single-binding paths and tests remain valid.
- The grounded index is invalidated when **any** grounding source changes (`patchTouchesGroundingScope`).
- Per-source evidence is persisted per root/connector for an honest audit trail.
- Vector retrieval remains brute-force (O(N·D)); scale to very large manuals is validated empirically
  in the integration's final slice, with an ANN seam added only if measurement requires it.

## Alternatives considered

- **One unified scope union** (capsules as new `ChatConnectedScope` kinds). Rejected: it reshapes the
  #532 folder contract and the `SelectedScopeKind` used across connected-context for no behavioural
  gain; the two lists already compose at the UI and answer layers.
- **Physical capsule merge** for *zusammenlegen*. Rejected (product decision): destructive,
  irreversible, and duplicates vectors; capsule-sets achieve "search several connectors together"
  without losing the small-independent-connector model the product is built around.
- **Two separate answers** (folder answer + connector answer side by side). Rejected: the product
  need is one coherent answer that fuses both, not two disconnected results.
