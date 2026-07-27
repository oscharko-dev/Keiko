# Knowledge M2 — acceptance ledger

Criterion-by-criterion audit of epic [#2556](https://github.com/oscharko-dev/Keiko/issues/2556) and
its eight children, taken against the branch rather than against the issues' own checkboxes. Written
during the closeout audit on 2026-07-20.

The point of this file is that "all children are closed" is not evidence. Each row below was
re-derived from code, tests, or a command — and where a criterion could not be confirmed, it says so
instead of inheriting a tick.

## How to read a verdict

| Verdict     | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| **MET**     | Re-derived from the branch: the artifact exists and asserts what was claimed. |
| **PARTIAL** | Artifact present and correctly wired; the claimed _execution_ was not re-run. |
| **NOT MET** | Confirmed not delivered on this branch. Reason given.                         |
| **OPEN**    | Genuinely unresolved — neither confirmed nor falsified. Not a proven gap.     |

`PARTIAL` is deliberately not `MET`. Several criteria are phrased as "run the gate and observe X";
this audit read the gate and its assertions but did not execute the full matrix, which is the
required CI run's job. Treat `PARTIAL` as "artifact verified, execution delegated to CI".

## Epic #2556 — Target Outcomes

| #   | Outcome                                       | Verdict     | Evidence / reason                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository questions chunk-precise and warm   | MET         | Live run against a real indexed tree: 63 s initial (49 files), 3 s with no edits and 0 re-embeds, 1/49 re-embedded after one file changed; grounded answer returned with file-and-symbol citations. Unit proof at `repository-pod.test.ts`.                                                                                                  |
| 2   | Repository visibly a pod                      | PARTIAL     | Creation and indexing confirmed end to end: the `capsule-actions.tsx` repository-mode toggle emits `{kind:"repository"}` and `local-knowledge-handlers.ts` routes that capsule into `refreshRepositoryPod`. Full projection parity with other pod kinds — every refresh affordance, every contextual-retrieval setting — was not enumerated. |
| 3   | **ANN is on — once**                          | **NOT MET** | Off for two independent reasons, both by design. `parseVectorIndexMode(undefined)` → `"disabled"` and no production composition sets `KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX`; and every production store is encrypted, which `vector-index.ts` answers with `fallback-encrypted-store`. See "Outcome 3" below.                                  |
| 4   | One reranker switch                           | MET         | `grounded-model-reranker.ts` deleted; the facade is the sole importer of `requestLiteLLMRerank` / `requestConfiguredRerank`.                                                                                                                                                                                                                 |
| 5   | One verdict (single eval harness)             | MET         | `keiko-local-knowledge/src/evaluations/*` moved wholesale to `keiko-evaluations/src/local-knowledge/*` as a 100 % rename.                                                                                                                                                                                                                    |
| 6   | Fusion spine wired into editor coding context | MET         | `retrieval-context.ts` added; `codingContext.ts` consumes `connected-context`. `quality-intelligence` / `workflow-context` remain deferred, stated in-code.                                                                                                                                                                                  |
| 7   | Nothing regresses                             | PARTIAL     | Pinned goldsets and abstention suites are present and unmodified; the full matrix is the required CI run's job, not this audit's.                                                                                                                                                                                                            |

## Children

| Issue | Criteria | MET | PARTIAL | NOT MET | Notes                                                                                      |
| ----- | -------- | --- | ------- | ------- | ------------------------------------------------------------------------------------------ |
| #2565 | 6        | 4   | 2       | 0       | Two criteria describe properties of the original PR diff, not reconstructable today.       |
| #2566 | 10       | 9   | 1       | 0       | Fallback-ladder criterion verified by reading its assertions, not by executing them.       |
| #2567 | 9        | 6   | 2       | 0       | One criterion unverifiable: the delivery is a squash commit, so per-step ordering is gone. |
| #2568 | 3        | 1   | 2       | 0       | Fold is a clean rename, which is the strongest available byte-identity evidence.           |
| #2569 | 5        | 3   | 1       | 0       | Denied-path denial now asserted for its own reason, not merely by absence.                 |
| #2570 | 5        | 2   | 3       | 0       | See the `grounded-retrieval-eval.ts` note below.                                           |
| #2571 | 7        | 3   | 3       | 0       | Cache schema version bumped and pinned; provider name and RRF seam unchanged.              |
| #2572 | 5        | 4   | 1       | 0       | AC2's "zero production edits" is superseded by the issue's own Maintainer Scope Amendment. |

No child issue has a confirmed NOT MET criterion. The one NOT MET in this milestone is epic
Outcome 3.

## Outcome 3 — why ANN is not on, precisely

Two independent gates keep it off, and neither is an oversight:

1. **The feature defaults to off.** `parseVectorIndexMode` maps anything unrecognised — including
   `undefined` — to `"disabled"`, and no production composition sets the enabling variable.
2. **Encrypted stores refuse it.** `keiko-server` always supplies a key provider, so every
   production capsule store is encrypted, and `searchSqliteVecIndex` returns
   `fallback-encrypted-store` before the extension is ever consulted.

The recall figure in the closeout evidence (`recall@10 = 1.000`) is real but was measured on an
ephemeral plaintext `:memory:` store built for the proof. It shows the ANN path is _capable_, not
that it is _active_.

Turning it on is not a matter of flipping the guard. Brute-force retrieval already decrypts vectors
into process memory, so an in-memory index is not a new exposure class — but `temp_store` is not
pinned anywhere in this repository, and SQLite may spill a TEMP table to disk. That spill is exactly
the "second on-disk plaintext vector copy" ADR-0047 forbids. A credible activation therefore needs
`PRAGMA temp_store = MEMORY`, a bounded index, and an actual demonstration that no spill occurs.

ADR-0152 anticipates this and scopes it out explicitly: encrypted-store ANN is outside M2 and
requires its own ADR. This milestone honours that boundary rather than inferring permission from the
port it introduced.

**Resolved (2026-07-20).** Both gates were addressed in follow-on Wave-2 work:

- Gate 2 (encrypted-store refusal) — resolved by [#2630](https://github.com/oscharko-dev/Keiko/issues/2630),
  which introduced [ADR-0153](../adr/ADR-0153-encrypted-store-ann-and-the-temp-store-guarantee.md).
  The guard now tests `PRAGMA temp_store` on the live connection instead of the encryption flag;
  stores that enable the vector index pin TEMP storage to memory, and the RAM-resident index is
  size-bounded (tighten-only). Encrypted-store ANN is reachable.
- Gate 1 (feature defaults to off) — resolved by [#2631](https://github.com/oscharko-dev/Keiko/issues/2631),
  which flipped `parseVectorIndexMode(undefined)` from `"disabled"` to `"auto"`. Activation is now
  decided by CAPABILITY: with a validated sqlite-vec runtime the mode resolves to ANN; without it
  the store keeps extension loading disabled and answers through brute force. The `ann-active`
  closeout proof grew an injected-degenerate assertion (a swapped-out ANN index must drop recall
  below the floor) and a recorded latency comparison at 384-dim; the break-even is the production
  exact-scan cap, above which brute force is refused and ANN is the only path.

The `NOT MET` verdict above records the state of `dev` on 2026-07-20 and is preserved as historical
audit output. Verify the current state with `npm run check:knowledge-m2-closeout`.

## Known gaps carried forward

Like the Outcome 3 verdict above, the first two entries record the state of `dev` on 2026-07-20 and
are preserved as historical audit output. Both were closed by Wave-2 children; the resolutions are
noted inline rather than by deleting the entries, so the reasoning that made them "carried forward"
at the time stays legible.

- **`grounded-retrieval-eval.ts` keeps local `average()` / `ndcgAtK()`** rather than consuming the
  shared `mean` / `binaryNdcgAtK`. The epic's Purpose names this triplication, but no child's scope
  requires resolving it here, and resolving it would mean pointing `keiko-server` at
  `keiko-evaluations` — production code depending on an evaluation harness, which is the wrong
  direction. ADR-0152 D5 placed those helpers in the harness deliberately. Left as-is on purpose.
  - **Resolved by [#2635](https://github.com/oscharko-dev/Keiko/issues/2635).** The direction
    problem was the real obstacle and it was solved by moving, not by adding an edge: `mean` and
    `binaryNdcgAtK` now live on the leaf in `keiko-contracts/src/eval-metrics.ts`, which every layer
    may already depend on. `keiko-evaluations/src/metrics.ts` re-exports them for its SDK consumers,
    the server retrieval eval imports them directly, and
    `tests/architecture/eval-metrics-single-owner.test.ts` guards the single owner structurally.
- **ADR-0152 D3 (namespace composition) is declared, not consumed.** `VectorIndexPort` has no
  importer outside `keiko-contracts`; only `embeddingIdentityKey` is consumed today. Wiring the
  `memory` and `repo` namespaces to a port with no active backend behind it would be ceremony, so
  the ADR records D3 as deferred rather than the code pretending otherwise.
  - **Resolved by [#2632](https://github.com/oscharko-dev/Keiko/issues/2632)**, once
    [#2630](https://github.com/oscharko-dev/Keiko/issues/2630) and
    [#2631](https://github.com/oscharko-dev/Keiko/issues/2631) had put an active backend behind the
    port and removed the ceremony objection. `VectorIndexPort` is now consumed outside contracts by
    `keiko-local-knowledge/src/retrieval/local-vector-index-port.ts` and
    `keiko-server/src/local-knowledge-store-open.ts`.
- **#2570 AC2 caveat.** `codingContext.test.ts` is one of eight suites that criterion pins as
  unmodified; a later commit added cases to it and sharpened one assertion. The change is additive
  and belongs to the connected-context wiring, but it is not literally byte-identical.

## Wave-3 audit — 2026-07-26

A third pass over the merged epic (all 15 children on `dev`, `bf0451a3`..`3b5fed00`). Target
Outcomes 1–2 and 4–7 and the Wave-2 criteria re-derived as delivered; Outcome 3 confirmed active on
the current tree. Three defects found, each fixed at its owning layer with a failure-first test:

| Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Owning layer                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `.mts` / `.cts` were absent from the code parser's language table while `.mjs` / `.cjs` were present, so TypeScript in those module flavours reached the permissive text adapter: whole-file chunking, no symbol anchor, and the anchor label is a citation section path. Reachable on this repository (`tests/e2e/servers/*.mts`).                                                                                                                      | `parsers/code-parser.ts`                         |
| `repositoryFingerprintSetDigest` sorted with `String.localeCompare`. ICU collation reports 0 for distinct paths (NFC vs NFD, zero-width space, soft hyphen), so the sort is a no-op on such a pair and the digest follows input order — one fingerprint set yields two digests depending on whether it arrived from the walk or from an `ORDER BY` read, and the value shifts with the host's ICU version. The order-independence property was unpinned. | `indexing/repository-fingerprints.ts`            |
| `computeManualCrawlRunFingerprint` carried the same collation defect, reachable when two pages share content across two path spellings. Its order-independence pin existed but used non-colliding fixtures.                                                                                                                                                                                                                                              | `manual-page-fingerprints.ts`                    |
| The comparator that prevents the above had a correct private copy in `connector-item-fingerprints.ts` — with the rule written on it — which the other two digests did not consume. Promoted to one owner so a fourth digest cannot diverge again.                                                                                                                                                                                                        | `fingerprint-diff.ts` `compareFingerprintKeys()` |

Examined and deliberately left unchanged: `parseVectorIndexMode` resolves unrecognised values to
`auto` rather than failing closed. That is a recorded decision with a stated rationale and an
explicit pin (`local-knowledge-store-open.vector-index.test.ts`, "falls through unrecognised values
to the auto default"); the operator opt-out is the single explicit value `disabled`. Changing it
would mean rewriting a pin to bless the opposite behaviour, so it is reported rather than edited.

## Wave-4 final epic audit — 2026-07-27

The complete epic and all fifteen child issues were re-audited after the user rejected the prior
closeout's use of “ANN” for sqlite-vec exhaustive KNN. Historical verdicts above remain intact; this
section is the current verdict.

| Target outcome                                  | Current verdict | Re-derived evidence                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository questions are chunk-precise and warm | **MET**         | Incremental repository fingerprints are computed from bounded raw bytes; incomplete discovery cannot baseline or prune; fresh-pod search is chunk-filtered and ask-time whole-file embedding is deleted.                                                                                                                                            |
| Repository is visibly a pod                     | **MET**         | Repository pod creation, refresh, state, projection and clean-checkout acceptance use the existing Local Knowledge substrate.                                                                                                                                                                                                                       |
| ANN is on — once                                | **MET**         | [ADR-0163](../adr/ADR-0163-one-bounded-in-memory-usearch-hnsw-runtime.md) replaces the false sqlite-vec claim with genuine USearch HNSW above 20,000 rows. The encrypted 20,001-row journey and 50,000×384 comparison run in `check:knowledge-m2-closeout`; the same run recorded recall@10 1.000 and HNSW median 15.054 ms versus exact 54.218 ms. |
| One reranker switch                             | **MET**         | One server facade snapshots gateway config once and serves connected context, workflows and editor coding context; absent/invalid output fails back to the original ordering.                                                                                                                                                                       |
| One verdict                                     | **MET**         | One physical evaluation fold, one contracts-owned metric primitive set, sixteen live regression probes, finite-value enforcement and pinned scorecard comparison.                                                                                                                                                                                   |
| Fusion spine reaches editor coding context      | **MET**         | Neutral retrieval contracts remain additive and their compatibility snapshots stay pinned.                                                                                                                                                                                                                                                          |
| Nothing regresses                               | **MET**         | Targeted package, architecture, retrieval, grounding, portable-runtime and clean-checkout suites are executable; required CI remains the final complete arbiter.                                                                                                                                                                                    |

### Corrective findings and dispositions

| Finding                                                                                                               | Disposition                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sqlite-vec `vec0` performed exhaustive KNN, not ANN.                                                                  | Retired. One bounded USearch HNSW service now owns candidate generation; exact search is reported truthfully below the crossover.                                       |
| The portable product did not carry a qualified ANN runtime.                                                           | Fixed. Five target assets are digest-pinned; staging, SBOM/notices/provenance, signing inventories and real native smoke are wired.                                     |
| Encrypted-store no-spill depended on SQLite TEMP behavior.                                                            | Strengthened. SQLite extensions remain denied; the search-only native interface has no persistence capability and architecture tests reject one.                        |
| Memory was deferred from the common port.                                                                             | Fixed with the tighten-only `candidateIds` allow-list. The vault still owns authorization, decryption and candidate selection.                                          |
| Repository semantic search retained a request-local whole-file embedding/cache fallback.                              | Deleted. Missing, stale, escaped or failed pods produce body-free degradation and leave availability to the existing lexical lane.                                      |
| Pod freshness trusted incomplete scans and text-derived state.                                                        | Fixed at discovery/fingerprint ownership: limit exhaustion is explicit, incomplete runs never baseline/prune, and raw-byte SHA-256/Git-blob identities drive freshness. |
| Evaluation floors admitted non-finite values and some “negative controls” mutated goldsets rather than system output. | Fixed in shared evaluators and live injected-output probes.                                                                                                             |
| Empty-evidence faithfulness scored only the pack and could accept a confident answer.                                 | Fixed: empty evidence is faithful only with the exact deterministic abstention.                                                                                         |
| The native addon needed a worker import forbidden by ADR-0019.                                                        | Resolved by ADR-0019 v1.1 and ADR-0163's exact two-file exception; every other worker/network/process import remains denied.                                            |
| Warm cache correctness depended on every vector writer remembering an invalidation side effect.                       | Fixed in DB schema v32: vector insert/update/delete triggers dirty materialization state for direct writes, cascades, retention and encryption maintenance.             |

Current evidence:

- [USearch runtime and supply chain](usearch-hnsw-evidence.md)
- [Deterministic substrate evidence](knowledge-m2-substrate-evidence.md)
- [ANN latency characterization](knowledge-m2-ann-latency-characterization.md)
- [Clean-checkout acceptance](knowledge-m2-clean-checkout-demo.md)

The former sqlite-vec provisioner and evidence note are deleted. ADR-0152's old activation and
memory-deferral passages and ADR-0153's TEMP mechanism are explicitly historical/superseded by
ADR-0163; their invariants are not relaxed.
