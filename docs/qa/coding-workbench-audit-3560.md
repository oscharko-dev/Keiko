# Coding Workbench audit — #3560

Date: 2026-09-19. Delivery: draft PR #3561. This is an incremental audit record, not a
production-readiness sign-off. Product changes are developed in an isolated Keiko worktree;
live coding exercises target the owner's disposable `oscharko/Wegwerf-Repo-Final` repository.

## Runtime and upstream boundary

The earlier hosted analysis reports 86.16% new-code coverage and zero new SonarCloud violations
at commit `ebc23d7d1`. This clears the requested 85% floor, but does not imply that the other
required CI checks or the open review findings are complete.

The follow-up CI run exposed two measurement provenance problems: editor bundle evidence had
been compressed with Node 26 rather than CI's Node 24.18.0, and the native performance calibration
still described OpenCode V1. The bundle mismatch reproduces on the same static export by using
Node 24.18.0. Runtime migration measurement now has an explicit path that retains the previous
performance ceilings and rejects a simultaneous reference-machine or toolchain change.

The native V2 measurement series were repeated after repairing placeholder and cumulative-text
projection. Each series used two warmups plus 30 retained samples on the pinned macOS reference,
Node 24.18.0 and npm 11.16.0. Every sample now requires the exact assistant answer and zero dropped
activity events. The independent candidate's p95 values are 1,735.901 ms cold start, 1.946 ms
readiness, 3.101 ms SSE first byte, and 99.416 ms bounded throughput. Source freshness and the
existing performance ceilings pass. No ceiling was raised. The earlier validation-rejection
warnings were reproduced as empty text placeholders and are absent from both new series.

The CI Node 26 warmup timeout was not reproduced locally: with the normal development server
stopped, both real runner-readiness tests passed in 25 seconds. No timeout or assertion was
weakened. The full refreshed scripts coverage run passed 6,406 tests with 27 existing skips;
that checkpoint's combined local new-code report was 85.2% over 2,481 lines/conditions. Hosted checks must still
run on the new head. One earlier SonarCloud processing task failed independently of the other
successful current-head analysis; it is not treated as a coverage failure or a green CI result.

The approved runtime is OpenCode 2.0.10 (`scripts/portable-runtime-approvals.mjs` and
`packages/keiko-tool-catalog/src/dialect.ts`). The runtime, server protocol, plugin registration,
question forms, portable staging, and approval fixtures now use V2. V1 archives and adapter
identities are rejected; this is a clean-cut migration without a compatibility fallback.

The [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/) describes the changed server and
plugin APIs. A successful protocol handshake does not replace real task, confinement, restart,
and provider qualification. Those checks remain part of this audit.

## Capability comparison

The integration uses the pinned V2 protocol and native question forms. Keiko's product authority
remains the owner of workspace effects; unsupported V1 endpoints and tools are not emulated.

| Capability                                         | Keiko implementation / audit disposition                                                                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation continuity                            | This PR adds local Coding History using the existing chat/message store, a separate rail window, rename, completion, reopening, and default continuation. Each turn still starts a fresh runtime with bounded historical context; this is not native OpenCode session resumption. |
| Planning and questions                             | Native V2 questions are projected into the Workbench and answered through OpenCode forms. V1 todowrite is removed from the catalog and history adapter; planning is ordinary agent conversation.                                                                                  |
| Workspace reads, search, edits and verification    | Existing governed tools replace native direct filesystem/shell access. Preserve that boundary; enabling native tools is not a safe feature shortcut.                                                                                                                              |
| Git and delivery                                   | Existing proposal/execution tools and review surfaces own stage, commit, push and draft PR operations. The audit still needs a complete successful live edit/build/delivery journey.                                                                                              |
| Context compaction                                 | The fixed launch profile supplies an explicit compaction policy and task-preservation prompt. Cross-turn History context is bounded separately to 24,000 characters. Long-history qualification remains open.                                                                     |
| Optional research, skills and child agents         | The production resolver filters the outgoing model tool catalog against current availability. Do not infer missing filtering solely from the optional launch-profile argument.                                                                                                    |
| File references, attachments and command shortcuts | Candidates for subsequent UI improvements; their contents, model capabilities and workspace scope need validation through existing Keiko paths. No native endpoint is exposed by this PR.                                                                                         |
| Fork and undo                                      | Native snapshots are disabled in the fixed profile. A future product action must preserve Keiko's workspace/change-review ownership and cannot simply call native revert.                                                                                                         |

## Reproduced and repaired

- First coding task in an accepted repository failed if the ordinary project catalog had no entry.
  History now registers that accepted repository before creating its first conversation.
- A manually bound repository lost its finished transcript when the desktop project differed.
  Session visibility now uses the active workspace's repository identity.
- Reload after creating a new task could restore the previous task. History selection is consumed,
  and automatic history restoration checks the active workspace identity.
- A deterministic task branch could collide with an existing branch from a previous installation.
  Setup retries once with a distinct task identity through the same verified binding workflow.
- Branch submission could race inventory loading. Both the button and form submission now require
  an available selection; lookup failures expose retry.
- A narrow Workbench could collapse the timeline beneath the composer, intercepting approval
  clicks. Its layout now preserves a scrollable timeline area.
- Branch error feedback failed the existing forced-colors contrast test. It now uses system colors
  in that mode; the same dark/light browser regression passes without an allowlist.
- Schema-35 migration fixtures and the store fingerprint inventory omitted the new relation
  tables. Both now include them; forbidden-field assertions pin their body-free schemas.

## Observed live results

An actual model run read the disposable repository's package and README files. A follow-up in the
same task correctly recalled the test label and build command without another read. Rename,
completion, reopening, New task, and reload were exercised through the browser. After New task
and reload the prior conversation remained in Completed history without appearing in the new task.

The V2 question exercise reproduced an adapter rejection of the native `question` history item.
After correcting admission against the canonical tool inventory, the model presented Navigation
and FAQ options, accepted the FAQ selection, and completed successfully. A following turn in the
same task recalled FAQ without a tool call. Both tasks ran through the browser and configured
gateway, without an issue or delivery operation.

A larger test-generation task applied an approved four-file patch, then failed on repeated later
patches and exhausted its prompt budget. It is not a successful verification result. Improving
that failure remains part of the next task cycle. A stale browser pairing after a BFF restart also
required a page reload; restarting alone must not leave the composer falsely ready.

## Follow-up test-generation exercise — 2026-09-19

A no-issue task generated navigation, FAQ interaction, and keyboard-accessibility tests in the
disposable landing-page repository. The governed eight-file change was applied. Package-script
trust was granted through the contextual composer action, and the run resumed. The model observed
a failing keyboard test, repaired it, and the test verifier then passed. The production build
failed; a later repair did not apply, and the run exhausted its accepted 200,000-token cumulative
prompt budget. This is a partial result, not a successful task or build. No commit or push was
requested or performed by that run. The next optimization must address bounded task completion,
budget visibility and continuation, and excessive repeated planning output without bypassing the
accepted authority limits.

The functional V2 fixture now uses the actual managed tools and assistant progress text, replacing
its retired V1 todowrite emulation. Its long-output proof exceeds the message-byte bound using
real fixture model output, with a separate sufficient model output allowance; it no longer pads
every ordinary progress message. Existing paired visibility, truncation, redaction, question,
verification, stop, and workspace-escape assertions remain exercised.

## History selection and repair continuation — 2026-09-20

Pending explicit history loads now remember the workspace-scope revision that requested them.
Switching repositories or task workspaces, including switching away and back before the response,
cancels the stale activation. Closing the Workbench also invalidates the request. A successful
history-owned workspace switch remains valid; an externally superseded switch cannot restore stale
conversation detail, including after the operator clears the active binding. Scope cancellation and clearing a completed historical conversation without a
live snapshot emit separate body-free client diagnostics through the existing port. Five race checks failed before their respective fixes; all 19 session tests pass afterward.

The same no-issue live task continued in its existing workspace. The model corrected the Vite
configuration, and the production build verifier passed. The keyboard test still failed: successive
focus assertions retained an incorrect eight-tab bound. The operator rejected a further edit that
would not repair that bound, then stopped the run through the composer; the UI confirmed Stopped.
This is not a completed test-generation task. It verifies continuation, reviewed edits, failed-test
feedback, a successful repaired build, rejection, and composer stop. No commit or push occurred.

A subsequent diagnostic-only turn ran the failing test once and correctly returned its assertion
location and expected/actual focused elements. The gateway preserved that feedback. The next
repair turn initially repeated the wrong tab order, then corrected it and passed the test verifier;
the build failed after that edit. A proposed follow-up inserted a helper and a nested suite into the
wrong test body, so it was rejected and the run was stopped. This isolates repair quality and scope
preservation as remaining limitations; it does not establish a gateway-output loss or successful
end-to-end test generation.

A further browser continuation diagnosed `TS2554` in the test's two-argument `expect` call.
The first patch was refused as `INVALID_EDITS`; after rereading the file, the model proposed a
valid two-line correction, which was reviewed and applied. The existing keyboard assertions and
bounded traversal remained intact. The activity log records the initial failed build and both
subsequent test/build executions as passed, and the Workbench reached Succeeded without staging
or delivery. However, the final model response incorrectly interpreted `commitProof: unavailable`
with `candidate-not-staged` as refusal to run the verifiers. This is an observed reporting defect:
the successful tool response includes commit-proof eligibility but does not explicitly expose the
passed verifier result. Clarifying that existing result contract is the next optimization target;
the successful checks must not be converted into an unsolicited stage/commit workflow.

The real-binary qualification runner now reports the pinned runtime version from the adapter's
production owner instead of retaining a V1 literal. Geometry expectations derive from the actual
gateway selection and launch-profile owners. Negative fixtures deliberately differ from the admitted
limit, so they remain rejection proofs when the functional model's output allowance changes. All
27 runner tests pass after reproducing the stale-limit failures and the incorrect-version report.

## Native V2 activity reconciliation — 2026-09-20

The native performance fixture reproduced `safe-activity-dropped-validation-rejected` with a
body-free diagnostic probe: the rejected signal was a validly identified text part of length zero.
OpenCode creates that placeholder before streaming characters. The history adapter now reconciles
its identity without publishing empty text. A native success assertion rejects any nonzero feed
drop count; it failed against the previous implementation. Placeholder observations carry bounded
counts and the run correlation through the existing Activity Log, with replay and emitted-line
proofs. This finding did not establish loss of a nonempty message in the observed native samples.

A second regression reproduced cumulative native text (`Hello`, then `Hello world`) being appended
twice. The adapter now emits only new characters and retains only the prior digest and character
count. An unexpected rewrite or truncation fails closed without advancing the checkpoint, and a
subsequent valid continuation remains recoverable. It does not weaken safe-feed validation.

The current CI installation failure was reproduced by `check:portable-manifest`: the contract
example's reviewed sidecar binding retained a placeholder SBOM digest while its manifest used the
V2 digest. Both now match. The UI smoke failure was also reproduced: its workspace-health assertion
read the collapsed Details section. The journey now opens that actual control and retains the
health and effective-mode assertions before starting the run. The targeted two-test suite passes.

The updated runtime suite passes 2,717 tests with eight existing skips. All 82 Chromium smoke
checks pass, as do root typecheck/lint, formatting, architecture/negative checks, the Activity Log
gate, and the real local Sonar analyzer. New-code coverage is 85.5% over 2,525 lines/conditions:
the changed runtime files use fresh runtime-suite LCOV and unchanged sources retain their preceding
full-suite package/UI/scripts reports. This is not a new complete package-coverage run or a hosted
verdict for the new head.

## Independent verification outcomes — 2026-09-20

A real same-task continuation reproduced successful test/build checks being reported as unrun
because the candidate had not been staged. The governed verifier now returns explicit
`verification.status: passed` and completed check kinds, with commit eligibility in the optional
`verification.commit` field. OpenCode's canonical tool descriptions and launch guidance explain
that staging belongs only to an accepted delivery task. The existing commit-proof checks remain
unchanged. Malformed result and unsafe blocking-path rejection pins exercise the new nested
contract, and an empty passed report cannot claim that a check executed.

The before-fix reproduction failed five assertions. The updated runtime/catalog coverage run
passes 2,976 tests with eight existing skips; 283 focused tests also pass. The generated native V2
plugin is exercised through registration, IPC, canonical admission and the verification port.
New-code coverage is 85.7% over 2,564 lines/conditions, using fresh coverage for this round's source
files and the preceding full reports for unchanged sources. Typecheck, scoped strict lint,
formatting, architecture/negative checks, the full Activity Log gate, and real local Sonar pass.
The tool-catalog candidate was remeasured in its pinned Linux reference container without changing
calibration or budgets. Native V2 qualification adds 32 successful runs with an exact answer and
zero safe-feed drops; source-freshness passes against the frozen native calibration and ceilings.

The same real Workbench task was resumed after the server restart. Test and build each ran once,
and the model now correctly reports both as passed while retaining the optional missing commit
proof as separate information. No files changed, and no stage, commit, push, issue or PR action
was requested or executed. The UI reached Succeeded at revision 9. Both successful checks own
correlated `coding-runtime.verification` activity records with their actual kind and proof status.
The run required two one-time command approvals; the composer displayed Supervised workspace while
also showing the effective Ask for approval label. That discrepancy remains to be investigated.
One late event was rejected as `no-live-run` after settlement; this is distinct from the previously
repaired native text-projection validation drops and is not counted as a successful lossless live
feed qualification.

## Remaining qualification

- Repeated selection of the same history task, concurrent refreshes, and title synchronization.
- Paired-channel authentication and complete generic-chat isolation integration tests.
- Restart, interrupted capture, unavailable storage, and visible transcript completeness.
- Canonical multi-file patch review, effective autonomy presentation, and a real edit/build/PR run.
- Full affected release checks and review resolution. Per-run outcomes belong in the PR verification
  section; a passing local Sonar rule scan does not replace hosted coverage or required CI.
