# Embedding Space Governance Ledger

Status: implementation and verification ledger for #1818 and child issues #1843-#1848.

This ledger records evidence only. It is not a substitute for local gate output, PR review,
or human-owned issue closure after merge.

## Reuse anchors

| Area           | Reused surface                                                                           | Extension                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Contracts      | `EmbeddingModelIdentity`, `KnowledgePodSummary`, retrieval activity contracts            | Redacted embedding profile compatibility decisions and pod readiness metadata                |
| Model boundary | `@oscharko-dev/keiko-model-gateway` embedding capability checks                          | Query embedding remains behind the gateway; no provider SDK import moved outward             |
| Retrieval      | `searchVectorsForScope`, SQLite FTS/BM25 lexical leg, existing vector index adapter seam | Per-identity embedding lanes and lane-local dense ranking before RRF                         |
| Fusion         | ADR-0036 RRF                                                                             | Dense ranks are produced per embedding lane; raw vector scores are not compared across lanes |
| Server/BFF     | Existing grounded-answer retrieval activity projection                                   | Lane diagnostics map to existing redacted reason codes per affected pod                      |
| UI             | Existing Local Knowledge connector list and Knowledge Pod summary opt-in fetch           | Compact reindex/unavailable/mismatch guidance badge from summary metadata                    |

## Scenario coverage

| Scenario                             | Expected behavior                                                                                        | Regression evidence                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Same hardened profile                | Status `same`; query embedding is allowed                                                                | `local-knowledge-embedding-profiles.test.ts`                                                       |
| Unknown legacy profile               | Status `unknown`; reindex is recommended; lexical fallback remains available                             | `local-knowledge-embedding-profiles.test.ts`, `knowledge-pods.test.ts`, `connector-graph.test.tsx` |
| Incompatible profile                 | Vector lane fails closed and emits `incompatible-embedding-identity`                                     | `scoped-vector-search.test.ts`, `local-knowledge-grounded-qa.rescue.test.ts`                       |
| Unavailable or policy-denied profile | Status `unavailable`; no automatic reindex                                                               | `local-knowledge-embedding-profiles.test.ts`                                                       |
| Opaque profile                       | Status `opaque`; no raw provider details are exposed                                                     | `local-knowledge-embedding-profiles.test.ts`                                                       |
| Lexical fallback                     | Lexical candidates survive when dense embedding cannot run                                               | `scoped-vector-search.test.ts`                                                                     |
| Rank-only cross-space fusion         | Top candidates include first-ranked evidence from each lane rather than highest raw scores from one lane | `scoped-vector-search.test.ts`                                                                     |
| UI guidance                          | Users see redacted local guidance without endpoint, path, secret, or raw-content disclosure              | `local-knowledge-api.test.ts`, `connector-graph.test.tsx`                                          |

## Gate matrix

| Gate                    | Status           | Evidence                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused package tests   | passed           | `npm test -- --run packages/keiko-contracts/src/local-knowledge-embedding-profiles.test.ts packages/keiko-contracts/src/local-knowledge-pods.test.ts packages/keiko-local-knowledge/src/knowledge-pods.test.ts packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.test.ts packages/keiko-server/src/local-knowledge-grounded-qa.rescue.test.ts` |
| Focused UI tests        | passed           | `npm run test --workspace @oscharko-dev/keiko-ui -- --run src/lib/local-knowledge-api.test.ts src/app/local-knowledge/connector-graph.test.tsx`                                                                                                                                                                                                                |
| Eval fixtures           | passed           | `npm test -- --run packages/keiko-local-knowledge/src/evaluations/fixtures.test.ts packages/keiko-local-knowledge/src/evaluations/runner.test.ts`                                                                                                                                                                                                              |
| TypeScript              | passed           | `npm run typecheck`; `npm run typecheck --workspace @oscharko-dev/keiko-ui`                                                                                                                                                                                                                                                                                    |
| Lint                    | passed           | `npm run lint`; `npm run lint --workspace @oscharko-dev/keiko-ui`                                                                                                                                                                                                                                                                                              |
| Format                  | passed           | `npm run format:check`                                                                                                                                                                                                                                                                                                                                         |
| Full test suite         | passed           | `npm test`                                                                                                                                                                                                                                                                                                                                                     |
| Architecture            | passed           | `npm run arch:check`; `npm run arch:check:negative`                                                                                                                                                                                                                                                                                                            |
| Retrieval quality       | passed           | `npm run check:retrieval-quality`; `npm run check:grounded-retrieval-quality`; `npm run check:grounded-faithfulness`                                                                                                                                                                                                                                           |
| UI coverage/build       | passed           | `npm run test:coverage:ui`; `npm run build:ui`                                                                                                                                                                                                                                                                                                                 |
| Editor release evidence | CI-authoritative | Linux-authoritative committed fingerprint `8e39300b5a056f7eb72665e053d5785840475164826f8fa6c5551ae7eac531d6` is preserved in `docs/release/1209-bundle-evidence.json`; macOS-local measurement `b11bedda9822fabf6f72064e6017121ff8ca13b6813bac6d0063f8d62ba05632` was not committed.                                                                           |
| Public package surface  | passed           | Full prepack-style chain passed before the platform evidence correction; after restoring Linux-authoritative release evidence, `npm run check:package-surface` passed locally and CI repeats the Linux-authoritative chain.                                                                                                                                    |
| Release metadata        | passed           | `npm run check:version-consistency`; `npm run check:release-impact`                                                                                                                                                                                                                                                                                            |

## Known limits

- Remote and federated pods remain opaque future work unless they provide a reviewed
  compatibility contract.
- This change does not install, download, or mandate any embedding provider.
- This change does not automatically reindex private content.
- Linux CI remains authoritative for platform-specific release evidence.
