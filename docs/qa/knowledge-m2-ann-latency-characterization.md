# Knowledge M2 ANN latency characterization

This is a characterization snapshot, not a golden file. It records the most recent local
closeout measurement of the ANN vs brute-force retrieval latency on a realistic-dimensional
(384-dim) fixture. Wall-clock milliseconds are not
reproducible across hosts, so the closeout gate does NOT compare this document against a
committed baseline; the operational claim (ANN faster than brute force at the large corpus)
is enforced by `evaluateAnnProof` instead.

Content-free by construction: row counts, milliseconds, recall floors, and a categorical
winner. No vector values, no source text, no host identifiers.

| Corpus | Rows  | ANN median (ms) | Brute-force median (ms) | Min recall@10 | Faster      |
| ------ | ----- | --------------- | ----------------------- | ------------- | ----------- |
| Small  | 500   | 2.451           | 0.422                   | n/a           | brute-force |
| Large  | 50000 | 179.218         | 65.895                  | 1.000         | brute-force |

Measured winners: at 500 rows → brute-force; at 50000 rows → brute-force.

The **operational** break-even is the production exact-scan cap
(`DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS = 20000` in
`packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts`). Below the cap,
brute force answers directly and — as this fixture confirms — is often faster than vec0's
per-query SQL overhead for cosine KNN at synthetic dimensions. Above the cap, brute force is
refused and ANN is the only retrieval path, so the ANN path is faster in the operational sense
that brute force cannot answer at all. The `ann-active` proof enforces exactly that: it runs at
`vectorRows > exactScanCap` and asserts ANN succeeds where the cap forecloses brute force.

Regenerate with `npm run check:knowledge-m2-closeout -- --write`.
