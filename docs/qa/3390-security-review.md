# #3390 security review — no widening, no merge/close tool

Security review for #3390 acceptance criterion 9's security-review leg: the coding-runtime and
Git-connected Chat surfaces this epic touched grant no new merge, delivery, or issue-close
authority to a model, and the read-only surfaces this epic adds (`git-change` connect/refresh, the
OpenCode model-visible tool catalog) cannot reach one either. The remaining legs of AC9
(accessibility, seven-mode design-system evidence, coding-runtime performance gates) are tracked
separately and are not restated here; see the acceptance-evidence-map row cited below.

## Reviewed claim

A coding-runtime model may read, edit, verify and execute the delivery actions permitted by the
accepted autonomy mode and validated Authority Envelope. It cannot merge, close an issue, push to
a protected ref or widen that authority. Git-connected Chat has its separate bounded description
draft/refine/preview/apply surface. The governed merge gateway remains an explicit approval-bound
surface; neither model surface acquires a merge tool. These distinctions follow ADR-0125,
ADR-0135 and ADR-0138 and preserve Full access execution without an invented per-action approval.

## Evidence

| Surface                                            | Enforcement                                                                                                                                                                                                                                                              | Regression evidence                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode model-visible tool catalog                | `OPENCODE_MODEL_VISIBLE_TOOLS` in `packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts` owns the closed model-visible inventory, including the separate `keiko_git_execute` redemption tool and native `todowrite`. It exposes no merge or issue-close tool. | The schema and generated-tool contract tests account for the production catalog and native extensions; the scripted transcript tests exercise actual proposal, approval when required, and execution.                                        |
| `git-change` Chat connect/refresh route group      | `GIT_CHANGE_ROUTE_GROUP` exposes exactly two routes, `POST /api/git-change/connect` and `POST /api/git-change/refresh` — no branch/fetch/pull/push/PR-create/merge/close/checkout/commit route exists on this surface.                                                   | `packages/keiko-server/src/gitChangeRoutes.test.ts` — "exposes exactly connect and refresh — no branch/fetch/pull/push/PR-create/merge/close route": asserts the exact two routes and excludes forbidden verbs.                              |
| Git-delivery PR route group (including mark-ready) | The PR route factory's patterns are enumerated and structurally checked against the words `merge` and `close`, independent of any single handler's behaviour.                                                                                                            | `packages/keiko-server/src/gitDelivery/prRoutes.test.ts` — "the PR route group (including mark-ready) exposes no merge or issue-close endpoint": checks the fresh factory result, preserving cold-import safety and the forbidden-route pin. |

Both regression tests are pinned, route-table-level assertions (not a schema read or a single
handler's behaviour) — a future PR that adds a merge or issue-close route to either group fails
these tests before it can ship, independent of what any individual route handler does.

## Disposition

**Verified source scope, 2026-09-06.** The no-widening/no-merge/no-close claim is covered at the
route-table level for both the `git-change` Chat surface and the Git-delivery PR surface, and at
the model-tool-catalog level for the coding-runtime's OpenCode integration. The complete server
suite on `b844b2722cc57455b08685c3c30cb69a3f8cab1e` passed 13,699 tests, including these route and
catalog pins, on pinned Node 24. The subsequent `5be376e6` checkpoint changes UI layout and test
scheduling, not these production authority surfaces. Its targeted coverage run passed all 19
transcript/fixture tests while retaining the real approval and execution assertions. This source
review does not qualify the still-pending five live flows or replace final merge-head checks.

**Not in scope for this review — tracked separately.** The coding-runtime performance-budget leg of
AC9 is implemented by `scripts/coding-runtime-performance-producer.mjs` and judged by
`scripts/coding-runtime-performance-gate.mjs`. The native Node 24 calibration/candidate pair on
`b844b272` passed; its generated files were committed in `2cf592aa`. The owning source-freshness
gate determines whether those measurements still qualify later source changes. Only #2952's
Atlassian scope is excluded by the operator; coding-runtime performance remains required. The
seven-mode design-system evidence leg is
not applicable to #3390 itself — #3390 introduces no changed UI surface of its own (see
`docs/design-system/evidence/3390/README.md`); the relevant design-system evidence lives under
#3389's own acceptance row.

See `docs/qa/epic-3384-acceptance-evidence-map.md`, #3390 row 9, for how this review's result is
recorded against the acceptance criterion.
