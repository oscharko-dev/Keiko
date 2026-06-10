# ADR-0036: Equal-weight hybrid grounding via reciprocal-rank fusion over a shared evidence budget

## Status

Proposed (2026-06-08). Refines the hybrid merge layer introduced in
[ADR-0034](ADR-0034-hybrid-multi-source-grounding.md) (`runHybridGroundedAsk`,
`grounded-qa-hybrid.ts`). Does not change either retrieval engine; only the post-retrieval
selection and budget allocation stage.

## Context

[ADR-0034](ADR-0034-hybrid-multi-source-grounding.md) established that a chat can simultaneously
bind N connected folder scopes (`chat.connectedScopes[]`, lexical retrieval, Epic #177/#532) and N
Local Knowledge connector scopes (`chat.localKnowledgeScopes[]`, vector retrieval, Epic #189). The
dispatcher in `handleGroundedAsk`
([`packages/keiko-server/src/grounded-qa.ts:887–902`](../../packages/keiko-server/src/grounded-qa.ts))
routes any mixed combination to `runHybridGroundedAsk`
([`packages/keiko-server/src/grounded-qa-hybrid.ts`](../../packages/keiko-server/src/grounded-qa-hybrid.ts))
for a merged answer.

The hybrid merge as it stands assigns each side its own independent, never-reconciled budget:

- **Folder side**: the full `DEFAULT_EXPLORATION_BUDGET` (excerptBytesMax = 131 072 bytes), split
  only by the number of connected folders. A single folder can inject up to 131 KB of evidence.
- **Connector side**: each connector independently receives a flat
  `topK = MAX_PROMPT_REFERENCES = 8` slots × `MAX_EXCERPT_CHARS = 900` characters ≈ 7.2 KB per
  connector.

These two budgets are structurally incommensurable and are concatenated folder-first. In any
mixed chat the folder side can contribute up to ~18× more bytes per source than the connector side.
A user who connects a single folder alongside a large-document connector (the canonical knowledge-
worker scenario) will find connector evidence structurally drowned out regardless of relevance.

The root cause is that the two engines produce native scores on incomparable scales — folder
retrieval returns a clamped lexical token-overlap value in \[0, 1\]; connector retrieval returns a
cosine, dot-product, or negativeEuclidean similarity whose numeric range is model- and
metric-dependent. Direct comparison of raw scores to decide which candidates win the shared budget
is therefore not meaningful.

## Decision

### 1. Introduce a unified shared evidence budget

Replace the two independent budgets with a single shared pool defined by a pair of configurable
`GroundingLimits`:

- `hybridMaxCandidates` — maximum number of candidates (from either engine) that may enter the
  selection stage.
- `hybridMaxExcerptBytes` — maximum total byte size of the final selected evidence set that is
  forwarded to the prompt builder.

Both limits are sourced from the `grounding` block of `keiko.config.json` (and the corresponding
`KEIKO_GROUNDING_*` environment variables) so operators can tune them without code changes. The
defaults reproduce the current per-engine ceilings at their combined upper bound.

### 2. Fuse cross-engine candidates by Reciprocal Rank Fusion

Candidates from both engines compete for shared-budget slots using **Reciprocal Rank Fusion
(RRF)**:

```
fused_score(candidate) = Σ  1 / (k + rank_in_engine_i)
```

where the sum runs over each engine that returned the candidate, and `k = 60` (the standard
constant from Cormack, Clarke & Buettcher 2009, validated broadly in hybrid IR benchmarks).

RRF is chosen over direct score comparison because it fuses retrievers by **rank**, which is
meaningful and comparable across engines regardless of the numeric scale of their native scores.
A folder candidate ranked 1st by the lexical engine and a connector candidate ranked 1st by the
vector engine receive the same RRF contribution from their respective engine, resolving the
incommensurability problem.

Candidates are sorted descending by fused score. The top-N candidates that fit within
`hybridMaxCandidates` and whose cumulative byte size stays within `hybridMaxExcerptBytes` form the
selected set. Selection consumes candidates in fused-score order until both caps are exhausted.

### 3. Assign a single global citation marker set over the selected candidates

The existing dual citation arrays are preserved: folder evidence continues to populate
`citations: GroundedEvidenceCitation[]` and connector evidence continues to populate
`knowledgeCitations: LocalKnowledgeEvidenceCitation[]`, keeping their native provenance shapes
(`file:line` vs. `document/page/chunk`). Within the selected set, citation markers (`[1]`, `[2]`,
…) are assigned in fused-score order across both kinds, so the prompt the model receives has a
single consistent numeric sequence and the client renders them in the order they appear in the
answer text.

### 4. Apply redaction uniformly in the new builder

The prompt builder in `runHybridGroundedAsk` applies the gateway redactor to every selected
excerpt at the point of prompt construction, regardless of which engine produced it. The existing
per-engine redaction paths in the folder and connector sub-runners are unchanged; the hybrid
builder adds a second uniform pass over the merged set so that no unredacted content from either
engine reaches the gateway call.

### 5. Single-kind paths are unchanged

The `handleGroundedAsk` dispatcher routes folder-only chats to the existing `#532` multi-source
lexical path and connector-only chats to the existing `#189` vector path, before the hybrid merge
stage is reached. RRF and the shared budget are applied exclusively in the hybrid case. No
existing behaviour changes for single-kind chats.

## Consequences

### Positive

- **Removes structural folder dominance.** The folder side no longer holds a byte-budget
  advantage by construction. Both sides compete for the same slots on equal rank-footing.
- **Deterministic.** RRF with a fixed `k` is deterministic given a fixed retrieval ordering from
  each engine; no randomness is introduced.
- **Parameter-light.** A single constant `k = 60` is the only RRF parameter; it has a decades-
  long empirical basis and no per-deployment tuning is required.
- **Engine-agnostic.** Adding a third retrieval engine (e.g., a future graph retriever) requires
  only that it return a ranked list; the fusion formula extends naturally.
- **Operator-configurable.** The shared budget caps are in the `grounding` config block alongside
  existing grounding limits; no code change is needed to tune for deployment scale.

### Negative

- **Rank-fair, not relevance-absolute.** RRF equalises the influence of ranks, not relevance
  scores. A folder candidate ranked 1st by a weak lexical match receives the same fusion
  contribution as a connector candidate ranked 1st by a strong semantic match. Without a cross-
  encoder that can score both kinds on a common semantic scale (which does not exist in the current
  stack), this is the best attainable fairness guarantee.
- **Total evidence volume may decrease** for chats that previously benefited from both full
  independent budgets. Operators who need larger context windows should raise `hybridMaxExcerptBytes`.
- **Per-source caps are relaxed.** The shared-budget model does not enforce a minimum evidence
  floor per source; a source that ranks poorly across all its candidates may contribute nothing to
  the selected set. This is the intended behaviour (relevance wins), but operators who require
  "always include at least one excerpt from each connected source" must implement a per-source
  minimum in a future configuration extension.

### Neutral

- The two citation arrays (`citations` and `knowledgeCitations`) remain separate to preserve
  renderer compatibility; merged evidence appears as one interleaved prompt section despite the
  separate arrays.
- The `hybridMaxCandidates` / `hybridMaxExcerptBytes` defaults require empirical calibration
  against the existing per-engine ceilings; the initial defaults should be validated against live
  sessions before being declared stable.

## Alternatives Considered

### Alternative 1: Re-embed all candidates on a shared cosine scale

All candidates (folder excerpts and connector chunks) are re-embedded using a single embedding
model, and their cosine similarities to the query vector are used to select and rank the merged
set.

- **Pros**: produces a genuine semantic score on a common scale; a cross-encoder variant could
  distinguish "highly relevant but short folder excerpt" from "moderately relevant but long
  connector chunk."
- **Cons**:
  1. Connector excerpt text is a character-range slice of an indexed chunk; re-embedding the
     slice does NOT reproduce the vector stored for the whole chunk, so the new score is not a
     meaningful comparison to the original indexed similarity.
  2. Capsules can be configured with different embedding models (different providers, different
     vector dimensions) and different similarity metrics (`cosine`, `dot`, `negativeEuclidean`).
     No single query vector is valid across heterogeneous capsules, and dimension mismatches
     would require projection layers that do not exist.
  3. Re-embedding all N folder candidates and M connector candidates adds N+M synchronous
     embedding API calls per grounded ask, with no batch-array input available on the current
     `EmbeddingAdapter`. Under realistic loads this adds latency in the hundreds-of-milliseconds
     to seconds range.
  4. A homogeneous single-model case (one capsule, one embedding model, cosine similarity) is
     the only scenario where this approach is sound. It is retained as a guarded future
     enhancement: when ALL connectors in a hybrid chat share one embedding model and one metric,
     the fusion stage MAY fall through to cosine reranking; otherwise it falls back to RRF.
- **Why rejected**: not generally applicable given heterogeneous capsule configurations; adds
  latency and embedding API cost on every hybrid ask; the slice-re-embedding semantic mismatch
  undermines the value even in the homogeneous case.

### Alternative 2: Fixed equal quota per source

The shared budget is divided equally among all connected sources (folders + connectors), and each
source fills its quota from its top-ranked candidates.

- **Pros**: every source is guaranteed representation; simple to implement; no fusion constant to
  tune.
- **Cons**: ignores relevance entirely. A folder with no relevant content still consumes its full
  quota, displacing high-relevance connector candidates. A connector that returns highly relevant
  results cannot claim budget beyond its fixed share even when other sources are exhausted. The
  result is consistent misrepresentation of the actual relevance distribution across sources.
- **Why rejected**: RRF is strictly better when the goal is to maximise relevance of the
  selected evidence set; equal quotas optimise source coverage at the expense of relevance.

### Alternative 3: Score normalisation (min-max or z-score per engine)

Each engine's native scores are normalised to \[0, 1\] within the current retrieval response, and
the normalised scores are compared directly to rank merged candidates.

- **Pros**: preserves intra-engine score spread; no new constant.
- **Cons**: normalisation is response-local (min and max change with every query), so the scale
  is only consistent within one engine's single response — not across engines. A connector with
  scores \[0.95, 0.94, 0.93\] normalises to \[1.0, 0.47, 0.0\] and a folder with scores
  \[0.4, 0.3, 0.1\] normalises to \[1.0, 0.67, 0.0\]; the top candidates in each engine score
  identically and the spread information is destroyed. Cross-engine comparisons remain
  uninformative for similar-score lists.
- **Why rejected**: normalisation does not solve the incommensurability problem for retrieval
  lists with similar score spreads (the common case); RRF uses rank position directly, which is
  the stable signal that normalisation approximates.

## Related

- [ADR-0034](ADR-0034-hybrid-multi-source-grounding.md): establishes the hybrid merge layer and
  the `HybridGroundedAnswer` contract that this ADR refines.
- [ADR-0022](ADR-0022-connected-context-privacy.md): privacy contract for grounded answers and
  evidence retention; the uniform redaction pass in §4 upholds this contract in the hybrid case.
- Cormack, G. V., Clarke, C. L. A., & Buettcher, S. (2009). _Reciprocal rank fusion outperforms
  Condorcet and individual rank learning methods._ SIGIR 2009.
  <https://dl.acm.org/doi/10.1145/1571941.1572114>
- Luan, Y. et al. (2022). _Sparse, Dense, and Attentional Representations for Text Retrieval._
  TACL 10. (Contextualises hybrid retrieval tradeoffs in production IR systems.)

## Date

2026-06-08
