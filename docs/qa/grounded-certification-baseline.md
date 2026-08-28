# Grounded certification baseline — Knowledge M1 (#2555 / #2563)

This record is **body-free**: it names the certification gates, their metric values, their floors, and
the commands that produce them. It contains no fixture bodies, no query text, no excerpt or claim
text, no manual/crawled page content, no private paths or URLs, and no provider endpoints or
credentials — only metric names, numbers, and gate identifiers.

## Purpose and consumer contract

The Knowledge north star (#2554) certifies **provably grounded answers**. K M8 (#2562) runs the full
certification matrix (entailment + faithfulness + retrieval recall + abstention + multi-hop) and must
measure the finished program against an **honest "before"**. This document freezes that "before": the
grounded-answer metric values at the point Knowledge M1 shipped citation-support verification
(ADR-0144). K M8 compares its matrix against the values recorded here; a regression below any floor
listed below is a certification failure, not a narrative.

All values are produced by the deterministic, hermetic CI gates below (no network, no wall-clock
dependence), so they are reproducible from any checkout at the recording commit by running the listed
command. Recording context: the K M1.2 delivery on branch `oscharko/epic-2555-implementation-340194`,
merged to `dev` via the ADR-0135 direct-check path (the merge commit is the recording SHA; the values
are commit-independent because every gate is deterministic).

## Recorded scorecards

### `check:grounded-entailment` — NEW in M1.2 (ADR-0144)

`npm run check:grounded-entailment`

| Metric                                            | Value  | Floor    |
| ------------------------------------------------- | ------ | -------- |
| fixtures                                          | 15     | —        |
| unsupported-claim detection rate                  | 100.0% | 100.0%   |
| claim precision (no false positives)              | 100.0% | 100.0%   |
| degradation correctness (unavailable ⇒ WARN)      | 100.0% | 100.0%   |
| non-tautology proven (pass-through checker fails) | yes    | required |

The gate scores the real path-and-line and numeric-marker claim-segmentation / entailment-
reconciliation / marker logic over a deterministic scripted judge (the same `EntailmentJudge` port
the gateway judge implements). The non-tautology proof is intrinsic: a pass-through judge must fail
to detect the unsupported fixtures.

### `check:grounded-faithfulness` — membership moat (unchanged floors)

`npm run check:grounded-faithfulness`

| Metric                                      | Value  | Floor  |
| ------------------------------------------- | ------ | ------ |
| fixtures                                    | 12     | —      |
| unsupported (fabricated) citation detection | 100.0% | 100.0% |
| citation precision                          | 100.0% | 100.0% |
| abstention on empty evidence                | 100.0% | 100.0% |

### `check:retrieval-quality`

`npm run check:retrieval-quality`

| Metric                          | Value   | Floor                                                                                                |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| workspace cases                 | 15      | —                                                                                                    |
| top-1 rate                      | 100.0%  | (see gate budget)                                                                                    |
| recall@5                        | 100.0%  | ≥ 90.0%                                                                                              |
| MRR                             | 1.000   | ≥ 90.0%                                                                                              |
| nDCG@5                          | 1.000   | —                                                                                                    |
| line-hit rate                   | 100.0%  | —                                                                                                    |
| generated-artifact leaks        | 0       | 0                                                                                                    |
| Local-Knowledge fixtures passed | 29 / 29 | recall ≥ 0.900; precision ≥ 0.800; mrr ≥ 0.900; ndcg ≥ 0.900; isolation ≥ 1.000; no-evidence ≥ 1.000 |

### `check:grounded-retrieval-quality`

`npm run check:grounded-retrieval-quality`

| Metric (mode = baseline) | Value  | Floor   |
| ------------------------ | ------ | ------- |
| cases                    | 10     | —       |
| top-1 rate               | 100.0% | ≥ 80.0% |
| recall@3                 | 100.0% | ≥ 90.0% |
| nDCG@3                   | 1.000  | ≥ 0.85  |
| citation-support rate    | 100.0% | ≥ 80.0% |

Non-tautology controls (must fail closed): `reranker-reversed` and `embedding-flat` regression modes
both drop below the floors (`ok=false`), proving the gate measures the real semantic/RRF/reranker
path.

## Notes for M8

- The entailment gate above is **single-answer** entailment. Multi-hop non-tautology proofs belong to
  K M5 (#2559); M8 measures both against this anchor once M5 lands.
- The connector (`[n]`) topology performs citation-support via the pre-existing token-overlap check
  (`citation-attacher.ts`); its unification onto the shared NLI judge is a K M2 (#2556) follow-up. M8
  should record which topology's mechanism produced each entailment number.
- Floors on the two faithfulness/entailment gates are correctness invariants pinned at 1.0 and must
  not be lowered to obtain a green certification.

## Knowledge M2 unified-substrate closeout (#2572)

`npm run check:knowledge-m2-closeout`

This additive closeout records the six-way conjunction required to retire the Knowledge M2
substrate. The detailed, body-free record is generated at
[`knowledge-m2-substrate-evidence.md`](knowledge-m2-substrate-evidence.md); the M1 values above
remain unchanged.

| Proof area             | Recorded result                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------- |
| ANN                    | 20,001 vectors; minimum recall@10 = 1.000; zero capsule-partition violations       |
| ANN degradation        | encrypted-store fallback, missing-extension fallback, and disabled control pass    |
| Reranker facade        | one transport importer; importer-set hash is recorded in the detailed evidence     |
| Evaluation harness     | 29 fixtures; 16 live regression probes; deterministic scorecard hash               |
| Retrieval-context wire | pinned snapshot hash; neutral purpose remains `chat-grounding`                     |
| Repository pod         | 10 fingerprints, indexed paths, and aligned vectors; zero ask-time document embeds |
| Program bookkeeping    | HS-6 closure and Matrix A substrate delta are ready                                |

The gate emits evidence only when all six proof areas pass together. Its negative controls keep
the ≥ 0.95 ANN recall floor, reranker-reversed and embedding-flat regressions, the tautological
evaluation control, neutral-purpose rejection for editor assembly, and fail-closed ANN fallback
diagnostics live.
