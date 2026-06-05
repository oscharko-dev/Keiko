# Enterprise Memory Vault — Verification Matrix

This document is the closure-evidence artifact for Epic
[#204](https://github.com/oscharko-dev/Keiko/issues/204). It maps every
epic-level acceptance criterion to the package, file, and test that
satisfies it, and records the integration evidence that was run before
the epic branch was opened for human review.

## Target outcomes (from epic #204)

| #   | Target outcome                                                                                                                                                           | Where satisfied                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1   | Local Enterprise Memory Vault with typed records, temporal-graph relationships, optional embeddings, provenance, confidence, sensitivity, namespace scopes               | `@oscharko-dev/keiko-memory-vault` (#206) + `@oscharko-dev/keiko-contracts/memory*` (#205)         |
| 2   | Durable memory candidate capture from explicit instructions, accepted workflow corrections, repeated preferences, reviewed reflection outputs                            | `@oscharko-dev/keiko-memory-capture` (#207)                                                        |
| 3   | Consolidate, link, update, supersede, selectively forget without unbounded hidden background activity                                                                    | `@oscharko-dev/keiko-memory-consolidation` (#208) + `@oscharko-dev/keiko-memory-governance` (#209) |
| 4   | Compact memory context block for Conversation Center and workflows with included-memory explanations                                                                     | `@oscharko-dev/keiko-memory-retrieval` (#210)                                                      |
| 5   | Inspect, edit, approve, reject, pin, archive, delete, audit memory through a Memory Center UI                                                                            | Memory Center routes + UI (#211)                                                                   |
| 6   | Conversation Center uses memory before PWA work, without implementing memory logic inside chat UI                                                                        | Conv Center BFF routes (#212)                                                                      |
| 7   | Verification matrix tests accurate retrieval, long-range understanding, test-time learning, selective forgetting, stale-memory, blocked-memory suppression, cross-scope isolation, and error propagation | `tests/memory-eval/` (#215) + this document                                                        |

## Architecture invariants

| Invariant                                                                                      | Enforcement                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing architecture, quality gates, security, evidence, deterministic verification preserved | ADR-0019 direction rules `3f`–`3j` at `error` severity; `arch:check:negative` pins `EXPECTED_RULES=18`                                                                                          |
| Productive model calls behind the Model Gateway                                                | Memory packages do not import `keiko-model-gateway` directly; consolidation `summaryGenerator` is a port (no default wiring); see `packages/keiko-memory-consolidation/src/types.ts`            |
| Workflow authority explicit                                                                    | `MemoryWorkflowPort` is optional on workflow factory options (#213); memory does not grant write or execution authority                                                                         |
| Memory local to user runtime state                                                             | SQLite file at `KEIKO_MEMORY_DIR/keiko-memory.db`; documented in [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md) §category 9                                          |
| Memory scoped by namespace                                                                     | `MemoryScope` discriminated union (user/workspace/project/workflow/global); two-column SQL filter (`scope_kind`, `scope_coordinate`) in `packages/keiko-memory-vault/src/memories.ts`           |
| Memory provenance with source / timestamp / model / confidence / sensitivity / validity        | `MemoryProvenance` in `packages/keiko-contracts/src/memory-records.ts`                                                                                                                          |
| Memory writes through policy gate, inspectable before/after acceptance                         | Capture (#207) → governance (#209) → vault (#206) with revalidation at every boundary                                                                                                           |
| Memory retrieval bounded, explainable, visible                                                 | `retrieveMemoryContext` returns `included` + `omitted` with typed reasons (#210); Conv Center BFF (#212) and Memory Center UI (#211) expose to user                                             |
| Memory supports update, correction, supersession, deletion, selective forgetting               | `keiko-memory-governance` (#209): `buildCorrection`, `buildConflictTransitions`, `selectMemoriesForForget`, `buildForgetOperations`, `buildPin/Unpin/ArchiveOperation`, `buildExpirationUpdate` |
| No silent cross-trust-boundary leakage                                                         | Scope isolation enforced at SQL level (vault), at retrieval port (`isScopeReachable`), and at governance selection (`protectPinned` default)                                                    |
| Audit evidence excludes secrets / customer content                                             | Persist-time `redactString` in `createMemoryAuditHandler` (#214); body-free `exportMemoryDiagnostics`                                                                                           |

## Eval scorecard

The deterministic evaluation scorecard schema is defined in
[`tests/memory-eval/scorecard.ts`](../tests/memory-eval/scorecard.ts), and the
eval runner (`tests/memory-eval/eval-runner.test.ts`) can emit a local
`tests/memory-eval/scorecard.json` artifact when
`KEIKO_WRITE_MEMORY_EVAL_SCORECARD=1` is set for PR evidence generation. The
runner records pass/fail for each synthetic-fixture scenario during every test
run, and JSON artifact emission remains opt-in.

| Scenario                   | AC covered                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| `accurate-retrieval`       | Top-1 retrieval matches the queried preference                                   |
| `long-range-understanding` | Graph-proximity subscore lifts linked memories                                   |
| `test-time-learning`       | Captured during run, retrievable next                                            |
| `correction-handling`      | Newer correction outranks older fact                                             |
| `selective-forgetting`     | `selectMemoriesForForget` removes targeted memories from retrieval               |
| `cross-scope-isolation`    | Request scope `A` never includes memories from scope `B`                         |
| `no-memory-mode`           | `maxIncluded=0` / `budgetTokens=0` yields empty context block                    |
| `error-propagation`        | Vault validator + retrieval port wrap invalid input as typed errors, not crashes |
| `suppressed-memory`        | Low-confidence, expired, rejected, and conflicted memories are omitted           |

Determinism is asserted on every test run by executing the scorecard twice and
comparing byte-equal JSON output.

## Integration evidence

Each child PR ran cold-cache 8/8 from repo root before merge into the
epic branch (`typecheck` + `lint --max-warnings=0` + `arch:check` +
`arch:check:negative` with `EXPECTED_RULES=18` + `test` + `build`). The
final epic PR re-runs the same suite from the epic branch HEAD so the
integration evidence is the latest test count, file count, and module
count on the merged tree.

| Child issue                                              | PR                                                     | Squashed commit | Tests added                       |
| -------------------------------------------------------- | ------------------------------------------------------ | --------------- | --------------------------------- |
| [#205](https://github.com/oscharko-dev/Keiko/issues/205) | [#321](https://github.com/oscharko-dev/Keiko/pull/321) | `58e784db`      | 105                               |
| [#206](https://github.com/oscharko-dev/Keiko/issues/206) | [#322](https://github.com/oscharko-dev/Keiko/pull/322) | `382a2212`      | 86                                |
| [#207](https://github.com/oscharko-dev/Keiko/issues/207) | [#324](https://github.com/oscharko-dev/Keiko/pull/324) | `5a63a17f`      | 91                                |
| [#208](https://github.com/oscharko-dev/Keiko/issues/208) | [#325](https://github.com/oscharko-dev/Keiko/pull/325) | `cade35d4`      | 106                               |
| [#209](https://github.com/oscharko-dev/Keiko/issues/209) | [#326](https://github.com/oscharko-dev/Keiko/pull/326) | `a92e5133`      | 83                                |
| [#210](https://github.com/oscharko-dev/Keiko/issues/210) | [#327](https://github.com/oscharko-dev/Keiko/pull/327) | `41a77770`      | 74                                |
| [#211](https://github.com/oscharko-dev/Keiko/issues/211) | [#328](https://github.com/oscharko-dev/Keiko/pull/328) | `26805b4f`      | 33 (UI) + 12 (BFF)                |
| [#212](https://github.com/oscharko-dev/Keiko/issues/212) | [#333](https://github.com/oscharko-dev/Keiko/pull/333) | `55e5d81b`      | 11 (BFF)                          |
| [#213](https://github.com/oscharko-dev/Keiko/issues/213) | [#335](https://github.com/oscharko-dev/Keiko/pull/335) | `13781487`      | (workflow ports)                  |
| [#214](https://github.com/oscharko-dev/Keiko/issues/214) | [#338](https://github.com/oscharko-dev/Keiko/pull/338) | `410d45db`      | (audit + retention + diagnostics) |
| [#215](https://github.com/oscharko-dev/Keiko/issues/215) | [#340](https://github.com/oscharko-dev/Keiko/pull/340) | `8481784f`      | 17 (eval scenarios + runner)      |

Memory test totals at epic-branch HEAD: 3,861 tests + 1 skipped across 278 test files.

## Additional closure notes

The following notes clarify how Issue #216 closure evidence maps to the current
`dev` integration and release surfaces:

- **Fresh packed-artifact install verification** — the root `scripts/installable-package-smoke.mjs` remains the generic tarball-install gate, and `scripts/installable-memory-smoke.mjs` adds the memory-specific packaged-artifact flow (shipped UI/BFF start, page fetch, create/use/correct/forget/delete, scope isolation, restart persistence). `.github/workflows/ci.yml` runs both `npm run smoke:install` and `npm run smoke:install:memory` for pushes to `dev` and pull requests targeting `dev`.
- **Package-surface verification** — `scripts/check-package-surface.mjs` remains part of the root release chain (`prepack` / `prepublishOnly`), and `.github/workflows/ci.yml` also runs `npm run check:package-surface` on pull requests targeting `dev`.
- **Final regression evidence artifact** — the deterministic eval runner executes on every `npm test` run; writing `tests/memory-eval/scorecard.json` is optional and enabled only when `KEIKO_WRITE_MEMORY_EVAL_SCORECARD=1` is set.
- **Conversation Center memory toggle UI affordance** — the current Conversation Center UI already ships a memory enable/disable toggle and budget control in `packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx`, alongside the BFF routes from #212.

## Closure request

Once the final epic PR is merged into `dev` and the consumer-facing
artifact is republished, the human maintainer or Codex should close
issues #205–#216 (auto-closure via the epic PR's `Closes #` trailers).
