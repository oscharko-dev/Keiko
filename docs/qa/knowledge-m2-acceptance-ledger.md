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

## Known gaps carried forward

- **`grounded-retrieval-eval.ts` keeps local `average()` / `ndcgAtK()`** rather than consuming the
  shared `mean` / `binaryNdcgAtK`. The epic's Purpose names this triplication, but no child's scope
  requires resolving it here, and resolving it would mean pointing `keiko-server` at
  `keiko-evaluations` — production code depending on an evaluation harness, which is the wrong
  direction. ADR-0152 D5 placed those helpers in the harness deliberately. Left as-is on purpose.
- **ADR-0152 D3 (namespace composition) is declared, not consumed.** `VectorIndexPort` has no
  importer outside `keiko-contracts`; only `embeddingIdentityKey` is consumed today. Wiring the
  `memory` and `repo` namespaces to a port with no active backend behind it would be ceremony, so
  the ADR records D3 as deferred rather than the code pretending otherwise.
- **#2570 AC2 caveat.** `codingContext.test.ts` is one of eight suites that criterion pins as
  unmodified; a later commit added cases to it and sharpened one assertion. The change is additive
  and belongs to the connected-context wiring, but it is not literally byte-identical.
