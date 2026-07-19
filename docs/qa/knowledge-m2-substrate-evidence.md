# Knowledge M2 unified-substrate evidence

This record is body-free and deterministic. It contains only counts, rates, hashes, bounded latency buckets, statuses, and proof identifiers.

| Proof          | Metric                            |                                                            Value |
| -------------- | --------------------------------- | ---------------------------------------------------------------: |
| ANN            | vector rows                       |                                                            20001 |
| ANN            | exact scan cap                    |                                                            20000 |
| ANN            | minimum recall@10                 |                                                            1.000 |
| ANN            | median latency bucket             |                                                          <=100ms |
| ANN            | p95 latency bucket                |                                                          <=100ms |
| Exact          | median latency bucket             |                                                           <=10ms |
| Exact          | p95 latency bucket                |                                                           <=10ms |
| ANN            | encrypted diagnostic              |                                         fallback-encrypted-store |
| ANN            | load diagnostic                   |                                 sqlite-vec-extension-load-failed |
| ANN            | partition violations              |                                                                0 |
| Reranker       | facade importer count             |                                                                1 |
| Reranker       | importer-set hash                 | dd9bce4fc3ee0c1fb880f10a1e1837e9df317b3df318c8b324ed2f9ba2e1e8fd |
| Evaluation     | fixture count                     |                                                               29 |
| Evaluation     | live probe count                  |                                                               16 |
| Evaluation     | scorecard hash                    | 8c0b19e097f39cba61fbe588c64996db64c8b676c3f4b8b401ecd0c84bf0986b |
| Wire           | snapshot hash                     | 9ee38880de5f349e56f27724dd35c7472c661629a79541434dde5ca27036b8a9 |
| Wire           | neutral purpose id                |                                                   chat-grounding |
| Repository pod | provider id                       |                                  configured-repo-semantic-search |
| Repository pod | fingerprint count                 |                                                               10 |
| Repository pod | indexed path count                |                                                               10 |
| Repository pod | aligned vector count              |                                                               10 |
| Repository pod | retrieval-mode hash               | 17f3174a97385d8d7b9b5514f53433fd19cceed0b87d326346499bac8a1c1837 |
| Repository pod | ask-time document embedding count |                                                                0 |
| Repository pod | editor provider status            |                                                     lexical-only |
| Bookkeeping    | ready item count                  |                                                                2 |

Reproduce with `npm run check:knowledge-m2-closeout`.
