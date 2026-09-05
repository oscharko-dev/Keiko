# Epic 3384 implementation and qualification plan

**Stopped on owner request, 2026-09-05:** all outstanding work is being published
as an incomplete checkpoint in PR #3394. The
[work-in-progress handoff](epic-3384-work-in-progress-handoff.md) records implemented
source, unfinished work and actual checkpoint checks. It supersedes completion
implications below; final combined-head qualification was not completed.

Audit baseline: PR #3394, `epic/3384-issue-to-pr`, commit
`30fb85b54f863e86585d5db27a6ba2e6e4e660c6` (2026-09-04). The three latest commits
contain incomplete takeover checkpoints. The earlier PR description is not a complete inventory
of that tree. This document records work in progress, not release qualification.

## Accepted scope

The repository owner requested completion of the epic and, on 2026-09-04, explicitly included open
dependencies in other epics where required for correct operation or the specified qualification.
Dependency implementation is part of this delivery, not a deferred workaround. External signing
identities, protected secrets, approved live-model inputs and platform receipts must still be real;
their absence cannot be converted to passing evidence.

Preserve the current integration branch and settled review repairs. Use one accountable integrator
and disjoint agent write scopes. Keep the existing PR. The recorded epic-specific owner review and
merge checkpoint remains in effect; this work does not arm final-PR auto-merge.

The owner clarified the delivery decision: all required dependencies ship in the existing PR
#3394. The separate #3411 PR #3419 is superseded after its reviewed source is preserved in the
integration branch. Separate prerequisite dev PRs and H1 dev merges are removed. Keep producer
implementation and independent review in dependency order within this one integration tree;
run final GitHub checks and review against the complete current PR head. Internal checkpoints
do not require separate external review or merge cycles.

## Audit and dependency order

| Child | Verified baseline                                                                                                   | Remaining implementation                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3385 | Checkout grant, parser, preview/resolver scaffolding, schema 22, default-branch reader, incomplete UI/runtime tests | Mounted preview, accepted-preview binding, existing workspace provisioning, initial model context, recovery, accessible UI and production journey |
| #3397 | Snapshot contract and generalized patch parser                                                                      | Hardened immutable producer, NUL metadata, transient scoped access, freshness, boundedness and production tests                                   |
| #3386 | Effective-mode correction and Git authority regression pins                                                         | Actual runtime Git/commit bridge, exact-tree verification, one-use approval, durable verified result, complete mode matrix, H1 search handler     |
| #3398 | Existing general Model Gateway only                                                                                 | Shared marker grammar, evidence-bound narrative, local validation, deterministic fallback, trusted rendering and budgets                          |
| #3387 | Existing manual push and PR primitives                                                                              | Exact-SHA push, issue-bound draft creation, template seed, approval and restart reconciliation                                                    |
| #3388 | Existing merge-fact reader with visibility/completeness gaps                                                        | Required-check discovery, exact-revision readiness, transient failure context, model-driven repair and cumulative budgets                         |
| #3399 | Generic PR update only                                                                                              | Body-only command, preserved human text, revision/body approval, reconciliation and scoped non-run authority                                      |
| #3400 | Existing Chat and relationship engine                                                                               | Explicit Git-change scope, normal-history refinement, stale refresh and shared apply adapter                                                      |
| #3401 | Existing terminal lifecycle only                                                                                    | Durable deduplicated successful-run draft generation, fresh authority and repaired-head regeneration                                              |
| #3389 | Existing PR card only                                                                                               | Separate mark-ready approval, independent readiness/description/review/merge/issue facts and restart projection                                   |
| #3390 | Existing acceptance-evidence infrastructure only                                                                    | Both real UI/OpenCode/model journeys, negative manifest validation, platform receipts and final consistency audit                                 |

Execution order is #3385/#3397; then #3386/#3398; #3387; #3388/#3399;
#3400/#3401; #3389; #3390. Shared files have one owner per wave. Every consumer uses the
producer's types, digests and stale/failure vocabulary rather than recomputing them.

## Cross-epic work included by the owner

| Dependency                                    | Why required                                                            | Delivery constraint                                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3411                                         | Canonical governed-tool architecture and raw search-coordinate contract | Freeze ownership and checked contracts before H1                                                                                                                      |
| #3386 H1                                      | Real bounded repository-search/read handler                             | Verified internal producer checkpoint after #3411, within PR #3394                                                                                                    |
| #3414 and its canonical-catalog prerequisites | Model-visible search and generated OpenCode tool projection             | Consume H1's verified source identity in the same PR; no duplicate projection or absent backend                                                                       |
| #2951                                         | Attested sidecar containment                                            | Enforce gateway-only egress through existing sandbox owners and prove hostile-socket negatives                                                                        |
| #2952, coding-runtime portion                 | Measured startup/readiness/streaming/output budgets                     | Extend existing measurement framework; derive budgets from reference samples                                                                                          |
| #2198, required release-signing children      | Required signed portable installation receipts                          | Existing implementation merged through #2261 at `e51e2c1b836408f64772a041bf0a44cd8895bb5b`; reuse and qualify the existing pipeline with real signatures/notarization |

These issues were open at audit time. Their open state alone does not prove absent implementation;
each needs the same code-to-acceptance audit before edits. Unrelated functionality in those epics
is not silently absorbed. Scope, decisions, changes and verification must be reflected in the
Epic #3384 body and PR #3394 body as delivery advances.

## Dependency consolidation checkpoint

The architecture and review repairs from source PR #3419 are retained in local signed commit
`9f13989e0be0138ab7ece5a7c98b1dc75090a950` on the existing epic branch, with Git tree
`98e95f8a040a09fb821ab7b76abab8450c399662`. Source PR head was
`2f556ba8df56a058cb30bfa92fb9deed0a9390f2`, including signed repair head
`5b78a42902f093c989c47ec6e3dfe88bb056e00c`. The 21-file consolidation preserves architecture,
raw-coordinate security gates and review fixes, amends the delivery route, and pins the already
completed #2958 authority migration without restoring retired policy scaffolding.

Applicable checks passed: 717 targeted tests; 560 architecture coverage tests; scoped lint and
format; ADR index; architecture positive/negative gates. The root integrator reviewed the new
checkpoint identity fields, producer/consumer ordering and migration assertions. This local
checkpoint does not claim current integrated Sonar, final GitHub checks, runtime catalog
availability or release qualification. PR #3419 has ten unresolved review conversations at the
recorded readback (nine Codex, one CodeRabbit); consolidation is not review acceptance. Keep the
source PR and its review history available, and close it as superseded only after its source is
published in PR #3394. No prerequisite is closed before final verified integration.

## Repository search/read checkpoint

The independently reviewed H1 producer is retained in signed local commit
`93a328952b5507fd63cd7c542ec730f0b1828b6d`, tree
`e38ad4319dac9a8e06b4502ed869854b9a75a715`, on the same epic branch. Its 17 files extend
existing workspace discovery, matching, raw-coordinate redaction and server logging owners.
The 432 affected tests pass, with 97% scoped lines and 94.41% branches; architecture,
error-observability and all three retrieval gates pass. Independent review found and fixed
simultaneous result/file truncation reporting and mutable request drift across an asynchronous
read; both regressions failed before their fixes. The actual built handler emits correlated
body-free activity that the support analyzer reconstructs. Model-visible catalog projection
remains a subsequent integration step.

## In-progress commit and draft-delivery integration

The production-composed browser fixture passes all six issue-to-commit cases across the three
modes, including actual stage, verification and commit approvals, denial, drift, reload and
replay refusal. The fixture invokes the generated trusted tool shim and production approval
manager; it does not mint claims or derive authority digests. Eight visual modes pass accessibility
and overflow checks. Latest UI coverage passed 7,619 tests with one existing skip. Evidence is in
`docs/design-system/evidence/3386/`. This is deterministic composition evidence, not live-model
qualification; later raw-read and stage repairs still require final current-tree verification.

Draft-delivery primitives now include immutable-SHA push, canonical bounded GitHub reads and
create identity, safe repository-template seeding with a single trusted issue closing reference,
and a schema-24 durable record with independent revision checks. A real bare-remote regression
proves a moved local branch cannot replace the approved push SHA. Template and shared closing
reference checks pass 89 tests. PR transport, lifecycle, existing route and evidence tests pass
129 cases; their negative pin also prevents complete remote identities entering lifecycle
evidence. Runtime approval/service composition, restart reconciliation and the full publish
browser journey are still in progress. These primitives are not a completed #3387 claim.

Client diagnostics retain their originating operation correlation when valid and otherwise use
the validated ingest correlation. Five regressions failed before repair; all 15 route tests now
pass. The browser's emitted diagnostic was independently reconstructed by `keiko support analyze`.

## Current local evidence

The checkout uses verified Node 24.18.0 and npm 11.16.0, matching the repository pins. Dependencies
were installed with `npm ci`; the pinned USearch prerequisite was provisioned.

- Initial package build failed on inherited snapshot typing; this was recorded before repairs.
- Initial runtime-orchestrator test run: 21 failed, 67 passed. Issue intent could silently become
  a generic run because the admitted wire field had no runtime consumer.
- After issue admission, context and recovery wiring: all 88 runtime-orchestrator tests passed.
- Targeted parser, runtime contracts, orchestrator, snapshot-store, SQLite migration and default-base
  reader suites: 266 tests passed across six files.
- Initial committed intake UI suite: 21 failures because production intake was absent.
- The composed browser journey now passes preview, refusal, existing workspace provisioning,
  issue-bound Start, initial context-dependent managed edit, reload and Stop. Seven canonical display
  modes plus a 360px viewport pass accessibility, overflow and toolbar-overlap assertions. The
  supervisor and upstream model are deterministic fixtures; this is not live-model qualification.
- Final intake UI coverage: 434 suites, 7,586 passing tests and one pre-existing skipped test;
  92.83% lines and 82.44% branches. Evidence is under `docs/design-system/evidence/3385/`.
- Two request-lifecycle regressions failed before the preview adopted the existing shared
  cancellation owner: response close after body completion did not abort the resolver, and completed
  requests retained an abort listener. All 14 preview/cancellation tests now pass.
- The broad intermediate run recorded 35,898 passing tests and 11 failing files. Targeted repairs
  address generated inventories, runtime bindings, observation wiring and the local trusted-host
  executable prerequisite. A stable whole-matrix rerun remains required.

The immutable foundation verification tree passed full typecheck, root/UI lint, format,
architecture positive/negative, local Sonar and package/UI/script coverage gates. Its package lane
passed 36,160 tests (49 existing skips); all 25 package floors, all 68 governed file floors and
both release coverage targets passed. New-code coverage was 88.1% against the 85% floor. This is
foundation evidence, not evidence for later runtime, catalog, sandbox or performance edits.
The complete integrated tree still requires final validation, composed production journeys and
live/platform qualification. No child is closed and no release-readiness claim follows.

## Completion evidence

Current integration adds the #3406 pure canonical catalog: an independently reviewed 30-file
manifest (`7caa7af489a04b5853003fbd076077349818597f8e99be373a1da995deb95da7`) and 162 passing
focused tests. The common architecture gate now runs its conformance and negative checks. This
preserves the six legacy projections and does not advertise H1 or qualify the future dispatcher.

The #3387 store now supports bounded predecessor adoption without restoring approval, and retains
referenced verification receipts against pruning; 70 store/snapshot/projection tests pass. The
production factory rechecks the original checkout grant, frozen issue and active managed workspace;
92 factory/resolver/route tests pass. Immutable push execution isolates Git configuration from live
origin/push-URL rewrites: four regressions fail on the previous path and pass with the approved URL
and exact SHA; the integrated HTTPS helper, transport and metadata suites pass 74 tests. The standard
gh credential helper is host-scoped after a reset and uses the existing trusted executable owner;
only Git/gh exchange synthetic credential bytes in the hermetic protocol test. The composed draft
journey remains active work, and these results do not claim live authentication or release readiness.

The first #3388 owner repair prevents opaque protection 404 and failed review reads from creating
false readiness. Five regressions fail before the repair; 148 affected merge/preflight/route tests
pass afterwards. A separate failing-before logging pin and the 24 route tests verify correlated,
body-free readiness observations and structured thrown errors. Rulesets, explicit pagination/completeness, the closed observation vocabulary,
bounded model failure context and cumulative repair budgets remain open.

Record each acceptance criterion against named production-path tests and actual run outputs.
Refresh generated operation catalog, affected ADR sections, release impact and package surfaces.
Run the applicable AGENTS.md minimum loop and touched-area gates locally before delivery. Preserve
strict negative coverage for stale authority, revision drift, unknown protection, replay, unsafe
content, output limits and cancellation. The final audit must distinguish source implementation,
deterministic verification, live model/GitHub qualification and signed platform evidence.

The independent #3387 review found that keeping the temporary Git configuration inside writable
repository metadata did not isolate it from that scope. Effect metadata now uses the existing
executor-owned ephemeral-directory facility outside the checkout and original Git directory;
non-overlap, exact content and directory identity are checked before dispatch. Two failing-before
workspace tests pass after the repair; 26 focused workspace/Node transport tests pass on the updated
source. This does not claim protection against arbitrary same-user host processes: the #2951
containment qualification remains open. A separate review found loss of the original successful
commit receipt after a later failed proposal; the original successful receipt is now retained internally and atomically with the draft. The
independent source review and 60 focused recovery/store tests passed; the implementation also
passed 191 affected controller, store, schema and boundary tests.

The #3412 independent source review and 32 focused tests passed. Synthetic lifecycle declarations
remain distinct from real source emission. #3413 runtime binding and lifecycle emission are now being
implemented using the existing authority and invocation-registry owners.

The #3388 shared provider-observation vocabulary distinguishes local admission, actual provider
403/404, rate limits, cancellation and incomplete visibility. Explicit finite page/byte reads now
have 19 focused tests, including changing total counts, cap exhaustion, captured bounds and an abort
during the final read. These are read primitives; complete requirements discovery, model-driven repair,
persisted cumulative budgets and browser qualification remain open.

## Qualification inputs (#3390)

#3390's own deterministic pieces are landed: the `CodeTaskQualificationManifestV1` schema
extension (`packages/keiko-contracts/src/code-task-acceptance.ts`), the
`check:coding-issue-journey-evidence` machine validator and its nine fixtures
(`scripts/check-coding-issue-journey-evidence.mjs`, `scripts/lib/coding-issue-journey-evidence.mjs`),
and the `test:e2e:coding-issue-journey:live` real-model harness skeleton (a Playwright spec,
config and server that compose the real `keiko ui` production factory and fail closed when
unconfigured, never the scripted resolver in `tests/e2e/servers/coding-runtime-server-shared.mts`).

Four qualification inputs remain external and blocked in every environment this epic's agents run
in, never faked green: an operator-authorized controlled-repository checkout with a real seeded
issue; an approved real-model/LiteLLM profile with a bounded spend budget; the signed platform
artifacts tracked by the still-open #2951 (sidecar egress attestation), #2952 (coding-runtime
performance budgets) and #2198 (signed/notarized macOS reference installation); and the
`keiko-issue-audit` reviewer reference, which runs outside this repository entirely. Full detail,
including which manifest rows are `blocked` on which issue, is in
[`docs/design-system/evidence/3390/README.md`](../design-system/evidence/3390/README.md).
