# Coding Workbench audit — #3560

Date: 2026-09-19. Delivery: PR #3561. This is an incremental audit record, not a
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

## Review corrections — verification and history failures — 2026-09-20

Commit `b004c6e2c` separates optional commit-proof failures from executed verification results.
Exceptions while beginning, completing or observing proof invalidate the proof and report
`proof-unavailable`; they do not rewrite a passed test as failed. Passed outcome records now retain
the closed commit-proof refusal reason. The verified-commit owner records verification generations
so a superseded ticket can be joined to its replacement without retaining invalidated authority.

V2 reconciliation failures now use the history diagnostic identity, including safe stack frames and
cause chains. A malformed tool identity is rejected before argument diagnostics can hash a missing
name. Reproductions failed before both fixes, and existing oversized-argument and redaction pins
remain enforced.

The affected runtime, Git-delivery and diagnostics coverage run passes 3,937 tests with eight
existing skips. The focused suites pass 361 tests. Incremental new-code coverage is 85.9% over
2,618 lines/conditions, replacing changed-file LCOV with this run and retaining earlier full reports
for unchanged sources. Typecheck, strict scoped lint, full formatting, the seven-check Activity Log
and architecture gate, and real local Sonar pass. This round introduces no UI change or gateway
special case. The first native performance series exceeded the throughput budget (129.395 ms
against 123.094 ms) while this checkout's development watcher consumed over one CPU core. After
stopping the idle development instance, a fresh 32-run series passed the unchanged native budgets
and source-freshness gate. The initial failure is not counted as a passing qualification. Remaining
review conversations still block merging.

## Remaining qualification

- Repeated selection of the same history task, concurrent refreshes, and title synchronization.
- Paired-channel authentication and complete generic-chat isolation integration tests.
- Restart, interrupted capture, unavailable storage, and visible transcript completeness.
- Canonical multi-file patch review, effective autonomy presentation, and a real edit/build/PR run.
- Full affected release checks and review resolution. Per-run outcomes belong in the PR verification
  section; a passing local Sonar rule scan does not replace hosted coverage or required CI.

## Merge review: read-only provider selection and recovery

The Workbench no longer launches a duplicate automatic readiness workflow when opened or when
its provider profile is unavailable. Explicit checks remain in Gateway Settings, and the shared
verified tool-calling capability gate is unchanged. The deleted fallback's legacy failure-register
entry was pruned with the repository generator.

A successful empty change read retains its revision inside a compact disclosure. Terminal runs
retain the stale-activity warning and reconnect action. Mixed qualified and bare issue references
are checked together; repeated references to the same issue are deduplicated. Seven assertions
failed before these fixes. The focused UI suites pass (226 tests), and the runtime refresh/voice
reproduction passes (72 tests). The Chromium stop/recovery/retry journey passes (2 tests).

The owner explicitly requested removal of the separate Stop/Take over action bar. Composer Stop
remains available for paused runs and invokes the existing correlated server stop mutation, which
revokes the run's authority. The duplicate unstructured Stop-click diagnostic was removed; the
server lifecycle remains the authoritative stop evidence. The paused-run exit assertion is retained
under this product decision rather than attributed to the older two-button UI requirement.

Final UI coverage: 8,582 passed, one existing skip; 93.10% line coverage. The initial broad run
also exposed a transient voice-fixture timing failure, which passed in the focused reproduction
and the complete rerun without changing that test. Combined incremental coverage is 85.7% across
2,587 new lines/conditions. Typecheck, strict UI lint, formatting, real local Sonar, and the Node
24.18.0 editor bundle gate pass. The initial Node 26 bundle check differed by compression
fingerprint; remeasuring the same export with the pinned Node version matches committed evidence.

## Merge review: atomic history and startup evidence

Automatic project registration, its workspace manifest, and first-task creation now share the
existing SQLite write transaction. Nested store operations use savepoints; failed inner writes
roll back independently and an outer failure rolls back successful nested writes. Empty and
whitespace-only titles reproduced orphan registration before this fix.

History restoration records selected/source counts, byte count, digest, and truncation. Creation
records whether the project was registered, updates record old/new status and title-change state,
and persistence failures retain classified, body-free frames and causes. History initialization
has its own diagnostic reason instead of being mislabelled as initial-turn dispatch. Composed tests
also assert emitted issue-context and native initial-context lines. The optional commit-proof
failure proof now explicitly requires `errorKind: unavailable`.

The CI-repair snapshot store now admits `starting` under the same live authority and binding checks
as the production prompt path. Its new test failed against real SQLite state before the fix.
Prompt admission emits the requested token count and accepted/blocked result without prompt text.
ADR-0173 now distinguishes passive Workbench catalog reads from chat entry-point readiness probes.

Validation: typecheck, architecture including negative fixtures, all seven Activity Log checks,
real local Sonar, and formatting passed. The broad targeted coverage run had 4,470 passing tests,
eight existing skips, and one new assertion expecting the obsolete text log format. That assertion
now reads the actual V2 JSON line; all 20 tests in its affected suite pass. The separate proof/store
run passes 105 tests. Root lint found one void callback style error; its corrected file passes the
same strict lint rule. Combined incremental coverage is 86.1% across 2,632 new lines/conditions.
The fresh 32-run native OpenCode series and the unchanged performance-budget/source-freshness
gate pass with the pinned Node 24.18.0 toolchain. No calibration or budget was relaxed.

## Merge review: dependency provenance and workspace serialization

A repository-written completion marker reproduced a false `current` install before the fix.
Completion now lives in a bounded process-owned cache and is bound to manifest/lockfile and installed
entry identities and change times. Host marker writes were removed. Reusing a previously current
plan rechecks that receipt, while failed installs invalidate it. Verification uses the existing
workspace mutex across bootstrap and script execution; concurrent requests produce ordered,
correlated waiting/acquired/released evidence. Receipt reason and completion state are recorded on
the existing dependency operation. Command-boundary failures now reach the structured diagnostic
port, removing one legacy unlogged-catch exemption.

Validation: 386 tests across 21 affected suites passed, including actual runner/execution/bootstrap
composition with a failing network boundary and persisted diagnostic assertions, concurrent runs,
forged markers, file mutation with restored mtime, stale plans and a directory symlink swap. Root
and UI lint, typecheck, formatting, architecture/negative fixtures, all seven Activity Log checks,
ADR index and real local Sonar passed. Incremental coverage is 86.2% across 2,718 new lines/conditions.

The first 32-run native measurement exceeded the cold-start p95 budget while the local analyzer
was running. With the analyzer and test gates finished, a complete fresh 32-run series passed the
same budget and source-freshness checks. No samples were removed and no budget/calibration changed.

## Merge review: durable native history and complete initialization

Native V2 history now persists visible conversation messages before the display projection applies
its TTL, turn and byte limits. Streaming updates are idempotent and append-only; large messages
are chunked in the existing local conversation store. A composed native HTTP-history proof and a
real SQLite test retain all 40 turns after display expiry. Failed captures retain classified,
correlated evidence and are retried on the next history read. Hidden context, tool arguments and
reasoning are not conversation messages.

Task initialization now atomically includes project/task creation, run binding and the initial
intent. SQLite abort triggers prove rollback at both later writes and on continuation; removing the
outer transaction makes all three tests fail. Native question transitions now emit correlated state
and call-digest evidence. Readiness records the text planning mode and materialized config digest.

Validation: 3,370 affected tests passed, with eight existing skips. Typecheck, strict scoped lint,
formatting, all seven Activity Log checks (including architecture and negative fixtures), ADR index
and real local Sonar passed. Combined incremental coverage is 86.7% across 2,830 new lines/conditions.
The initial native series exceeded the throughput p95 ceiling (125.884 ms); a complete repeat passed
the unchanged budgets and freshness checks. The first result remains a failed qualification, not a
passing sample set. No calibration, threshold or individual sample was changed.

## Merge review: history scope and passive capability evidence

Pending history selections now compare a synchronously captured scope before switching workspaces.
A regression that delays passive effects reproduced the stale-selection switch before the fix.
The initiating history GET correlation survives cancellation, supersession and completed-task
clearing without a live snapshot. Closed reasons and opaque task/scope identities travel through
the existing diagnostic transport; file-sink proofs distinguish repository and workspace mismatch
without recording paths or conversation content.

Equal issue numbers no longer identify equal issues across repositories. An ambiguous bare/qualified
pair resolves the bare reference against the server-owned checkout identity before deduplication.
The cross-repository regression failed before the fix. Empty terminal feeds have independent
truncation and dropped-update proofs; removing the corresponding guard clauses fails both tests.
Passive unavailable provider profiles now record their closed tool-capability reason and request
correlation without starting a probe.

Validation: the full UI coverage run passed 8,588 tests with one existing skip (93.11% lines).
Server/contracts coverage passed 346 tests; the final focused history/transport run passed 77.
Root/UI typecheck, strict lint, formatting, all seven Activity Log checks and the production editor
bundle evidence gate passed. Real Sonar found one collection-membership idiom; its correction and
the repeat analysis pass. Incremental coverage is 87.0% across 2,926 new lines/conditions. The fresh
32-run native measurement and unchanged performance/freshness gate pass.

## Merge review: fail-closed installation and native history integrity

An unrecordable dependency completion now fails verification before any script executes. The
orchestrator regression reproduced an outside-directory symlink swap followed by two script
spawns; after the repair only the installation attempt occurs. Inconclusive tree inspection
refuses execution with closed unreadable/limit/identity/directory codes, and the composed
runner/bootstrap/command tests assert the persisted diagnostic correlation, classification,
frames/causes and redaction. Harness verification passes its run ID to workspace queue evidence.

Native history chunks preserve Unicode code points, including an astral character crossing the
65,536-unit boundary. Real SQLite replay failed before this repair and now preserves the exact
response through streaming updates. Changed captures include a body-free source/content digest;
missing-run capture and failed native-question transitions have emitted-line proofs. Voice and
Markdown diagnostics no longer receive unregistered history-scope fields; both mixed-shape
regressions reproduced a write failure before the correction.

Validation: 3,171 affected tests passed with eight existing skips; the final verification run
passed 294 tests and the composed diagnostic suite passed four. Root typecheck, strict scoped
lint, formatting, all seven Activity Log gates and real local Sonar pass. Incremental coverage is
86.7% across 2,943 new lines/conditions. The initial native series exceeded the throughput p95
ceiling at 123.579 ms; the complete repeated 32-run series passed the unchanged budgets and
freshness gate. No sample was removed and no threshold or calibration changed.
