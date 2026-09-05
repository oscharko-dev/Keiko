# Epic #3384: incomplete implementation handoff

The owner stopped implementation on 2026-09-05 and explicitly requested that all
outstanding work be committed and pushed immediately to the existing PR #3394.
This is an incomplete work-in-progress checkpoint, not a verified epic closeout.
The following inventory supersedes earlier completion implications in the delivery
plan. No child issue or dependency is declared complete by this publication.

## Delivery and consolidation

- All outstanding workspace changes are published together on
  `epic/3384-issue-to-pr`, targeting `dev` through PR #3394.
- Source PR #3419 was consolidated locally in commit `9f13989e`; its architecture,
  raw-coordinate boundary and review repairs are included in this delivery history.
  Later integration changes must be reviewed against the final tree. Source review
  history remains relevant: ten conversations were unresolved at the recorded audit.
- Existing repository search/read is extended; this checkpoint is not evidence that
  every catalog consumer has migrated or that a second subsystem is required.
- The owner's merge of `dev` into the epic branch (`a69af598`) is retained in the
  normal merge history. No force push or direct push to `dev` is authorized.
- Final review and merge remain with the owner. Auto-merge stays disabled.

## Implemented source and remaining work

| Issue / dependency | Work present | Still incomplete |
| --- | --- | --- |
| #3385 | Canonical issue intake, checkout authorization, accepted binding, managed workspace provisioning, UI/recovery, transient initial model context | Re-capture browser evidence after the latest synthetic-context change; real model qualification |
| #3386 | Runtime status/diff/stage, exact-tree verification, one-use commit approval, durable commit results, bounded repository search/read; retained successful commit across subsequent attempts | Final integrated verification and model-visible managed OpenCode search projection |
| #3387 | Exact-SHA governed push, bound draft PR creation/reuse, template seed, persisted intent and uncertain-result reconciliation | Live GitHub/model qualification and final integrated review |
| #3388 | Required/advisory CI facts, exact-revision readiness, bounded failure context, cumulative repair budgets, late-result guards, readiness/repair UI and repeated-commit browser journey | Final integrated checks; one earlier stage-to-verification browser stall remains unexplained despite two later passing serial runs |
| #3397 | Immutable change snapshot producer, bounded transient evidence, metadata parsing and freshness validation | All production consumers and end-to-end qualification |
| #3398 | Shared Model Gateway description generation foundations, evidence binding, marker grammar, deterministic fallback and budgets | Full Chat and terminal lifecycle integration |
| #3399 | Body-only PR description preview/review/apply service, preserved human text, dedicated approval, pre/post-read checks, uncertain-result handling; standalone receipt CAS store | Receipt CAS propagation through the service, production composition, UI preview/apply wiring and overlapping-service integration |
| #3389 | Read-only canonical journey facts, separate readiness/review/merge/issue state contracts and observation service; standalone journey UI | Durable production projection, routes, runtime/UI connection, one-use mark-ready approval/execute/reconciliation and full handoff browser journey |
| #3400 | Shared snapshot/generation/apply foundations only | Git-connected normal Chat journey and production integration |
| #3401 | Shared generation foundations only | Durable deduplicated terminal-success draft generation, authority refresh and repaired-head regeneration |
| #3390 | Focused fixture journeys and evidence foundations | Real OpenCode/model/GitHub journeys, negative manifest qualification, signed platform receipts and final consistency audit |
| #3411 / #3419 | Consolidated architecture/raw-coordinate contract and review repairs in the epic history | Review all inherited unresolved findings on the final integrated tree |
| #3406 / #3412 / #3413 / #3409 | Catalog/projection foundations, operation scanner, authority binder, bounded continuation, body-free logging, native host/harness migration and authority/budget regression repairs | Final catalog/migration artifact refresh; one legacy editor integration failure; complete remaining consumer migration |
| #3407 / #3414 / #3415 | Shared producer and binder foundations | Read-only child/editor/managed OpenCode projection, H1 model availability, complete conformance and performance qualification |
| #2951 | Existing sandbox/egress foundation assessed | Full filesystem containment, real OpenCode session failure, Linux/Windows containment and qualification; no full containment claim |
| #2952 | Measurement/verdict separation and focused tests | Reference-container calibration and derived performance budgets |
| #2198 | Existing signing implementation reused from merged #2261 | Fresh actual signed/notarized platform receipts |

Additional source changes include correlated, body-free activity/support timelines,
SSE terminal-write/backpressure regression repairs, package graph/export wiring,
ADR updates, browser fixtures and CI suite registration. Their final combined
release qualification remains outstanding.

GitHub's PR body API does not provide a documented atomic body/head compare-and-swap.
The implemented read-check-write-verify path cannot rule out an intervening edit
being overwritten within the write window; the preview discloses that limitation.

## Checks actually recorded

These are checkpoint results on the source snapshots tested at the time. They are
not a claim that all tests passed against the final published combined commit.

- Architecture consolidation: 717 focused tests and 560 architecture coverage tests;
  positive/negative architecture, scoped lint/format and ADR checks passed.
- Bounded repository search/read: 432 tests; 97% lines and 94.41% branches;
  architecture, error-observability and three retrieval gates passed.
- Issue initial-context repair: six failing regressions reproduced, then 200 tests
  passed; a later scoped run passed 117 tests.
- Retained successful commit: 127 store/authority tests and 39 guard tests passed.
- Draft delivery: eleven browser cases passed. CI repair: two successive serial
  journey runs passed, including a second verified commit/push on the same PR.
- UI checkpoint: 437 suites, 7,710 passing tests and one existing skip;
  89.98% statements, 82.49% branches, 91.57% functions, 92.86% lines.
- PR description core: 284 tests passed. The latest standalone receipt store passed
  twelve tests; this does not establish complete service CAS integration.
- Journey observation/core: 34 tests passed. Latest adjacent journey UI run:
  177 tests across seven suites passed.
- Native migration checkpoint: 204 tests across thirteen suites passed. An earlier
  broader tools/harness/SDK run had 1,824 passes and one unresolved failure in
  `editor-agent-tool-host.integration.test.ts` (`editor_list_sessions`).
- CLI checkpoint: 52 suites, 1,167 passes and one existing skip. Support analysis
  reconstructed the recorded CI/tool activity. SSE regression checkpoint: 57 passes.
- Immediately before the stop, `git diff --check` and
  `tsc -b packages/keiko-server` passed. These are not full root/UI test typechecking.

## Final checks not performed

The complete combined-head minimum loop, full coverage/release checks, generated
operation/catalog/migration consistency, package-surface smoke, final Sonar,
Linux gate matrix, live model qualification and fresh platform evidence were not
completed before the owner's immediate publication request. Earlier passing
checkpoint checks cannot substitute for them. Do not merge on the basis of this
handoff, dismiss findings, weaken gates or mark the epic complete.

The final new activity operations still require catalog regeneration and validation.
Board updates were unavailable with the existing token's project permissions.
Earlier containment probes were rejected by automatic approval review; no alternate
execution path was used to bypass that rejection. Temporary local logs and manifests
under `/tmp` are diagnostic working material, not durable release receipts.
