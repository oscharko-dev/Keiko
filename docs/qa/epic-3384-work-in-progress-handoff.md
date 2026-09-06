# Epic #3384: paused work checkpoint — September 6, 2026

The owner requested a clean end of work for today and continuation from this checkpoint tomorrow.
This is a preservation checkpoint, not epic completion, merge readiness, or issue-closeout evidence.
No real-model continuation was started during shutdown. The local PR audit automation is already
paused. PR #3394 remains open; native auto-merge is not armed. No issue or working branch is closed
or deleted by this checkpoint.

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

Actual results, with their source limits:

| Verification                               | Result                                             | Source / limitation                                                                       |
| ------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Full package coverage                      | 1,981 files; 40,468 tests passed; 51 tests skipped | Exact clean `f8088db2`; before the final clock repair                                     |
| Full UI coverage                           | 447 files; 8,028 tests passed; one skipped         | `44cf0537`; UI source unchanged afterward                                                 |
| Script coverage                            | 207 files; 5,234 tests passed; 26 skipped          | `b844b272`; covered script source unchanged afterward                                     |
| Full server suite on Node 24               | 713 files; 13,699 tests passed                     | `b844b272`; before the final clock repair                                                 |
| Cold route entry imports on Node 24        | 12 passed                                          | `b844b272`                                                                                |
| Final clock repair regression target       | 70 tests passed                                    | Both affected bridge/authority suites; ESLint, Prettier and server TypeScript also passed |
| Browser publication                        | All 12 cases passed                                | Actual `5be376e6` producer output retained; source hashes verified                        |
| Browser CI and Git-connected Chat fixtures | 2 and 4 cases passed                               | `5be376e6`; deterministic fixtures, not real-model qualification                          |
| Final intake and affected visual captures  | Four selected targets passed                       | `f8088db2`; actual redirected producer artifacts archived and verified                    |

The final complete six-case commit-browser rerun on `f8088db2` failed with the workspace-revocation
crash after two passing cases; three did not run. Its failure log and trace are retained. The clock
repair has targeted red/green proof, but that full browser lane must be rerun tomorrow. The older
tracked #3386 journey receipt is historical and must not be represented as this missing rerun.

The fresh #2952 calibration/candidate pair and H1 checkpoint passed before the clock repair.
The repair changes their owned source closure, so both now need requalification. The #3415 Linux
catalog performance subject/ruler does not own the bridge change; its checker still passes.
Do not repeat that Linux measurement merely because a different source file changed.

The final pause checkpoint also passed full root TypeScript checking, the generated operation
catalog check, and the local Sonar analyzer. These results do not replace the pending full
commit-browser rerun, refreshed H1/native-performance evidence or current-head GitHub checks.

## Real-model delivery: 0/5 completed

[Wegwerf-Repo PR #7](https://github.com/oscharko/Wegwerf-Repo/pull/7) is an actual draft for
[issue #1](https://github.com/oscharko/Wegwerf-Repo/issues/1), with verified commit
`aec3a459ea09f2efb939c21f3b35395e91b811c9`, an actual push and previously passing required `ci`
on that head. It has not been merged and the issue is open. Independent review found opposite-sign
maximum-value overflow in its average implementation; that model-authored repair is still required.

Attempt 32 failed before editing because recovered PR/CI binding admission was unavailable.
That product defect was repaired in earlier commits. The next prepared continuation is attempt 33,
using the preserved attempt-31 workspace and attempt-32 predecessor through normal recovery.
Do not recreate the workspace, discard its Git history, manually author the fixture repair, or
claim a completed run from the runtime's terminal status alone.

## Resume sequence

1. Read this checkpoint and the private resume packet. Verify local/remote PR heads, current review
   comments and check results. Resume the five-minute checkpoint/review cadence only when work is
   actually resumed. Preserve the known workspace and existing draft PR.
2. Rerun the six-case commit browser lane through the clock fix. Retain its actual redirected
   `test-results/e2e-evidence` output before another lane clears that directory. Never substitute
   an older checkout's `docs` artifact for a producer output. Revalidate every recorded source hash
   and screenshot digest before copying canonical evidence.
3. Requalify H1 and #2952 native calibration/candidate evidence for the repaired source. Complete
   any remaining non-#3390 source/evidence corrections, then freeze one clean source F for all five
   flows. A later landing descendant may contain only the validator's allowed qualification
   artifacts; never restamp an old run or broaden that allowlist to conceal source drift.
4. Start the prepared real attempt 33 at F and follow the activity log first. Observe real failing
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

All 322 review conversations were resolved at the last pre-pause observation. New comments and
checks after the final preservation push require a fresh read tomorrow. Only CodeRabbit's
oversized-PR coverage failure is excluded; concrete findings and other reviewers remain in scope.

## Private restoration material

The operator-local checkpoint directory `.codex/task-checkpoints/keiko-3384-2026-09-06` contains
restoration instructions, retained live state, the shared ledger, selected audit logs/receipts,
fixture-preparation scripts and the failed browser trace. It is private and is not committed or
uploaded. It deliberately excludes dependency installations and unrelated repository copies.
Configuration is read from the operator's existing local files; no credentials belong in this
handoff, Git history, review comments or qualification evidence.
