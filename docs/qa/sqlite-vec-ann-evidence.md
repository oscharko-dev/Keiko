# sqlite-vec ANN activation evidence

## Scope

This note records the content-free qualification evidence for the Local Knowledge sqlite-vec
activation in Issue #2566. The corpus is synthetic and seeded; no source text, embedding body,
capsule identifier, endpoint, or user data is retained here.

The runtime is the exact `sqlite-vec@0.1.9` npm package recorded in `package-lock.json`. Keiko keeps
`KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX` disabled by default. `auto` or `sqlite-vec` selects the packaged
loader unless `KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH` explicitly selects an extension
path. A store opened without one of those active, resolved configurations still denies SQLite
extension loading.

## Platform matrix

| Platform    | Distribution selected by npm    | Qualification                                       |
| ----------- | ------------------------------- | --------------------------------------------------- |
| macOS arm64 | `sqlite-vec-darwin-arm64@0.1.9` | Local real-binary journey passed                    |
| macOS x64   | `sqlite-vec-darwin-x64@0.1.9`   | Install-time package mapping; CI smoke target       |
| Linux x64   | `sqlite-vec-linux-x64@0.1.9`    | Authoritative CI real-binary journey; never skipped |

The upstream loader also declares Linux arm64 and Windows x64 packages. Any unrecognized
platform/architecture causes the module load to fail closed with the existing
`sqlite-vec-module-load-failed` diagnostic, after which the established exact/guided/LSH ladder
runs. The test makes this an asserted fallback on unsupported hosts; it does not use a capability
skip. A configured but corrupt extension path likewise produces the existing
`sqlite-vec-extension-load-failed` diagnostic and falls back.

## Seeded measurements

Measured locally on macOS arm64 with Node 24.18.0 and sqlite-vec 0.1.9. Times are single-run
characterization values in milliseconds, not release budgets. Linux CI is authoritative for
binary load and correctness; these macOS values are not substituted for Linux evidence.

| Path                   | Vector rows | Cold build/query | Warm query | Recall@5 | Recall@10 |
| ---------------------- | ----------: | ---------------: | ---------: | -------: | --------: |
| Exact brute force      |      20,000 |             83.9 |        n/a |     1.00 |      1.00 |
| sqlite-vec TEMP `vec0` |      20,000 |          2,586.3 |       62.3 |     1.00 |      1.00 |
| sqlite-vec TEMP `vec0` |     100,001 |         14,691.9 |    1,286.1 |     1.00 |      1.00 |

The exact path intentionally stops at `DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS = 20_000`; no
100,001-row exact latency is reported because that code path does not claim to execute there.
Above the cap, the comparison is availability and recall: the ANN path still returns the exact
top-k ordering on the seeded corpus, while a disabled or unavailable runtime uses the existing
guided/LSH degradation ladder.

## Correctness and trust-boundary evidence

The co-located real-binary journey exercises `runLocalKnowledgeRetrieval` through
`searchVectorsForScope` and `processCapsule` with 20,001 vectors. It proves:

- the `temp.keiko_lk_vec_4_cosine` path is reported as available;
- top-k matches the deterministic exact ordering for `k = 5` and `k = 10`;
- scores at the sqlite-vec boundary obey `score = 1 - distance`;
- a write through `insertVectorRow` marks `vector_index_state` dirty and the next query rebuilds;
- encrypted stores retain `fallback-encrypted-store` and brute-force results;
- corrupt paths, incompatible query dimensions, and stored identity mismatches retain their
  existing diagnostics and fallback behavior; and
- an unset flag is byte-identical to explicit disabled mode.

Both loader routes re-disable SQLite extension loading in a `finally` block. The vec0 table remains
TEMP/runtime-local, and encrypted stores are rejected before the loader is invoked.
