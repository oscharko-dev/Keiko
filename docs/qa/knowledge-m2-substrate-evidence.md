# Knowledge M2 unified-substrate evidence

This record is body-free and deterministic. It contains only counts, rates, hashes, statuses, and proof identifiers.

Wall-clock latency buckets are characterization, not a deterministic fact — the closeout run
reports them on stdout and deliberately keeps them out of this document.

| Proof          | Metric                                 |                                                            Value |
| -------------- | -------------------------------------- | ---------------------------------------------------------------: |
| ANN            | vector rows                            |                                                            20001 |
| ANN            | exact scan cap                         |                                                            20000 |
| ANN            | provider                               |                                                          usearch |
| ANN            | search mode                            |                                                              ann |
| ANN            | examined candidate ceiling             |                                                           <20001 |
| ANN            | index byte ceiling                     |                                                      <=268435456 |
| ANN            | minimum recall@10                      |                                                            1.000 |
| ANN            | encrypted ANN diagnostic               |                                                        available |
| ANN            | SQLite extension authority denied      |                                                             true |
| ANN            | native persistence API references      |                                                                0 |
| ANN            | load diagnostic                        |                                              runtime-unavailable |
| ANN            | partition violations                   |                                                                0 |
| ANN            | latency vector dimensions              |                                                              384 |
| ANN            | latency large rows                     |                                                            50000 |
| ANN            | latency small rows                     |                                                              500 |
| ANN            | latency large search mode              |                                                              ann |
| ANN            | latency small search mode              |                                                            exact |
| ANN            | qualified RSS delta ceiling            |                                                      <=536870912 |
| ANN            | latency large minimum recall@10        |                                                            1.000 |
| ANN            | degenerate injection max recall        |                                                            0.000 |
| ANN            | degenerate decoy chunk count           |                                                               10 |
| ANN            | latency characterization document      |             docs/qa/knowledge-m2-ann-latency-characterization.md |
| Reranker       | facade importer count                  |                                                                1 |
| Reranker       | importer-set hash                      | dd9bce4fc3ee0c1fb880f10a1e1837e9df317b3df318c8b324ed2f9ba2e1e8fd |
| Evaluation     | fixture count                          |                                                               29 |
| Evaluation     | live probe count                       |                                                               16 |
| Evaluation     | scorecard hash                         | 8c0b19e097f39cba61fbe588c64996db64c8b676c3f4b8b401ecd0c84bf0986b |
| Wire           | snapshot hash                          | 9ee38880de5f349e56f27724dd35c7472c661629a79541434dde5ca27036b8a9 |
| Wire           | neutral purpose id                     |                                                   chat-grounding |
| Repository pod | provider id                            |                                  configured-repo-semantic-search |
| Repository pod | fingerprint count                      |                                                               10 |
| Repository pod | indexed path count                     |                                                               10 |
| Repository pod | aligned vector count                   |                                                               10 |
| Repository pod | retrieval-mode hash                    | 17f3174a97385d8d7b9b5514f53433fd19cceed0b87d326346499bac8a1c1837 |
| Repository pod | ask-time document embedding count      |                                                                0 |
| Repository pod | editor provider status (informational) |                                                     lexical-only |
| Bookkeeping    | ready item count                       |                                                                2 |

Verify with `npm run check:knowledge-m2-closeout`, which compares this committed artifact
against a freshly rendered one and fails closed on drift. Regenerate with
`npm run check:knowledge-m2-closeout -- --write`.
