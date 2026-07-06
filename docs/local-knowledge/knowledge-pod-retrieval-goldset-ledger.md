# Knowledge Pod Retrieval Goldset & Scorecard Ledger

Status: implementation and verification ledger for Epic #1826 and child issues #2008-#2013.

This ledger records evidence only. It is not a substitute for local gate output, PR review, or
human-owned issue closure after merge. Epic #1826 reuses — and deliberately does not
re-implement — the retrieval evaluation harness, scorecard metrics, and governance enforcement
shipped by Epics #1817 (hybrid retrieval quality), #1818 (embedding-space governance), and #1819
(pod model-use policy and sealed local pods). The residual work in this epic is a single
documented taxonomy, one authoritative metric reference, one unified per-leg comparison view, one
new sealed-pod scorecard fixture, and the release evidence recorded here.

## Prior art and reuse anchors

| Area               | Reused surface                                                                                                                                   | This epic's residual work                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Eval harness       | `runRetrievalEval` over `ALL_FIXTURES` in `packages/keiko-local-knowledge/src/evaluations`, `runLocalKnowledgeRetrieval` invoked unchanged       | One new goldset fixture (`sealed-pod`) and one pure aggregation module (`comparison.ts`); no parallel harness |
| Scorecard metrics  | `recall`, `precision`, `meanReciprocalRank`, `ndcg`, `sourceIsolation`, `citationQuality`, `noEvidenceAccuracy`, `contextBudgetFit` (Epic #1817) | Documented reference only; no metric re-implemented                                                           |
| Multi-space fusion | `multi-space` fixture, rank-only cross-space RRF, embedding profile status handling (Epic #1818)                                                 | Confirmed and mapped in the taxonomy; no new cross-space code                                                 |
| Sealed-pod policy  | `sealedLocalPodModelUsePolicy`, deny-wins scope aggregation, fail-closed `policy-denied` retrieval (Epic #1819)                                  | Made scorecard-visible via the new `sealed-pod` fixture; policy layer unchanged                               |
| Reranking gate     | `check:grounded-retrieval-quality` baseline, `reranker-off` control, `reranker-reversed`/`embedding-flat` regressions                            | Referenced as the owning reranking gate; not duplicated                                                       |
| Redacted reporting | `renderRetrievalEvalQualityGateReport`, body-free scorecard rows                                                                                 | Body-free outcome counts/statuses and `renderRetrievalModeComparisonReport`                                   |

## Goldset taxonomy (#2008)

Each Knowledge Pod retrieval scenario names the user or governance risk it detects, the fixture
or gate that already owns it, and its outcome class. Outcome classes separate relevance movement
from policy, degradation, and evidence-shape outcomes so a governance failure is never hidden
inside an aggregate relevance score.

| Scenario                   | Risk detected                                                                                                       | Owning fixture / gate                                                     | Outcome class              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------- |
| Exact technical lookup     | Wrong file for exact ADR ids, API names, error codes                                                                | `exact-technical` (`check:retrieval-quality`)                             | relevance                  |
| Semantic paraphrase        | Misses evidence when wording differs from the corpus                                                                | `semantic-paraphrase` (`check:retrieval-quality`)                         | relevance                  |
| Multilingual retrieval     | Misses cross-language evidence                                                                                      | `multilingual-retrieval` (`check:retrieval-quality`)                      | relevance                  |
| Local capsule baseline     | The shipped local-only capsule and capsule-set path drifts                                                          | `single-topic`, `multi-capsule` (`check:retrieval-quality`)               | relevance                  |
| Hybrid fusion coverage     | One retrieval leg silently masks another                                                                            | `mixed-strategy`, `broad-query-diversity`, mode comparison (#2010)        | relevance                  |
| Ambiguous / tied relevance | Recall drops when multiple chunks are equally acceptable and only one comes back                                    | `ambiguous-query` (`check:retrieval-quality`)                             | relevance                  |
| Cross-space rank fusion    | Invalid raw-score comparison across embedding spaces                                                                | `multi-space` (Epic #1818)                                                | relevance                  |
| Reranking regression       | Reranker suppresses the expected grounded result                                                                    | `reranker-off` / `reranker-reversed` (`check:grounded-retrieval-quality`) | relevance                  |
| Sealed-pod access denial   | Policy bypass, content leak, or denial shown as a quality miss                                                      | `sealed-pod` (new, #2011) + `model-use-policy.test.ts` (Epic #1819)       | policy                     |
| Source isolation           | Cross-pod evidence leak                                                                                             | `source-isolation` (`check:retrieval-quality`)                            | policy / evidence          |
| No-evidence / wrong scope  | Hallucination when nothing relevant is in scope                                                                     | `no-evidence`, `wrong-scope` (`check:retrieval-quality`)                  | evidence-shape             |
| Stale embedding identity   | Serving vectors under an incompatible query identity                                                                | `stale-index` (`check:retrieval-quality`)                                 | degradation                |
| Structured citations       | Malformed or missing citation fields per unit kind                                                                  | `structured-files`, `multi-page` (`check:retrieval-quality`)              | evidence-shape             |
| Context-budget fit         | Grounding context overflows a bounded window                                                                        | `context-budget` (`check:retrieval-quality`)                              | degradation                |
| Remote-pod degradation     | Remote timeout / unavailable / denied / opaque-score behaviour                                                      | Deferred — no owning fixture; blocked on Epic #1822 (see #2012)           | degradation (deferred)     |
| Technical HTML structure   | Structure-preserving HTML manual extraction (table rows, anchors, definitions, multilingual) stops being recallable | `html-manual-structure` (`check:retrieval-quality`, Epic #1855)           | relevance / evidence-shape |

### Fixture safety rules

- Fixtures are hand-authored synthetic content only. They never contain private source bodies,
  raw customer queries, secrets, endpoints, provider traces, or PII.
- Every fixture is deterministic: the harness composes production retrieval through a scripted
  embedding adapter, so each scorecard is byte-identical across runs and machines.
- Scorecard and comparison output reports fixture ids, counts, metric values, thresholds, and
  pass states only — never raw bodies or private payloads.

## Scorecard metrics (#2009)

Recall@K, MRR, and nDCG-style ranking metrics already run in `check:retrieval-quality` over the
registered fixtures. This epic did not re-implement them; the authoritative reference is below.
Thresholds are the exported `PASS_THRESHOLDS` constant.

| Metric               | Scorecard dimension  | Pass floor  | Detects                                                   | Semantics |
| -------------------- | -------------------- | ----------- | --------------------------------------------------------- | --------- |
| Recall@K             | `recall`             | 0.90        | Missed ground-truth chunks                                | gating    |
| Precision            | `precision`          | 0.80        | False-positive chunks in the returned set                 | gating    |
| Mean reciprocal rank | `meanReciprocalRank` | 0.90        | Relevant chunk buried late in the ranked list             | gating    |
| nDCG (binary)        | `ndcg`               | 0.90        | Poor rank ordering of relevant chunks                     | gating    |
| Source isolation     | `sourceIsolation`    | 1.00 (hard) | Cross-pod evidence leak across the scope boundary         | gating    |
| Citation quality     | `citationQuality`    | 0.90        | Malformed or missing citation fields per parsed-unit kind | gating    |
| No-evidence accuracy | `noEvidenceAccuracy` | 1.00 (hard) | Wrong abstention AND wrong no-evidence reason             | gating    |
| Context-budget fit   | `contextBudgetFit`   | 1.00 (hard) | Grounding context overflow                                | gating    |
| Latency (ticks)      | `latencyMs`          | advisory    | Determinism / synthetic latency signal                    | advisory  |

The workspace-level `check:retrieval-quality` path over synthetic repositories keeps its own
`check-retrieval-quality.budget.json` floors (top-1, recall@5, MRR, nDCG@5, line-hit at 1.0 and
zero generated-artifact leakage); those are unchanged.

Residual "policy / degradation-outcome scoring" gap: closed by reuse plus a body-free outcome
summary, not by duplicating metrics. The `noEvidenceAccuracy` dimension already scores the
no-evidence reason, so `policy-denied` (policy) and `incompatible-embedding-identity`
(degradation) are first-class scorecard outcomes. Scorecards now also report query/reference counts
and no-evidence reason counts such as `policy-denied:1`, so reviewers can distinguish governance
status from relevance movement without raw bodies. The new `sealed-pod` fixture (#2011) exercises
the `policy-denied` branch at the scorecard level; `stale-index` already exercises the degradation
branch. No new ranking metric helper was required.

## Retrieval-mode comparison (#2010)

`computeRetrievalModeComparison` / `renderRetrievalModeComparisonReport`
(`packages/keiko-local-knowledge/src/evaluations/comparison.ts`) aggregate the existing
per-fixture scorecards into one per-leg view. `scripts/check-retrieval-quality.mjs` now emits that
comparison report next to the existing Local Knowledge scorecard table, so the required gate shows
lexical, vector, and fused movement in one place. It adds no retrieval path and no fixtures: it
groups the mode-representative fixtures Epics #1817/#1818 already ship and reports each leg's
aggregate ranking metrics plus its headroom above the gate floor. Reranking is intentionally out of
scope here — its regression control is owned by `check:grounded-retrieval-quality` and must not be
duplicated.

| Mode    | Fixtures                                           | Recall | Precision |   MRR |  nDCG | Floor headroom | Hybrid queries | Pass |
| ------- | -------------------------------------------------- | -----: | --------: | ----: | ----: | -------------: | -------------: | ---- |
| lexical | exact-technical                                    |  1.000 |     1.000 | 1.000 | 1.000 |          0.100 |              0 | PASS |
| vector  | semantic-paraphrase, multilingual-retrieval        |  1.000 |     1.000 | 1.000 | 1.000 |          0.100 |              0 | PASS |
| fused   | multi-space, broad-query-diversity, mixed-strategy |  1.000 |     1.000 | 1.000 | 1.000 |          0.100 |             >0 | PASS |

Floor headroom is the smallest margin of the ranking metrics above their pass floors. A negative
value marks a mode-specific regression. For the `lexical` and `vector` rows, `comparison.test.ts`
fails closed by repointing that leg's ground-truth expectations at a decoy chunk and asserting the
row drops below the floor — the same injected-regression technique the shipping quality gate uses
("surfaces a lexical-leg regression", "surfaces a vector-leg regression"). The `fused` row needs a
second, independent regression proof: floor headroom alone cannot detect RRF fusion silently
degrading to a single surviving lane, because a fused-labelled fixture's expected chunk can still be
found by whichever single lane survives, holding recall/precision/MRR/nDCG at a perfect 1.0. To
close that gap, the `fused` row also requires `hybridQueryCount > 0` — direct evidence, read from
the production `RetrievalDiagnostics.mode` tag that `runLocalKnowledgeRetrieval` already reports per
query, that at least one query actually exercised both the lexical and dense lanes together
("hybrid" mode). `comparison.test.ts` proves this closes the gap with a synthetic-scorecard
regression case ("surfaces a silent fusion regression even when recall/precision/MRR/nDCG stay
perfect"): every fused-labelled fixture is given a perfect score but `retrievalModeCounts` records
only a single surviving lane, and the row is asserted to fail (`passed: false`) despite clearing the
floor — proving the fused row cannot pass on the floor check alone. A mode-specific regression is
acceptable only when a dedicated issue documents the ranking change and the reason the trade-off
improves overall answer quality.

## Governance fixtures (#2011)

Multi-space and sealed-pod enforcement already shipped and are reused, not rebuilt:

- Multi-space rank fusion is proven by the `multi-space` fixture and its non-tautology regression
  probe, plus embedding profile status handling in `local-knowledge-embedding-profiles.test.ts`,
  `knowledge-pods.test.ts`, and `scoped-vector-search.test.ts` (Epic #1818).
- Sealed-pod fail-closed enforcement is proven at the index, query, synthesis, rerank, and
  evidence-persistence gates by `model-use-policy.test.ts` and the mixed sealed+standard coverage
  in `scoped-vector-search.test.ts` (Epic #1819), including the deny-wins scope aggregator.

The residual gap — sealed-pod behaviour was proven at the policy layer but not visible at the
scorecard layer the way `multi-space` is — is closed by the new `sealed-pod` goldset fixture:

- The pod carries `sealedLocalPodModelUsePolicy()`, which denies external embeddings. Its query is
  lexically disjoint from the chunk body, so the only route to the chunk is the policy-denied dense
  lane, and the query shares the chunk's topic salt so an unsealed pod would retrieve it.
- Retrieval therefore returns `noEvidence` with reason `policy-denied`. `noEvidenceAccuracy` is
  1.0 only when the reason matches exactly, so a passing scorecard is a positive assertion that
  the seal — not a lexical or semantic gap — produced the outcome, and that the denial is reported
  as governance behaviour rather than a recall miss.
- `sealed-pod.test.ts` adds a mutation witness: flipping the pod to `standardPodModelUsePolicy()`
  retrieves the chunk, drops `noEvidenceAccuracy` to 0, and fails the card — proving the fixture is
  non-tautological.
- The primary fixture query is deliberately lexically disjoint from the chunk body, so on its own
  it only ever proves the dense lane is gated — it cannot detect a policy gap in the lexical/BM25
  lane. An independent audit of this ledger (#2011 finding) confirmed the lexical lane was in fact
  ungated: `collectLexicalCandidatesForCapsule` read raw FTS rows with no `rawContentRelease`
  check, so a query that lexically matched the sealed chunk body leaked it as a normal reference
  (`referenceCount: 1`) instead of a `policy-denied` no-evidence outcome. This is now closed at the
  owning layer in `scoped-vector-search.ts` (`isRawContentReleaseAllowed`, threaded through
  `LexicalCollection.policyDenied` into `selectTopCandidates`/`hasEmbeddingDegradation`), with
  regression coverage that fails before the fix and passes after: `sealed-pod.test.ts` ("also
  denies a lexically-matching query"), `scoped-vector-search.test.ts` ("denies the lexical lane
  too"), and `retrieval-runner.test.ts` ("denies the lexical lane too when a sealed pod has
  lexically-matching candidates"). The `Sealed-pod access denial` taxonomy row's "content leak"
  risk is scorecard-visible across both lanes only as of this fix.
- The quality-gate report renders only fixture ids, numeric metrics, pass state, and body-free
  outcome counts/statuses (`policy-denied:1` for the sealed fixture). The sealed-pod report test
  asserts the body and query text are absent.

## Remote-pod degradation — deferred (#2012)

Remote Knowledge Pod degradation fixtures are explicitly deferred. As of 2026-07-06, Epic #1822
and all six of its child issues (#1933-#1938) are open with no shipped implementation. The current
repository contains only placeholder compatibility tokens for future remote/federated pod members,
not an active remote retrieval transport or #1933 capability/policy contract. Building fixtures
against an assumed remote-pod contract would violate this epic's "detached benchmark" non-goal and
risk throwaway rework. Per the epic's Definition of Done and #2013's acceptance criteria, #2012
carries a "deferred pending Epic #1822" disposition and does not block epic closure. It must be
resumed once Epic #1822's contract issue (#1933, "Define remote/federated Knowledge Pod capability
and policy contracts") ships real capability and policy contracts to evaluate against.

## Gate matrix (#2013 release evidence)

| Gate                          | Status | Evidence                                                                                                                                                                                                                                 |
| ----------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused eval and gate tests   | passed | `npm test -- --run packages/keiko-local-knowledge/src/evaluations scripts/__tests__/check-retrieval-quality.test.mjs` — 9 files, 110 tests, including `sealed-pod.test.ts`, `comparison.test.ts`, and retrieval-gate wiring              |
| TypeScript                    | passed | `npm run typecheck` — `build:packages`, `check:package-graph` PASS, `tsc -p tsconfig.json --noEmit`                                                                                                                                      |
| Lint                          | passed | `npm run lint` — `eslint . --max-warnings=0` and the keiko-ui workspace lint                                                                                                                                                             |
| Format                        | passed | `npm run format:check` — all matched files use Prettier code style                                                                                                                                                                       |
| Package surface               | passed | `npm run clean && npm run build && npm run build:ui && npm run prepare:bin && npm run prune:package-build-artifacts && npm run prune:package-native-optionals && npm run check:package-surface` — 4,187 files, `dist/ui/static` present  |
| Architecture                  | passed | `npm run arch:check` — no dependency violations (2,596 modules), import-policy PASS, contract boundary check PASS                                                                                                                        |
| Architecture (negative)       | passed | `npm run arch:check:negative` — gate fired on 47 negative fixture(s) as expected                                                                                                                                                         |
| Retrieval quality (scorecard) | passed | `npm run check:retrieval-quality` — workspace scorecard cases=15, local scorecard fixtures=17/17, threshold metadata emitted, `sealed-pod` reported `policy-denied:1`, lexical/vector/fused comparison emitted, 4 regression probes held |
| Grounded retrieval quality    | passed | `npm run check:grounded-retrieval-quality` — baseline and `reranker-off` clear floors; `reranker-reversed` and `embedding-flat` regressions fail closed                                                                                  |
| Grounded faithfulness         | passed | `npm run check:grounded-faithfulness` — 8 fixtures; unsupported-detection, citation-precision, and abstention at 100%                                                                                                                    |
| Release impact                | passed | `npm run check:release-impact` — current package version has reviewed update-impact metadata                                                                                                                                             |
| Full test suite               | passed | `npm test` — 979 files, 16,573 tests passed, 1 skipped                                                                                                                                                                                   |
| Coverage ratchet              | passed | `npm run test:coverage:quality` — package coverage, UI coverage, file floors, release targets, and branch ratchets passed; keiko-local-knowledge lines 90.55%, branches 78.84%, statements 88.44%, functions 93.24%                      |

## Release evidence summary (#2013)

- Sealed-pod governance denial is now measurable at the scorecard level: `sealed-pod` proves a
  sealed pod refuses the external-embedding lane and reports `policy-denied` as a governance
  outcome, verified by a self-verifying reason assertion and a mutation witness.
- Lexical, vector, and fused retrieval movement is visible in one place via the mode comparison,
  with per-leg floor headroom and a fail-closed injected-regression proof.
- The metric set, thresholds, and advisory-vs-gating semantics are documented once here rather
  than re-derived from source, and no metric, fixture, or gate was duplicated.
- Evaluation remains local-first and deterministic; no hosted service, provider SDK import, or
  network access was added.
- A release-impact catalog entry is intentionally not added by this change: Epic #1826 ships
  internal evaluation fixtures, one aggregation module, and documentation, not an npm release. The
  catalog entry is added at the release cut by the release owner as an explicit human step, with
  the `improvements` category and the `userVisibleSummary` recorded above.

## Operating guidance (#2013)

Before claiming a Knowledge Pod retrieval change improved or regressed answer quality, run:

- `npm run check:retrieval-quality` — the fixture scorecard, lexical/vector/fused comparison,
  workspace-search budget, and non-tautology regression probes.
- `npm run check:grounded-retrieval-quality` — the semantic + RRF + reranker path and its
  reranker/embedding regression controls.
- `npm run check:grounded-faithfulness` — abstention on empty evidence and fabricated-citation
  detection.
- `npm test -- --run packages/keiko-local-knowledge/src/evaluations` — the eval harness, mode
  comparison, and `sealed-pod` governance proofs.

When retrieval behaviour intentionally changes, update the affected fixtures and record why in the
owning issue; do not lower a threshold to make a regression pass. When adding a scenario, first
find its owning fixture in the taxonomy above and extend it rather than adding a parallel fixture.

## Security and architecture disposition

- No new evaluation subsystem, hosted service, managed dependency, or provider SDK import was
  introduced. `keiko-contracts` remains the leaf; the new `sealed-pod` policy is constructed from
  the existing contract factory.
- Sealed-pod enforcement remains fail-closed inside the shipped retrieval path; the eval harness
  invokes `runLocalKnowledgeRetrieval` unchanged, so the scorecard measures the architecture Keiko
  ships rather than a detached benchmark.
- Evidence is redacted: scorecards and the comparison report emit fixture ids, metrics, counts,
  enum-like reason statuses, and pass states only.

## Epic closure (#2013)

- #2008 taxonomy, #2009 metric reference, #2010 comparison, and #2011 sealed-pod fixture are
  implemented and verified above.
- #2012 remote-pod degradation is deferred pending Epic #1822 with the disposition recorded here.
- Per the epic Definition of Done, closure with #2012 deferred is explicitly permitted. Marking
  issues closed, merging, and cutting the release remain human-owned actions consistent with the
  human-control invariant; this ledger records evidence only and changes no GitHub or board state.

## Known limitations and follow-ups

- Remote and federated pod evaluation is deferred until Epic #1822 ships remote-pod contracts
  (#2012).
- The mode comparison groups fixtures by the leg they are designed to exercise; it does not force
  a single retrieval leg on a shared corpus. Per-leg forcing would require a production retrieval
  seam and is out of scope for this epic's reuse-first residual work.
- Linux CI remains authoritative for any platform-specific release evidence.
