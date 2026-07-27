# Knowledge M2 ANN latency characterization

This is a characterization snapshot, not a golden file. It records the most recent local
closeout measurement of the shared search service vs exact retrieval on a realistic-dimensional
(384-dim) fixture. Wall-clock milliseconds are not
reproducible across hosts, so the closeout gate does NOT compare this document against a
committed baseline; the within-run claim (ANN faster than exact at the large corpus)
is enforced by `evaluateAnnProof` instead.

Content-free by construction: row counts, milliseconds, recall floors, and a categorical
winner. No vector values, no source text, no host identifiers.

| Corpus | Rows  | Mode  | Service median (ms) | Exact median (ms) | Min recall@10 | Faster      |
| ------ | ----- | ----- | ------------------- | ----------------- | ------------- | ----------- |
| Small  | 500   | exact | 0.551               | 0.329             | n/a           | brute-force |
| Large  | 50000 | ann   | 15.054              | 54.218            | 1.000         | ann         |

Measured winners: at 500 rows → brute-force; at 50000 rows → ann.

The governed crossover is the production exact-scan cap
(`DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS = 20000` in
`packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts`). Below the cap,
the shared service deliberately executes exact search; the small row therefore characterises
service overhead rather than pretending that HNSW ran. Above the cap it executes USearch HNSW.
The large row is a genuine within-run measurement: its warm HNSW median must be lower than an
independently computed exact median, with recall@10 >= 0.95 and fewer examined candidates than
the corpus. Build time and RSS delta are recorded separately so query latency cannot hide them.

Regenerate with `npm run check:knowledge-m2-closeout -- --write`.
