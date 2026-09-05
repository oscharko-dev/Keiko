# #3390 security review — no widening, no merge/close tool

Security review for #3390 acceptance criterion 9's security-review leg: the coding-runtime and
Git-connected Chat surfaces this epic touched grant no new merge, delivery, or issue-close
authority to a model, and the read-only surfaces this epic adds (`git-change` connect/refresh, the
OpenCode model-visible tool catalog) cannot reach one either. The remaining legs of AC9
(accessibility, seven-mode design-system evidence, coding-runtime performance gates) are tracked
separately and are not restated here; see the acceptance-evidence-map row cited below.

## Reviewed claim

A model driving a coding-runtime run, and a Git-connected Chat session, can read and propose —
never merge, close, push to a protected ref, or otherwise widen delivery authority beyond what
ADR-0125/ADR-0135 already gate through a human-approved pull request.

## Evidence

| Surface                                            | Enforcement                                                                                                                                                                                                                                                                                                                                                               | Regression evidence                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode model-visible tool catalog                | `OPENCODE_MODEL_VISIBLE_TOOLS` (`packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts:363-382`) lists 18 tools — status/diff/stage/commit/push/PR-open, questions, workspace read/discover, search, edit, verification, research, skill, child-agent, CI status — and no merge or issue-close tool. A model cannot request a capability that is never offered. | Direct code read of the closed tool list; no dynamic registration path adds to it at runtime.                                                                                                                                                                         |
| `git-change` Chat connect/refresh route group      | `GIT_CHANGE_ROUTE_GROUP` exposes exactly two routes, `POST /api/git-change/connect` and `POST /api/git-change/refresh` — no branch/fetch/pull/push/PR-create/merge/close/checkout/commit route exists on this surface.                                                                                                                                                    | `packages/keiko-server/src/gitChangeRoutes.test.ts:713` — "exposes exactly connect and refresh — no branch/fetch/pull/push/PR-create/merge/close route": asserts `GIT_CHANGE_ROUTE_GROUP` has length 2 and that no route pattern contains any of the forbidden verbs. |
| Git-delivery PR route group (including mark-ready) | The PR route group's patterns are enumerated and structurally checked against the words `merge` and `close`, independent of any single handler's behaviour.                                                                                                                                                                                                               | `packages/keiko-server/src/gitDelivery/prRoutes.test.ts:1691` — "the PR route group (including mark-ready) exposes no merge or issue-close endpoint": asserts every route pattern excludes both words.                                                                |

Both regression tests are pinned, route-table-level assertions (not a schema read or a single
handler's behaviour) — a future PR that adds a merge or issue-close route to either group fails
these tests before it can ship, independent of what any individual route handler does.

## Disposition

**Fixed/covered — no action needed.** The no-widening/no-merge/no-close claim is proven at the
route-table level for both the `git-change` Chat surface and the Git-delivery PR surface, and at
the model-tool-catalog level for the coding-runtime's OpenCode integration. No commit since the
routes and catalog were introduced changes either surface, and both pinned tests were green at the
time of this review.

**Not in scope for this review — tracked separately.** The coding-runtime performance-budget leg of
AC9 remains blocked on open issue #2952 ("Add measured performance gates for coding runtime and
Atlassian"): `scripts/perf-evidence-gate.mjs`'s `selectGateTargets` currently knows only
`workspace`/`editor` gate targets, with no coding-runtime target to reuse #2952's budgets against.
No performance number is asserted here in its place. The seven-mode design-system evidence leg is
not applicable to #3390 itself — #3390 introduces no changed UI surface of its own (see
`docs/design-system/evidence/3390/README.md`); the relevant design-system evidence lives under
#3389's own acceptance row.

See `docs/qa/epic-3384-acceptance-evidence-map.md`, #3390 row 9, for how this review's result is
recorded against the acceptance criterion.
