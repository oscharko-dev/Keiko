# Epic #3384: prequalification checkpoint — September 7, 2026

Work resumed on September 7 from the clean September 6 preservation checkpoint. This remains a
historical prequalification record, not epic completion, merge readiness, or issue-closeout
evidence. At this checkpoint PR #3394 is open, native auto-merge is not armed, and the controlled
repository matrix is 0/5. Later results belong to the canonical #3390 per-flow artifacts and
manifest, exact-head PR checks and postmerge H1 provenance. This document stays frozen with the
qualification source; its checkpoint counts are not rolling completion claims.

The earlier handoff records remain available in this file's Git history. They are historical;
especially their attempt numbers, USD 100 allowance and active-automation statements must not be
used as the current operating state.

## Accepted objective and authority

Complete Epic #3384 and the applicable issues referenced by PR #3394, including mandatory #3408.
The criterion-level inventory is [the acceptance map](epic-3384-acceptance-evidence-map.md).
The operator permits normal feature-branch commits/pushes, review replies, validated fixes,
protected integration into `dev`, actual `dev` verification, fulfilled-issue closure, and deletion
of the merged working branch. Those delivery actions remain pending. Never force-push, push
straight to `dev`, bypass checks, or resolve a finding merely to obtain green status.

The controlled real-model repository is `oscharko/Wegwerf-Repo`. Five complete flows are required:
issues #1/#3/#4/#5/#6 in Ask/Supervised/Full/Supervised/Full order. At least one must observe an
actual required-CI failure and a model-authored repair on a different, passing head. Signing and
notarization on all platforms and unrelated Atlassian work are excluded. Runtime confinement
remains required. The existing durable model ledger enforces one aggregate USD 50 ceiling;
retain all attempts and reservations. Its admission charges are not provider invoices.

## Current implementation and executed verification

The earlier cold ESM import hazard, issue intake, governed Git delivery, CI continuation,
description handling and runtime recovery have received extensive repairs. This checkpoint adds
a fix for a newly observed process crash after workspace revocation: catalog settlement used the
live authority context as a clock, then threw again while handling an already-denied operation.
Settlement now advances an anchored monotonic clock independently of that context. The fallback
invocation registry anchors lazily, preserving construction order and authority checks at effects.
Failure, cancellation, deadline and deferred-context regressions preserve body-free lifecycle
logging. The operation catalog is regenerated from its producer.

The subsequent real attempt 33 exposed two more delivery defects. Typed GitHub metadata now uses
the existing credential-only scrub without corrupting branch names or SHAs that also occur in
ordinary environment values; every altered machine response is rejected before parsing. A fresh
operator start retains a bounded proven predecessor or one unique acknowledged local draft when
an older run lost that edge. Existing PR identity, fresh authority and durable verified source are
required; no historical row or approval is rewritten. Provider description requests project the
supported strict schema while preserving all full local validation. The combined source is
`68732ec6`; its adapter, orchestrator and description targets passed 128, 129 and 112 tests.

Actual results, with their source limits:

| Verification                               | Result                                             | Source / limitation                                                                       |
| ------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Full package coverage                      | 1,981 files; 40,468 tests passed; 51 tests skipped | Exact clean `f8088db2`; before the final clock repair                                     |
| Full UI coverage                           | 447 files; 8,028 tests passed; one skipped         | `44cf0537`; UI source unchanged afterward                                                 |
| Script coverage                            | 207 files; 5,234 tests passed; 26 skipped          | `b844b272`; covered script source unchanged afterward                                     |
| Full server suite on Node 24               | 713 files; 13,699 tests passed                     | `b844b272`; before the final clock repair                                                 |
| Full server suite after delivery repairs   | 713 files passed; 13,712 tests passed; 16 skipped  | Product bytes at `68732ec6`; later fixture changes only correct omitted optional fields   |
| Cold route entry imports on Node 24        | 12 passed                                          | `b844b272`                                                                                |
| Final clock repair regression target       | 70 tests passed                                    | Both affected bridge/authority suites; ESLint, Prettier and server TypeScript also passed |
| Browser publication                        | All 12 cases passed                                | Actual `5be376e6` producer output retained; source hashes verified                        |
| Browser CI and Git-connected Chat fixtures | 2 and 4 cases passed                               | `5be376e6`; deterministic fixtures, not real-model qualification                          |
| Final intake and affected visual captures  | Four selected targets passed                       | `f8088db2`; actual redirected producer artifacts archived and verified                    |

The complete six-case commit-browser rerun was repeated after the workspace-revocation repair at
exact source `344e835a`. All six cases passed, including Ask, Supervised and Full approval
semantics, staged-drift refusal and explicit denial. The tracked
`docs/design-system/evidence/3386/journey-proof.json` records this as
production-composed deterministic browser evidence with `modelQualification: false`; it does not
replace a real-model flow.

The #2952 native calibration/candidate pair was regenerated at exact source `344e835a` after the
earlier repair. The native pair used pinned Node 24.18.0, completed two warmups and 30
measured samples per arm, and passed its owning performance gate. The H1 verification passed three
production-managed files / 83 tests; independent review accepted all ten criteria and bound the
661-path owned-source closure at the refreshed `68732ec6` source. These are exact-source
prequalification facts. H1 explicitly does
not establish packaged real-runtime, live-provider or final merge-head qualification, and either
receipt must be regenerated if its owned source changes.

The tracked visual receipts for #3385, #3386, #3388, #3389, #3400 and #3401 were rechecked on
September 7. All 47 recorded source hashes match the checkout: 5/5, 8/8, 11/11, 8/8, 8/8 and 7/7
respectively. The #3385/#3386 captures were produced at `f8088db2`; the other retained captures
remain source-valid because their recorded owners are byte-identical. They are deterministic
browser evidence, not live-model or final frozen-source qualification.

The September 6 checkpoint also passed full root TypeScript checking, the generated operation
catalog check, and the local Sonar analyzer. On the September 7 resume audit, exact PR head
`344e835a` had no unresolved review threads but required CI was red: deterministic OpenCode startup
timing, scripted CI-repair budget expectations and a UI debugging fixture failed. The coverage
aggregate therefore stopped before producing the required SonarCloud context. These concrete
failures were repaired in `6a141383`, `14815a85` and `3a6e9b70`; current-head full checks still
must complete. The refreshed browser, H1 and native evidence does not override required checks.
After the `68732ec6` delivery repairs and test-fixture typing correction, full root typecheck,
architecture and negative architecture checks, operation-catalog validation, error-observability
validation and local Sonar passed. The full server suite also passed all 12 cold route import
cases; no `server.js` or `routes.js` warm-up import was required.

## Real-model delivery: 0/5 completed

[Wegwerf-Repo PR #7](https://github.com/oscharko/Wegwerf-Repo/pull/7) is an actual draft for
[issue #1](https://github.com/oscharko/Wegwerf-Repo/issues/1), with verified commit
`aec3a459ea09f2efb939c21f3b35395e91b811c9`, an actual push and previously passing required `ci`
on that head. It has not been merged and the issue is open. Independent review found opposite-sign
maximum-value overflow in its average implementation; that model-authored repair is still required.

Attempt 32 failed before editing because recovered PR/CI binding admission was unavailable.
Attempt 33 at `14815a85` ran the real model, observed failing regressions, repaired and verified
the selected candidate, and committed `4b7a1b1a4b7f206a270c0e9af5b08d0e22c97b97` locally. It then
failed delivery before pushing; PR7 still points to the earlier `aec3a459` head. The metadata and
lineage defects above explain that failure. Independent review of the retained model commit found
that `[1, 1, -1]` and `[MAX, MAX, -MAX]` incorrectly average to zero and `[MAX, -MAX/2]` overflows.
The next continuation is attempt 34, using that exact retained worktree through normal start and
the locally proven PR lineage after source and required prequalification inputs are frozen.
Do not recreate the workspace, discard its Git history, manually author the fixture repair, or
claim a completed run from the runtime's terminal status alone.

## Active sequence

1. Complete the remaining full checks after the corrected regression targets. Verify
   local/remote PR heads, review comments and required checks before freezing; do not treat a
   missing SonarCloud context as a pass.
2. Verify that the six-case #3386 journey receipt, all tracked visual source hashes, current H1
   checkpoint and #2952 pair still bind the chosen source. Rerun only an owning producer whose
   source closure changed. Never substitute an older checkout's artifact or restamp a prior run.
3. Complete any remaining non-#3390 source/evidence corrections, then freeze one clean source F for
   all five flows. A later landing descendant may contain only the validator's allowed
   qualification artifacts; never broaden that allowlist to conceal source drift.
4. Start the prepared real attempt 34 at F and follow the activity log first. Observe real failing
   regressions, model repair, passing verification, actual governed delivery and independent
   exact-head rubric review. Drive description application, ready intent, explicit governed merge
   and actual issue closure through Keiko. Then complete the other four issues from each actual
   merged base. Preserve the shared ledger and per-flow receipts.
5. Before accepting flow 2, the prepared legitimate median CI fixture may be introduced through
   a normally checked fixture PR. Its amendment must predate acceptance. A first-head-correct model
   result is not CI-repair evidence; do not manufacture a failure or suppress a check.
6. In the prepared clean isolated F checkout, run real-binary qualification, same-run macOS
   confinement, fresh packaged-artifact/five-consumer proofs, and the three actual-native
   compaction/lifecycle tests. Retain private outputs separately from real-model receipts. Complete
   the real two-turn Git-connected Chat refinement/application and negative-effect scenarios.
7. Complete the final source-bound acceptance audit, full applicable gates, required GitHub checks
   and review settlement. Only then integrate through the protected path, verify actual `dev`,
   record genuine H1 postmerge provenance, close fulfilled issues and delete the merged branch.

All 322 historical review conversations were resolved at the pre-pause observation, and the
September 7 audit found zero unresolved review threads. New comments and checks after that audit
require another read. Only CodeRabbit's oversized-PR coverage failure is excluded; concrete
findings and other reviewers remain in scope.

## Private restoration material

The operator-local checkpoint directory `.codex/task-checkpoints/keiko-3384-2026-09-06` contains
restoration instructions, retained live state, the shared ledger, selected audit logs/receipts,
fixture-preparation scripts and the failed browser trace. It is private and is not committed or
uploaded. It deliberately excludes dependency installations and unrelated repository copies.
Configuration is read from the operator's existing local files; no credentials belong in this
handoff, Git history, review comments or qualification evidence.
