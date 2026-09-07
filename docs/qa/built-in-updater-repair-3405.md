# Built-in updater repair evidence ledger (#3405)

Status: implementation and qualification in progress. This is not a clean-audit receipt or a
production one-click claim. Parent epic: [#3403](https://github.com/oscharko-dev/Keiko/issues/3403).
The [reviewed baseline audit](built-in-updater-audit-3404.md) defines the repair contract and deletion
register; the [issue](https://github.com/oscharko-dev/Keiko/issues/3405) owns acceptance criteria.

## Evidence boundary

The observations below were collected on the repair working tree based on
`acc990f1f057d9445ff781903fad69a6ae58757f`, on 2026-09-05 and 2026-09-07. The core implementation is
preserved in checkpoint `6aeac08160ae9f90f58f11c0ef8e86bbe9b77167`; subsequent changes remain in progress.
UI behavior and loading proof are preserved in `ddd8aea06` and `9623e3402`; the legacy journal
compatibility disposition is preserved in `a4394887c`.
The reviewed Windows producer is preserved in `50160cd10`, and the Mac normal-startup recovery
development checkpoint in `a4c2dbd9f`. Integration commit
`78f52c774a1e49b32df80db0c4b3c5ecd2c592a0` includes current reviewed dev through the epic branch.
These are development observations, not SHA-bound final delivery evidence. Rerun the relevant commands after integration and bind every
final result to the actual commit. A green #3404 documentation PR does not verify #3405 code.

The historical #1960 matrix records fixture/contract coverage, not native N−1→N execution. Neither
route mocks, fake children, injected version verifiers, nor payload `--version` smokes can settle the
real-process and real-artifact requirements here. Tests with filtered cases must name those skips.

### Resumed verification checkpoint (2026-09-07)

The governed local toolchain is Node.js 24.18.0 with npm 11.16.0. The package build passes
under that toolchain; an earlier Node.js 25 development run is not final verification evidence.
The latest complete updater browser suite passes all eight tests (1.2 minutes), including the
real-BFF outage/reconnect journey, deferred loading-to-ready notice assertion, and error-only
foreground notice regression. Earlier
interrupted multi-test and responsive captures do not count as passes. The refreshed visual
evidence includes 12 axe captures with no violations;
lead inspection confirms the responsive action is unobscured and all eight source plus four
harness hashes match. The wiring gate identifies the updater suite as
`runs-per-pr`, and the explicit changed-file i18n guard passes.

Independent recovery review confirmed two additional existing crash-consistency gaps: missing
aggregate state can discard surviving handoff ownership, and terminal session settlement spans
two durable writes. Both repairs are included in the core checkpoint. Independent replay passes
all 99 tests in six complete candidate, local-state, session, durable-session, production-handoff,
and recovery suites (16.01 seconds). Re-review accepts both repairs and identifies one remaining
low-severity diagnostic gap for synchronous persistence failures. That follow-up now passes
independent replay of all 50 session/durable-session tests (13.16 seconds), and static security
re-review approves it with no confirmed findings. Synchronous failure preserves authoritative
ownership, projects `unwritable`, and emits one body-free diagnostic without an asynchronous duplicate.
The bounded review confirmed no additional authority-binding regression from the structural refactor.

Successive Windows diagnostics repaired directory-symlink cleanup, oversized fixture/protocol
stack allocations, strict byte/qualifier diagnostics, and a missing standalone SHA header include.
The latest diagnostic at `37f16d070db94b84f1eff603703ab23ed4ad012a` passes the complete Windows
job: native compiler/analyzer/fixtures, setup bootstrap, package typecheck/build, and both
installable-package smokes (optional dependencies omitted and included). Evidence:
[Windows job 101721128128](https://github.com/oscharko-dev/Keiko/actions/runs/34115445910/job/101721128128).
The terminal Windows log was captured before cancelling the remaining diagnostic jobs.
Earlier failed diagnostics and cancelled jobs are not delivery CI evidence.
The diagnostic branch's protected-branch rejection is expected and is never treated as a green
workflow. Production KHA1 remains disabled pending startup recovery and actual native update proof.

The macOS atomic promotion/restoration prerequisite independently passes both
`bash scripts/check-macos-native-quality.sh macos-arm64` and the corresponding `macos-x64`
command on the local Apple silicon host. These compiler/analyzer/filesystem fixtures exercise
the atomic exchange boundaries and restore shapes; local x64 execution is not an Intel release
qualification run. Independent security review approves the final atomic prerequisite with no
confirmed findings. Normal-startup recovery and real installed two-process proof remain outstanding.

The Mac normal-startup slice is now source-frozen for independent security review. Its early CLI
gate holds the existing managed mutation lock, binds the plan to that locked root, and rejects live
owners or published children before claim or mutation. Session-lock transfer and child publication
are durable and identity-bound. Restored-start completion runs before BFF listen; terminal-last
state with a complete WAL is handled explicitly. Native recovery derives its action from receipts
and retains verified N.

The recovery control binds the exact aggregate bytes validated by the existing runtime-state reader.
That reader hashes one bounded raw buffer and rejects malformed UTF-8 and size races. Native reload
uses no-follow `updates/runtime-state.json`; it rejects a root-level lookalike and changed bytes,
including misleading numeric-prefix or object fragments. Earlier substring checks, independent
before/after digest reads, and the native fixture's incorrect root-level path were identified and
replaced before freeze. No positive native process replacement is inferred from these loader fixtures.

Owner replays pass seven server files / 68 tests, the local-state/normal-startup pair / 39 tests,
and two CLI files / 142 tests sequentially. Owned source and test ESLint, server/CLI noEmit, arm64
native quality, and ASan/UBSan pass. The earlier parallel CLI timeout remains a failed attempt;
its sequential replay is the passing result. Apple's ASan rejected an initial leak-detection option;
the supported sanitizer invocation passes with leak detection disabled, without claiming leak proof.
The lead regenerated the canonical operation catalog to 247 entries and independently passed all
15 drift tests (4.49 seconds). Package rebuild, independent review and final integrated-head proof
remain required; production KHA1 is still disabled.

On integrated commit `78f52c774`, clean `npm ci` completes with zero reported vulnerabilities and
`npm run build:packages` passes using Node 24.18.0/npm 11.16.0. Independent replay passes all
68 tests in the seven complete local-state, normal-startup, handoff, production-handoff,
handoff-recovery, session-lock-recovery and activation suites (18.19 seconds). The sequential CLI
lifecycle/portable replay passes all 142 tests (34.47 seconds); macOS arm64 native quality also
passes its compiler, analyzer and boundary checks.
The completed independent review identifies two medium recovery gaps despite that green
replay: a lone durable prepared receipt before native acceptance cannot settle on retry, and
timeout teardown can replace the child PID before confirmed native exit. These require scoped
repairs and additional crash/teardown regressions before the Mac slice is accepted. A dedicated
owner is repairing those gaps and distinguishing the unreleased KUR1 recovery control from the
unchanged binary supervisor KRC1 protocol. The review reports no critical, high or low findings.
The resulting four-file repair is frozen for independent re-review. It attests the old tree and
registration before settling the prepared-only prefix, waits up to five seconds for observed native
exit after teardown, retains published child ownership on failure, and handles asynchronous control
pipe errors. Owner verification passes all 17 focused tests, scoped lint/format and arm64 native
quality. The lead confirms all four frozen hashes and independently passes 79 tests in the same seven
complete recovery/activation suites (16.64 seconds). The first shared typecheck failed only on the
concurrent Windows staging argument; after that owner repaired its data flow, server workspace
typecheck passes. Re-review closes timeout/PID handling but identifies one remaining classification
gap: prepared-only recovery must reject an absent child record. The final narrow repair permits an
absent child only with zero receipts, preserving the prepared-only/dead-published-child positive
case. Independent security re-review now approves all four files with zero findings. Owner and lead
both pass all 18 focused startup tests; the lead replay takes 12.70 seconds and confirms the frozen
hashes. The independent arm64 native replay also passes. Later integrated delivery verification and
native N−1/N proof remain required.

The independent Windows architecture review freezes the remaining consumer/cutover contract in
[ADR-0121](../adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md#windows-generation-consumer-and-cutover-contract-3405).
Mac keeps KHP2/32; Windows uses KHP3/37 with exact appended generation/setup identities and shared
cross-language byte fixtures. A single native lifecycle owns both platform adapters. TypeScript
and native integration have disjoint file scopes after Mac review settlement, with
the native parser depending on the TypeScript fixture checkpoint. An initial Windows schema/layout/
staging slice can proceed alongside the narrow Mac fixes: it excludes every handoff, startup,
registration, maintenance and native file. Those shared integration surfaces remain gated on Mac
settlement. This is a design contract, not
Windows consumer execution evidence or approval of the pending native-proof amendment.
The architect approves the recorded contract after clarifying the exact incoming path and
the common KUR1 raw-snapshot validation. B1 implementation then identifies one concrete reuse gap:
synchronous CLI validation cannot attest generation contents through the asynchronous server-only
KHT1 helper, and direct Node invocation cannot inherit the native launcher's proof. A subsequent
architecture review resolves it with one shared TypeScript KHT1 authority in a narrow internal
security-package subpath, synchronous/asynchronous drivers over one bounded state machine, and
the existing server module retained as a compatibility facade. Parsers stay at existing boundaries;
no product-facing or package-root API, duplicate hasher or trust switch is introduced. A separate
owner implements this extraction before B1's final CLI attestation hookup and independent review.

The frozen Windows generation producer passes independent security re-review with zero findings.
The prior medium stale-inventory finding and low fresh-verification finding are closed. Production staging uses the
schema-2 generation binding, while ordinary/evaluation output remains flat schema 1 and manual-only.
Review fixes bind positive verification to the exact inventory bytes before producer mutation and
independently verify extracted KHT1, root launcher digest and setup binding. The lead replay passes
all 55 tests in the complete signing, qualification and setup suites (2.44 seconds). The owner's
five-file review suite passes 129 tests with one intentional skip; the evaluation-package regression
passes one selected test with 436 filtered skips (167.29 seconds), and adjacent producer smokes pass
33 tests. The earlier review run failed one fixture missing outer schema version 2; only the corrected
replays count as green. The earlier broad run remains 468 passing / one failed npm-pack case, with
that selected case subsequently passing in isolation; concurrency is not a waiver for the failed run.
Additional review attempts are not green evidence: a combined runtime/setup run was interrupted,
and two selected runtime tests failed with `Native TypeScript package build exited with 2` while
Mac source was still changing. That output alone establishes no root cause. The processes ended;
final integrated package verification must settle those attempts. Reviewers subsequently restricted
their checks to the frozen producer surface without shared builds.
The independent reviewer's bounded signing/qualification/setup/workflow replay passes 102 tests
with one intentional skip. The PowerShell inventory double-read was examined but not retained as
a finding: the proposed exploit additionally required concurrent local proof replacement, and
downstream exact-byte/live-inventory and closed-generation checks revalidate the promoted artifact.
These results cover producer contracts and fixtures. Windows CLI/server/native generation consumer
integration, actual signing execution and native N−1→N qualification remain outstanding.

The full UI coverage run at the core checkpoint reports 7,512 passing tests, four failures, and
one skip across 432 files. The four failures are shared stylesheet evidence hash assertions after
the updater-specific rule changed `globals.css`. Component placement and affected updater evidence
are now repaired: updater-specific behavior lives in the existing component stylesheet, and the
shared stylesheet matches its evidence baseline. All 337 focused UI/style tests pass, with eight
source and four harness hashes independently matched and the compact action screenshot inspected.
Independent full coverage replay now passes all 432 files: 7,516 tests pass and one is skipped
(167.01 seconds). Coverage is 89.92% statements, 82.35% branches, 91.49% functions and 92.79% lines.
Normal UI lint, workspace typecheck, changed-file i18n and formatting pass without increasing lint
suppressions. The generated editor bundle evidence is refreshed from the actual production build;
freshness and all three existing budgets pass. These development results still require final
integrated-head verification and do not qualify native replacement.
After the integrated dependency refresh, full UI coverage independently passes again: all 432
files, 7,516 passing tests and one skip (156.75 seconds). Coverage is 89.91% statements, 82.35%
branches, 91.49% functions and 92.79% lines. The production UI rebuild passes, and bundle evidence
is refreshed from that export. Its measurement remains `0db0d23ace092a039530d18d6d522a1b63170f2e1f221bfd451054b300e3e83d`:
first-load editor markers zero, shipped lazy editor runtime 1,000.5 KiB against 2,560 KiB, and
largest worker 109.3 KiB against 750 KiB. Freshness and all three budgets pass.
Integrated version consistency and current release-impact metadata checks pass. Release alignment
initially stops because the executable guard rejects the group-writable Homebrew `bin` directory;
using the existing protected `gh` Cellar directory in PATH passes without changing the guard.
Checkout, npm latest, newest tag, GitHub Latest and npm-publish deployment all agree on `0.3.17`.
The 15 operation-catalog drift tests pass again (4.41 seconds), and the existing observability gate
passes its 11 registered call sites; that latter result is not coverage of the new startup diagnostic.

The required local `npm run gates:sonar` attempt stops before analysis because Docker rejects
the pinned image pull with a registry authentication error, including an isolated anonymous
retry. No Sonar finding count or clean result is available from that attempt. Registry sign-in
repair is requested while independent implementation and verification continue.

### Native proof decision remains pending

The unchanged macOS production verifier requires Developer ID continuity, strict code verification,
stapled notarization and Gatekeeper assessment on the exact compiled bytes. Copied native artifacts
also require the release team under Apple's certificate anchor. Ad hoc fixture signing cannot
satisfy those checks. The current criteria simultaneously require exact current native PR artifacts
without secrets and unchanged production boundaries; no eligible signed N−1/N inputs resolve that
conflict today.

A proposed acceptance amendment would label real-process hermetic functional evidence
`functional-not-platform-qualified`, permit only existing test-composition provenance seams, and
retain genuine production-signed canaries as a separate mandatory qualification. This proposal
awaits operator approval. No criterion, production verifier, KHA1 enablement or substituted-verifier
harness has been changed on its authority. Production qualification still requires two genuine
eligible signed releases and all three native target journeys regardless of that decision.

## Acceptance evidence map

Every row remains open until current integrated-head evidence and independent review settle its
full scope. Existing source and focused test results locate the work; they do not imply completion.

| Requirement                                                                                                                  | Current evidence surface                                                                         | Remaining proof / disposition                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Fresh eligible candidate; reject arbitrary/stale/replayed/equal/older/future/unreviewed candidates and changed install facts | `update-candidate-authority`, production preflight, session routes and their tests               | Rerun real producer-to-start integration, including all rejected classes, on final head.                                    |
| Fixed npm/Yarn argv and immutable portable release/asset identity                                                            | CLI update, session support, preflight assets, staging manifest                                  | Verify actual execution composition; prove no command/path/URL injection or mid-session retarget.                           |
| Windows leaf rotation and hostile signer/timestamp/evidence rejection; macOS continuity                                      | `windowsPortableAuthenticode`, platform verification, native-copy verification                   | Security review and target-native execution, including PowerShell 5.1, remain required.                                     |
| Evaluation releases remain manual-only                                                                                       | Eligibility predicates and amended ADR/signing/setup guidance                                    | Test real producer rejection; document genuine first production transition without relabeling 0.3.17.                       |
| One lifecycle owner and ordered transitions                                                                                  | `update-lifecycle`, session/durable tests                                                        | Production adapters must consume the same owner; remove legacy portable version-only success.                               |
| Durable session/progress/recovery and distinct persistence failures                                                          | `update-local-state`, `update-session-durable`                                                   | Revalidate migration, corruption, incompatible/missing required state, unwritable state and replacement-process projection. |
| Idempotent startup at each crash phase; retain verified N                                                                    | Handoff plan/receipts/recovery and activation tests                                              | Inject each actual native crash boundary and prove old or fully verified new tree remains runnable.                         |
| Real same-port ownership transfer, success, cleanup and second restart                                                       | Production coordinator/recovery composition in progress                                          | Native executor, assembled two-process harness and all three target results outstanding.                                    |
| Hook/promise/child/persistence/cleanup failures settle with ownership and diagnostics                                        | Five focused lifecycle regressions replayed; startup cleanup review                              | Listener cleanup on thrown recovery and complete production failure matrix still need proof.                                |
| Finite resource limits and hostile download/egress/storage cases                                                             | Preflight/staging streaming, cancellation, retry, plan/receipt bounded-read tests                | Revalidate the full frozen cap and platform contention/quarantine matrix through production composition.                    |
| Cancellation at every checkpoint                                                                                             | Staging tests and preparation-cancellation regression                                            | Prove native cutoff, post-promotion recovery, owned-child termination and no incomplete trusted marker.                     |
| UI/CLI agree; expected outage reconnects; no false success                                                                   | Eight browser tests pass, including real BFF outage/reconnect; API and session tests             | Exact native replacement/version-proof projection and final integrated-head evidence remain required.                       |
| EN/DE, keyboard/focus/live region, contrast, motion and responsive evidence                                                  | Current visual/hash evidence, 12 zero-violation axe captures, i18n and non-growing lint registry | Rebind automated evidence to the final integrated head; carry subjective review into epic review.                           |
| Three native assembled N−1→N gates                                                                                           | No accepted current native result                                                                | Windows x64, macOS arm64 and macOS x64 must each exercise actual product bytes and production boundaries.                   |
| Native negative/crash qualification on every target                                                                          | Unit/fixture coverage only                                                                       | Native bad-trust, download interruption, cancel, disk, crash, timeout, lock/concurrency and cleanup results outstanding.    |
| Secret-free PR proof plus protected production canary                                                                        | Exact trust/secret-free artifact conflict documented; proposed amendment unapproved              | Operator decision on functional evidence and genuine signed canary inputs remain outstanding.                               |
| Required UI E2E lane with real outage                                                                                        | Eight tests pass; actual BFF outage; wiring gate reports `runs-per-pr`                           | Final required-lane execution and SHA-bound UI receipt remain required.                                                     |
| Canonical attempt reconstruction and redaction                                                                               | Server activity ports and CLI support analyzer tests                                             | Rerun across real process lineage; verify all forbidden evidence classes are absent.                                        |
| Catalogued operations, correlation and structured diagnostics                                                                | Generated op catalog, owning error/diagnostic paths                                              | Final catalog drift/error-observability gates and failure-path review required.                                             |
| Complete deletion/consolidation register; no unused public exports                                                           | #3404 register and current implementation diff                                                   | Settle every register entry with migrated consumers or justified expiring compatibility; audit full export graph.           |
| Runtime, ADRs, release contracts, runbooks, QA and release impact agree                                                      | Nine existing documents updated; documentation checks green                                      | Reconcile completed executable behavior, final results, release-impact approval and remaining evidence gaps before handoff. |

## Independently replayed development checks

- Lifecycle: two files, five selected tests passed, 37 filtered skips, 39.13 seconds. Covers
  preparatory cancellation, shutdown rejection, stale shutdown callback, persistence-failure
  ownership/lock retention, and committed-handoff rehydration. Subsequent source review confirms the
  stale-callback fixture no longer calls the legacy version verifier: it injects a validated durable
  success projection. That isolates stale-callback handling, not actual native verification.
- Handoff plan/receipts: two files, all 26 tests passed, 29.58 seconds. Covers bounded file/count
  reads, link rejection, tampering, topology, ordering and canonical encoding. The subsequently found
  high-bit digest-decoding edge is covered by the corrected current replay below; the older 26-test
  observation does not itself cover that later change.
- Startup/digest follow-up: two selected tests passed, 85 filtered skips, 26.99 seconds. The listener
  test proves an injected server's close path when post-listen recovery rejects, not actual port
  reuse. Subsequent source review confirms lossless sidecar decoding, a high-bit regression that
  preserves the original low bits, and existing structured startup diagnostics with sink cleanup
  in `finally`. These observations are not native acceptance evidence.
- Current plan/coordinator replay: both complete files passed, 25 tests, 15.48 seconds. This includes
  corrected sidecar-byte rejection and cancellation before an injected coordinator ACK. It does not
  prove real child termination. Subsequent source inspection confirms lossless `latin1` decoding
  also reached the coordinator ACK reader. Later native reader checks are recorded separately
  below; this earlier replay does not verify those later changes.
- Public API review confirms the new server-root exports are limited to the three types consumed
  by the CLI. Full deletion-register and existing-export review remains outstanding.
- Independent candidate/start review found one minor claim-availability defect: consumption occurs
  before token/digest authentication. Lead follow-up also found that capacity pruning reserves a
  slot during reads/rejected issuance, evicting a valid claim at capacity. Both repairs are now present:
  invalid credentials do not consume the claim, and capacity trimming occurs only after successful
  insertion above the cap. Independent replay passed both complete candidate/integration suites:
  18 tests passed, one explicit prerelease-case skip, 25.30 seconds. The default production factory
  regressions cover changed package manager, global root, and portable facts, each rejected before
  command invocation. Authenticated stale-fact claims remain single-use. Independent source re-review
  accepts those repairs but identifies one major mutation-boundary gap: install facts/version can
  change after successful consumption while `beforeExecute` is awaited. Revalidation against the
  accepted immutable snapshot immediately before execution and a deferred-hook regression are
  assigned. The current pre-request fact-change tests do not prove this later boundary.
- Native development checkpoint: independent `bash scripts/check-macos-native-quality.sh
macos-arm64` replay passed the compiler, analyzer, and boundary aggregate, including the FIFO and
  deep-directory KHT1 regressions. OS-provided hashing replaced the bespoke primitive. The monitor
  probe is source-checked in this lane, not qualified against an active Endpoint Security extension.
  The coordinator still returns a refusal without KHA1 while its mechanical executor is incomplete;
  this result does not populate any successful N−1→N qualification row.
- Pre-ACK abort review identified the durable validator's rejection of clearing an unaccepted
  prepared WAL. The repair must preserve revision/session/candidate
  binding, reject any receipt or accepted coordinator/cutoff, and retain recovery evidence if owned
  child termination or durable clearing cannot be proven. Capsule deletion must follow successful
  durable settlement, never precede it.
- Subsequent owner checkpoint reports 75/75 focused tests for the guarded pre-ACK settlement and
  retained evidence when child termination is unproven. Independent replay and final-head proof
  remain required. Review also confirmed the missing restored-N−1 startup branch: it must bind a
  distinct launch identity, original tree/registration, post-listen proof, and failed-update/settled-
  recovery result. The subsequent owner checkpoint reports 24/24 plan/builder tests and 14/14
  receipt/recovery tests, plus a green macOS arm64 native quality run and direct launcher
  compilation/static analysis. The plan is now strict KHP1 schema version 2 with 32 fields and a
  distinct server-generated restore launch identity. A fixed KHV1 acknowledgment is published only
  after the semantic verification CAS; missing acknowledgment must retain N and reconcile, never
  authorize rollback after verification. Independent review of these crash windows is underway.
  Production native execution still refuses without KHA1 until crash-resume authorization is
  implemented; compilation and focused tests do not establish native acceptance or qualification.
- Independent current pre-ACK replay passed all 36 tests across the complete handoff, local-state,
  and portable-activation suites (34.55 seconds). A separate recovery review confirmed a crash-after-
  intent defect for both target and restored verification: retry could append a duplicate intent
  before completion, violating the fixed receipt grammar. Reusing the pending intent and proving
  the second startup remains idempotent are assigned repairs; the focused green pre-ACK result
  does not settle these recovery windows.
- The bounded recovery review reports four major findings and one minor guard gap, all assigned
  to the existing owner: duplicate verification intents; restore admission after an earlier verified
  receipt; a crash leaving the published ACK with its temporary hard link; first restored post-listen
  settlement attempting WAL deletion before persisting the required restored-verified checkpoint;
  and unconditional deletion of a complete WAL without its terminal-settlement predicate. The
  restored-state unit stub masks the production-validator failure, so a real factory/local-state
  regression is required. A separate suspected complete-before-ACK window was withdrawn: native
  cleanup and completion already require the verified ACK. No extra settlement protocol is justified
  by that withdrawn finding.
- Subsequent recovery repair checkpoint independently passed all four complete receipt, recovery,
  production-factory, and local-state suites: 44 tests, no skips, 23.47 seconds. The owner reports
  pending-intent reuse, whole-history restore rejection, narrow ACK-link reconciliation, persisted
  restored verification before settlement, and guarded complete-WAL deletion. Production-factory
  coverage now includes a failed settlement retaining verified restore proof and restart settlement.
  The owner also reports a green server build and formatting. Independent source re-review is still
  required; these results do not enable or qualify native execution.
- Recovery re-review found one remaining completion branch: `canComplete=false` retains an active
  remediation session and its candidate, but the tightened WAL-deletion predicate requires no active
  candidate. The predicate must distinguish successful terminal settlement from linked active
  remediation, with production-factory and validator regressions. The 44-test checkpoint does not
  cover that previously omitted branch.
- The next checkpoint independently passed all four session, candidate, production-factory and
  local-state suites: 81 tests, no skips, 28.31 seconds. The owner reports shared post-await runtime
  revalidation and exact remediation-candidate retention, with durable failure/lock cleanup and
  dropped/swapped/modified candidate regressions. Independent source re-review approved those two
  repairs with zero findings and replayed the same 81 tests. Additional coverage is still queued for
  an initially portable candidate whose hashed facts change behind the execution gate, and the
  production complete-success sibling of the remediation case. The completed checkpoint does not
  prove native execution.
- Those two coverage follow-ups are now implemented and independently replayed: both complete
  session and production-factory suites passed, 47 tests, no skips, 27.84 seconds. The new portable
  case starts with a portable candidate before changing a hashed fact; the complete-success case
  asserts cleared active session/candidate/WAL, succeeded last session and a ready second startup.
- Portable trust/resource follow-up: six selected tests passed across three files, 33 skips
  (32 filtered plus one macOS-unavailable producer parity case). This is not Windows native proof.
- UI source review confirmed two observation gaps: every polling exception currently enters the
  transient reconnect path, including typed terminal errors; and the first read after an accepted
  start can enter a permanent error view during the expected outage before polling begins. The
  repair and regressions are queued behind the current recovery checkpoint. Terminal classification
  must use existing error codes as well as HTTP status: a contract-validation failure reported as
  HTTP 502 is not a temporary gateway outage.
- The initial reconnect repair independently passed all 50 UpdateWindow component tests (16.22
  seconds); the owner also reports a green UI production build/typecheck. Re-review confirmed the
  accepted-start/read-outage repair but found that non-`ApiError` exceptions were still all treated
  as transient. A real successful response with malformed JSON throws `SyntaxError`, so that path
  must be terminal. Narrow transport/deadline classification, malformed-JSON regression, and an
  explicit rejected-start/no-invented-session regression are assigned. Component tests do not
  replace the real-BFF outage or design-system evidence.
- The narrowed UI classifier and rejected-start follow-up independently passed all 52 component
  tests (2.52 seconds). Only recognized transport/read-deadline and temporary API errors reconnect;
  malformed JSON and unknown exceptions are terminal. Independent role re-review approved this
  bounded component slice with zero findings and another 52-test pass.
  No native or real-BFF browser result is inferred from this component checkpoint.
- Native owned-tree cleanup checkpoint independently passed the macOS arm64 native quality
  aggregate: compiler, analyzer, protocol/tree and secure-read checks. The new reconciliation path
  requires the copied supervisor's fixed activation-bound `REAPED` response, zero live processes
  and successful exit before restore. Uncertain ownership retains recovery evidence. Protocol
  fixtures are not active Endpoint Security or real installed-update proof. Source re-review found
  a major PID-ownership defect: a valid response followed by a nonzero child exit could reach
  cleanup after reaping while retaining the numeric PID, risking a signal to a reused PID. The
  subsequent fix revokes PID authority immediately on reap or `ECHILD`. Regression cases assert
  zero cleanup signals after valid-response/nonzero or signalled exits, and exactly one bounded
  signal for a still-owned hung child. Independent native quality replay and source re-review
  approved this repair with zero findings. Production KHA1 remains disabled.
- Documentation: five release-documentation tests passed; ADR index (158), portable manifest example
  (one), launch/setup documentation validator, scoped Prettier and diff checks passed. These gates
  validate their named document/schema surfaces only.
- Canonical support replay: the complete `support-analyze.test.ts` and `support.test.ts` suites
  independently passed 124 tests in 34.00 seconds. This covers their existing writer/parser/CLI
  composition, not a real native update timeline or historical journal migration. Independent
  performance review confirmed a major repeated-full-log-scan regression: both distinct candidates
  and reverse-ordered descendant chains scale quadratically. Lead development measurements scaled
  from 54 ms / 1,000 candidates to 658 ms / 4,000 candidates; the reviewer reproduced that scaling.
  The disjoint repair now builds those indexes once and uses `(pass, fileIndex)` priority traversal
  to preserve prior fixed-point correlation discovery order. Independent replay of both complete
  support suites passed 128 tests in 51.12 seconds; independent source review approved the bounded
  repair with zero findings. Large distinct/reverse-lineage, cycle/shared-lineage and ordering
  regressions are included. Post-build timing remains to be measured; traversal remains proportional
  to each attempt's reachable graph/output, with heap/sort costs, not universally linear under
  arbitrarily shared lineage.
- The subsequent shared build exposed five strict-index TypeScript errors in the heap helper;
  passing Vitest/ESLint and the narrow source review did not prove compilation. The current sole
  implementation owner is assigned explicit index narrowing without weakening compiler settings.
  The tagged browser test did not execute because its web-server build stopped here, so this is
  not the intended missing-wrapper red result and no browser proof is claimed.
- The compiler repair now uses an explicit optional-index invariant guard; the owner captured
  `npm run build` passing in 18.2 seconds. Independent read-only benchmarking of rebuilt production
  analyzer output retained all 1,000 / 2,000 / 4,000 candidate attempts with five-run medians of
  5.3 / 7.4 / 12.5 ms, respectively. These synthetic analyzer measurements support the algorithmic
  repair, not native producer throughput. Independent post-compiler replay then passed both complete
  support suites: 128 tests in 23.31 seconds. The owner subsequently captured scoped Prettier
  write/check and ESLint passing (combined exit 0, 6.1 seconds). Final integrated-head verification
  remains required.
- The first real-wrapper Chromium run reached the browser but timed out before session creation:
  actual preflight showed a manual/no-candidate path, so no outage assertion ran. This is fixture
  diagnosis, not acceptance-level red-before evidence. Lead source review also found that manual
  manager construction bypassed default activity-log wiring and candidate/remediation composition.
  The fixture was changed to the existing production handler factory with only bounded facts,
  catalog/fetch and non-mutating runner inputs. The owner then captured
  `npm run test:e2e:update-ui-1696 -- --grep @real-bff-outage` passing: one Chromium test in
  35.5 seconds, exit 0. An actual HTTP 202 advances to `activating` / `mutation-started`; stopping
  the owned BFF produces a real outage while the UI retains progress. Restarting on the same state
  and port projects durable `restart-required` / `recovery-required`, and cleanup proves the port
  reusable. This is the post-interruption recovery outcome, not a forced pre-cutoff failure.
  Release metadata and approval-shaped fields are synthetic parser fixtures only, not genuine
  release-owner approval, production eligibility, or native N−1/N qualification. Subsequent cleanup
  hardening makes exact-owned stop unconditional after partial start or page-close failure and
  retains state if stop/port release cannot be proven. The owner's final replay passed in
  59.2 seconds; the lead independently replayed the frozen journey successfully (one test,
  1.1 minutes, exit 0). The owner also reports all 68 CLI UI tests and 141 CI/wiring tests passing.
  Independent harness/CI/compiler-guard source review subsequently approved the slice with zero
  findings. An initial objection to approval-shaped fixture fields was withdrawn after checking
  isolation, the synthetic reference, non-spawning runner and unchanged production catalog; adding
  a test-only eligibility bypass was not accepted. Final integrated-head evidence remains outstanding.
  The earlier build, scaffold and fixture failures remain non-regression evidence. A subsequent
  controlled historical-polling restoration now reproduces the product defect through this same
  real-BFF journey, as detailed below, and the exact restored implementation passes the same command.

### Real-BFF historical polling reproduction

The test engineer isolated the actual pre-fix polling/error behavior from
`acc990f1f:packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx:1459–1520`.
Only that production file was temporarily changed: the fixed 2.5-second interval and unconditional
refresh-error projection were restored, while current candidate claims, backend composition, test
fixtures, assertions and timeouts were retained. This is a selective historical-behavior replay,
not a claim that the entire old commit supports the newer backend contracts.

- Repaired pre-experiment file SHA-256:
  `e8bb5ce994dd80fa922afe935d82950036c50be7505d0b3c42b8850009f3b08d`.
- Temporary historical-polling file SHA-256:
  `44aa5bc838b823643336ee320ab3196ff2dc41b0528c7d92682e9ca4b2a17fcf`.
- Command: `npm run test:e2e:update-ui-1696 -- --grep @real-bff-outage` under the governed
  Node 24 toolchain, with `NODE_OPTIONS=--max-old-space-size=8192`.
- Red: the unchanged journey reached accepted `activating` state and visible progress, then stopped
  the actual BFF. It failed the reconnect-copy assertion at
  `tests/e2e/update-ui-1696.spec.ts:1426` after the unchanged 20-second assertion limit (exit 1).
  The captured browser DOM showed `Update status unavailable`, `Failed to fetch` and `Check again`,
  with no progress/reconnect UI. This is the original observation-loss defect, not a fixture failure.
- Green: the repaired file was restored byte-for-byte and its original SHA-256 independently
  verified before and after the unchanged command. The journey passed (one Chromium test,
  1.6 minutes, exit 0), including reconnect, durable recovery and exact-owned cleanup. No historical
  UI code survives this experiment. This proof does not establish native updater qualification.

## Native qualification record

| Target      | Immutable N−1 / N inputs | Production-path result | Failure/crash result | Second restart | Protected canary |
| ----------- | ------------------------ | ---------------------- | -------------------- | -------------- | ---------------- |
| Windows x64 | Not recorded             | Not run                | Not run              | Not run        | Unavailable      |
| macOS arm64 | Not recorded             | Not run                | Not run              | Not run        | Unavailable      |
| macOS x64   | Not recorded             | Not run                | Not run              | Not run        | Unavailable      |

For each actual run, record exact source/target versions, release and asset identities, archive
digests, workflow/run attempt, application head, bounded outcome, and evidence location. Record
signing provider limitations without credentials, certificates, private paths, raw logs or control
capsules. Workflow declarations or skipped jobs do not populate this table as successful results.

A live GitHub recheck on 2026-09-05 still reports
[v0.3.17](https://github.com/oscharko-dev/Keiko/releases/tag/v0.3.17), published on 2026-08-22,
as the latest release. Its release description explicitly identifies evaluation artifacts without
Developer ID, notarization or a trusted Windows publisher. The signing epic
[#2198](https://github.com/oscharko-dev/Keiko/issues/2198) remains open and labelled ready for human
review. These observations do not inspect or establish protected credential availability, and do
not provide the two eligible production-signed inputs needed for canary qualification.

## Required browser and native harness integration

The existing `scripts/installable-package-smoke.mjs` and `scripts/installable-memory-smoke.mjs`
provide real packaged CLI start/health/restart/stop patterns and bounded owned-child cleanup. Reuse
those patterns for isolated state and same-port replacement; their sequential restart checks alone
do not prove native updater ownership transfer. The updater's current Playwright config already
starts the real CLI, but mocked `/api/update/*` responses must not establish the production journey.

The required CI workflow now invokes the tagged real-BFF updater journey in its existing browser
lane, and `docs/qa/unwired-e2e-suites.json` records this suite as `runs-per-pr`. The lead independently
ran `node scripts/check-e2e-suite-wiring.mjs`: PASS, with this suite included among 39 of 52 wired
suites. That gate proves reachability, not behavior or a completed GitHub run at the final head.
Supported target-native workflows must additionally exercise real N−1/N product bytes through the
production coordinator; the current disabled executor prevents claiming those results. No new
native handoff smoke command is recorded as available until its implementation exists.

Native crash-resume also needs an explicit discovery/entrypoint decision. After a coordinator crash
with the old BFF gone, the current normal launcher does not rediscover its activation capsule; the
existing resume modes require an already-running coordinator/supervisor and plan-bound descriptor.
Promotion currently renames the whole managed root before moving the candidate into place, so
entrypoint availability at that intermediate crash boundary must be addressed as well. An
architecture review found that launcher discovery or a fixed locator cannot repair an absent
registered entrypoint. A transient activation-specific supervisor watchdog could cover coordinator
process death, but cannot survive power loss or termination of every updater process. That distinction
prompted a scope question; the subsequent internal cutover review below provides a path to investigate
without requiring the operator to narrow the existing recovery guarantee.
No new locator, watchdog, service or broader execution authority has been approved, and KHA1
remains disabled. No existing crash-recovery acceptance criterion is considered satisfied by this
analysis or silently narrowed to process-only recovery.

A subsequent read-only scope review identified a possible internal repair within the existing
three-target installer/entrypoint contract: capability-gated atomic whole-bundle exchange on macOS,
and an unchanged Windows launcher path with deterministic release-bound payload slots and a qualified
file-level launcher replacement. This reopens the assumption that a new product decision is
necessarily required; it is not approval of a layout change or proof that Windows replacement is
atomic. Exact legacy-layout compatibility, interruption/durability semantics, normal-startup recovery
and target-native verification remain under architecture review. No implementation or qualification
is claimed for either proposed cutover yet.

An isolated Windows feasibility probe now exercises `FileRenameInfoEx` with replacement/POSIX flags,
retained and delete-denying handles, invalid candidates, bounded owned-process termination and concurrent
readers. Its PowerShell parser, scoped diff check and 32 existing native-quality wiring tests pass
locally; the lead independently replayed those 32 tests in 4.69 seconds. Independent security review
found and repaired path-following writes, insufficient proof of overlapping readers and unsafe
lifetime after a reader timeout. Re-review additionally repaired the user-mode SDK constant names
and incomplete directory pin. Final independent review is APPROVE with zero findings; the lead also
replayed `x86_64-w64-mingw32-gcc -std=c17 -Wall -Wextra -Werror -D_WIN32_WINNT=0x0A00 -fsyntax-only`
against the probe. That is Windows-header syntax evidence, not an MSVC or native-execution result.
The isolated probe is committed at `bc36fabf05dd4b46187f1343609cddba06a8e710` and the existing
[CI workflow run](https://github.com/oscharko-dev/Keiko/actions/runs/33943078244) executed its scoped
`Cross-platform smoke (windows-latest)` job at this exact dispatch SHA. MSVC `/W4 /WX /analyze`
compilation passed, but the first runtime case failed before any post-cutover flush:
`success=0`, `flush-before=2/2`, `flush-after=0/0`. Closed step/error instrumentation is needed to
distinguish pre-call validation, replacement rejection and post-call verification; this output does
not yet prove the primitive unsupported. Manual-run jobs that explicitly check out `dev` are not
probe evidence. The protected-branch gate also rejects this isolated probe branch by design; it is
not being bypassed or presented as delivery CI. No native pass is claimed yet. The probe
uses known finite text bytes, so even a future native pass would establish only the tested namespace
behavior, not executable-image sharing, power-loss durability or a Keiko N−1→N journey. Production
layout work must also settle release-bound generation naming without a launcher/manifest hash cycle.

Diagnostic-only follow-up `af6683d5080adaed1f70b18a20bd433bf6e790d3` adds closed first-failure steps
and numeric Windows errors without changing authority, flags, assertions or timeouts. Lead source
review, cross-header syntax compilation, all 32 wiring tests (4.06 seconds) and diff checks pass.
[Diagnostic CI run 33943593019](https://github.com/oscharko-dev/Keiko/actions/runs/33943593019)
stopped at MSVC C6387 after expanded diagnostic control flow needed explicit null-handle guards.
Those conservative guards were added without suppressions in `a8407ab2c90f7f47e41934af976f5240fb8aefbb`.
[Its native run](https://github.com/oscharko-dev/Keiko/actions/runs/33943799268) compiled successfully
and reported `step=12`, `winerr=87`: the actual `SetFileInformationByHandle` call rejected a parameter
after preceding handle/identity checks passed. The controlled absolute-name/NULL-root encoding in
`9025e6fea7022f79abfda37006a6a155ea548a37` then passed the Windows job's complete native-quality
step in [run 33944080513](https://github.com/oscharko-dev/Keiko/actions/runs/33944080513), completed
at `2026-09-05T04:24:19Z`. The validated directory remains pinned and no authority, flags,
assertions or timeouts changed. Independent safety re-review is APPROVE with zero findings.
The completed Windows job log records `success=1`, `allowing=1`, `denying=1`, `invalid=1`,
`pre=1`, `post=1`, `contention=1`, `flush-before=36/36`, `flush-after=40/40`, and zero first-failure
step/error. The Windows job itself also completed successfully. This is scoped native/job success,
not an overall workflow or production update qualification.
Temporary `DEBUG-3405-cutover` instrumentation is removed in
`90786127283aac96b188689d1729313102b2c360`; against the initial probe, only the working target encoding
and explicit null-handle guards remain. Cross-header syntax, PowerShell parsing, all 32 wiring
tests and diff checks pass. [Cleaned-source replay 33944829956](https://github.com/oscharko-dev/Keiko/actions/runs/33944829956)
passed its complete native-quality step at `2026-09-05T04:40:49Z` on that exact head; the Windows
job also completed successfully. Its cleaned-source log confirms all seven cases passed and
`flush-before=36/36`, `flush-after=40/40`, without diagnostic scaffolding. Executable-image sharing,
power-loss durability and the actual Keiko N−1→N journey remain unproven by this finite text-byte probe.

The subsequent build review proposes an acyclic final-byte binding: finalize/sign/attest the inner
generation first, including its final activation document, then hash that closed directory and use
the digest as its directory name. The root launcher, root setup metadata and support shim are outside
that hash. Compile/sign the root launcher with the literal generation ID only afterward; the outer
manifest, reviewed binding, provenance and final archive then bind both the generation and launcher.
No final generation digest is stored inside the hashed directory. This supersedes the preliminary
build-input-derived naming suggestion; it remains a proposed implementation, not verified packaging.
Legacy flat schema-1 records must remain explicitly distinguishable from new slotted records, and
the binary handoff plan must version its added fields instead of repurposing whole-tree digests.
An actual compiled launcher/process-image/health proof is still needed beyond the text-byte probe.

The implementation trace found that the existing digest producer is **KHT1**, shared by
`update-portable-handoff-builder.ts` and `keiko-portable-tree-hash.h`; the proposed KGT1 name did not
refer to implemented code. The Windows generation adapter will reuse the existing KHT1 framing
and resource limits. A generation-directory digest remains a separately named binding from the
whole-root candidate digest. The legacy launcher build remains explicit in behavior: absence of
the generation define selects the existing flat layout, while a defined generation must validate
and may never fall back to flat files. The native launcher/tree-hash slice is in implementation;
Windows packaging and CLI installation-root/resource-root separation remain integration work.

The Windows launcher/KHT1 adapter is now source-frozen for security review. It selects only a
compiled 64-lowercase-hex generation, retains file and directory handles through hashing and the
bootstrap CLI lifetime, and preserves legacy behavior when the generation define is absent. This
does not cover the detached BFF lifetime: the CLI returns after startup health and the launcher then
closes its handles. The lead independently
passed generation and legacy Windows cross-header syntax checks, Windows tree-test syntax, and the
unchanged POSIX tree-hash execution. The owner also reports successful PE cross-linking and macOS
launcher tests. These are not MSVC or Windows execution evidence; native dispatch, packaging and
CLI resource-root integration remain required. The verified cutover probe is integrated separately;
all 32 Windows quality-wiring tests pass (4.42 seconds), and the updater E2E remains `runs-per-pr`
under a green `check:e2e-suite-wiring` result.

Capture fresh design-system evidence under `docs/design-system/evidence/3405/`, including the
fidelity proof, axe proof, manifest/source hashes and all seven canonical modes, plus the applicable
responsive, reconnecting, progress and remediation states. Keep #1696's mocked visual evidence
historical. Neither copied screenshots nor a new directory without a genuine run settles this gate.

The first fresh capture run reached the configured 600-second timeout in
`keeps English and German update controls, focus, and live semantics in parity`, before any update
assertion. The browser snapshot showed the mandatory model-gateway setup dialog covering Settings:
the real BFF could not resolve the shared fixture's reference-only model configuration. No #3405
artifacts were emitted. The correction supplies a non-secret deterministic fixture value only in
the updater suite's server environment; it does not change shared model fixtures, product setup
behavior, update assertions, or mock the configuration/model routes. A read-only live BFF check
confirmed one fixture model after that correction. The next run exposed a second test-fixture
failure: its German Settings helper still clicked the English `General` label, while the rendered
button was `Allgemein`. The helper now takes the localized tab label without changing assertions
or timeouts. The next retained-session run exited 1 with three passing tests (English/German parity,
real-BFF outage and portable paths) and one failed capture test. The capture's deterministic
transport-failure fixture aborted initial session discovery instead of the first poll after start;
its state now arms the abort only after the accepted session POST. Those three passing tests alone
did not establish full-suite or artifact completion.

The next evidence-only locator repair scopes the reconnect assertion to its dedicated polite
feedback region while retaining exact reconnect text and progress assertions. An overlapping
verification invocation separately caused `EADDRINUSE`; structured logs identified both process
lifetimes and no product patch was made for that runner collision. With one runtime owner, the full
unchanged command passed **4/4 tests in 52.2 seconds**, exit 0. Fresh #3405 evidence generated at
`2026-09-05T05:00:23.720Z` contains 14 PNGs and three JSON documents; the lead verified all 17
manifest entries, all six source hashes and zero reported violations across 12 axe captures.
The [evidence README](../design-system/evidence/3405/README.md) separates mocked visuals from the
passing real-BFF journey. Historical #1696 PNG/JSON files are unchanged; only its README now points
to the current capture destination. Independent accessibility/fidelity review is running. Final
integrated-head receipts and native update qualification remain outstanding.

Independent accessibility/fidelity review then found two major evidence-integrity gaps and one
minor coverage gap. Current axe results are genuinely empty, but the generation gate filters out
moderate/minor WCAG violations; proof JSON bypasses the screenshot opt-in output policy, and the
source-hash list omits the CSS Module and API boundary. Keyboard coverage also needs the other
applicable controls and a true 320-CSS-pixel reflow assertion. These findings are accepted for
test-first repair and re-review. The passing run above is retained as scoped development evidence,
not final accessibility acceptance.

The repaired evidence harness is frozen at updater-spec SHA-256
`6fc627ce002ed6ad867367705d20cb51e1283b23e1aa35bceb22fe520a039b81`. Its first serialized
full replay exited 1: five tests passed and the capture test failed in 1.5 minutes. Both new
regressions passed (all WCAG impacts gate, and JSON/PNG share the opt-in output policy), as did
EN/DE parity, real-BFF outage and portable paths. The failing assertion expected Tab from the final
technical-details disclosure to remain inside the non-modal Update window. The test owner is
checking the actual forward/reverse focus targets before changing that assertion; the failure alone
does not prove a product focus defect. No final evidence set is claimed from this partial run.

### Native generation review repair checkpoint

Independent source review identified excessive recursive stack use in Windows tree enumeration.
The repair moves the bounded path buffer to heap storage and frees it before recursion. Compiler
stack analysis decreased the recursive frame from 66,288 to 752 bytes; a new test exercises all
128 allowed directory levels. The lead independently passed Windows cross-header syntax and
confirmed the frozen header/test hashes. Actual MSVC execution of this regression remains required;
compiler stack evidence is not native behavioral proof.

The review also identified scan-coherence gaps in the TypeScript and POSIX tree producers and
limits in the Windows protection lifetime and directory-membership coverage. The TypeScript
producer repair is assigned with a deterministic earlier-file mutation regression. Existing-file
handles do not establish perpetual tree immutability or prevent creating new child names. Windows
directory oplocks are not a blocking fix for membership changes: Microsoft's
[FSCTL_REQUEST_OPLOCK documentation](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_request_oplock)
states that these breaks are advisory and do not wait for acknowledgement. Final disposition must
prove the update's attestation-to-activation boundary without silently introducing a privileged
helper, a second lifecycle engine, or an unsupported same-user tamper-resistance claim.

Final security disposition confirms two medium findings: recursive stack usage and TS/POSIX
cross-file scan coherence. The reviewer withdrew the bootstrap/detached-lifetime and post-enumeration
new-name claims as security findings after reconciling them against #3404/#3405: the accepted
boundary is staging/promotion through activation, not perpetual resistance to an arbitrary
same-user writer. The corrected bootstrap-lifetime wording above is retained. Independent source
re-review of the stack repair is clean; native execution is still outstanding.

The Windows quality gate now explicitly compiles the generation-bound product launcher, executes
both legacy and generation launcher tests, and executes the KHT1 tree test including the 128-level
case. It retains the previous cutover/protocol/SHA checks and derives the product's subsystem,
entry-point and hardening flags. The owner recorded failure-first wiring checks, then 35/35 passing
tests and a clean PowerShell parse. These are wiring proofs, not native execution results.

The next UI replay passed five tests but exposed stale cancellation-title expectations in the new
keyboard fixture. After that harness-only correction, a targeted capture replay reached the full
WCAG gate and failed on an actual 320px defect: both horizontally scrolling manual-command code
blocks lack keyboard focus (`scrollable-region-focusable`, serious). The UI component owner is
repairing readability/keyboard access without weakening the axe rule. The harness is frozen at
`de2198206498829b8558f81539512ce507aff2137237dc8440d42eb3e1d942f4`; the failed run does not
produce a valid complete evidence set. The observed desktop notice overlaps the window at this
width, but the observation did not establish an obscured focused control; it is not promoted into
a separate confirmed finding without behavioral proof.

## Consolidation and public-boundary checkpoint

This is a development disposition map, not a completed deletion register. Reconcile it against the
final integrated tree and #3404's full inventory before closing the acceptance row.

| Boundary                      | Observed implementation                                                                                                     | Remaining disposition                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable activation authority | `update-portable-activation.ts` requires the coordinator; the old in-process activation fallback is absent.                 | Prove the replacement executor and all migrated consumers, including real native failure paths.                                                   |
| Version-only portable success | Lifecycle fixtures now consume durable proof projections; native recovery owns target verification.                         | Audit every production success path and complete real-process/version/second-startup proof.                                                       |
| Runtime state                 | `update-local-state.ts` migrates schema-1 runtime facts into the schema-2 aggregate without fabricating a terminal session. | Final-head migration/corruption tests and bounded compatibility/removal disposition remain required.                                              |
| Updater JSONL sink            | Current producer retired into canonical activity; existing files are bounded, read-only historical migration input.         | Reader/source recognition expires with schema-1 runtime migration and reviewed exclusion of all legacy-producing releases; see disposition below. |
| Server-root handoff exports   | The three new exported types are directly consumed by `keiko-cli/src/ui.ts`.                                                | Recheck assembled boundaries after final composition changes.                                                                                     |
| Candidate runtime subpath     | `runtime/update-candidate` supplies the schema constant to the candidate authority and local-state validator.               | Retain the used runtime boundary; do not confuse it with unused type-only barrel aliases.                                                         |
| Contract-root additions       | The eight unconsumed root aliases were removed; 11 new consumed aliases remain.                                             | Recheck the final assembled package boundary and all consumers after integration.                                                                 |

The eight removed contract-root aliases are `UpdateCandidateReleaseIdentity`,
`UPDATE_CANDIDATE_SCHEMA_VERSION`, `UPDATE_CANCELLATION_CUTOFFS`, `UPDATE_LIFECYCLE_PHASES`,
`UpdateRuntimeRecoveryState`, `UpdateRuntimeRecoveryStatus`, `UPDATE_ACTIVATION_WAL_CHECKPOINTS`,
and `UPDATE_RUNTIME_RECOVERY_STATUSES`. Their underlying declarations and used runtime-subpath
exports remain intact. The owner checked named, namespace and dynamic consumer forms before
removal and reports a successful contracts build, 15 package-surface tests and 49 package-surface
rule tests. Lead diff inspection confirms the eight aliases are absent. These development results
still require final integrated-head package verification.

Documentation closeout also explicitly includes `docs/design-system/update-experience.md`,
`docs/design-system/fidelity-matrix.md`, and `docs/qa/local-runtime-state-verification.md`, in
addition to the original nine contracts/runbooks and current evidence ledger. Those three documents
and the updater row in `docs/design-system/governance.md` now distinguish closed historical #1696
from the in-progress #3405 repair and its missing current evidence. The added updater owner row,
governance row, 11 referenced source/evidence paths, scoped formatting and diff checks passed.
Independent review approved the four documentation changes with zero findings.
Final proof links and executable statements still need to track the completed implementation.
The observability guide distinguishes the retired current producer from retained historical
migration input. Import results and the policy-bound retirement disposition follow below.
Migration must not equate a normal activity-sink return with durable import proof: the existing
file sink intentionally filters by level, reports and absorbs write failures, and its `flush()`
does not fsync. The source journal cannot be retired on that best-effort return alone. Legacy
records also lack candidate/session correlation fields, so migration cannot fabricate causal joins
or claim a complete historical attempt from version/timestamp proximity.
Architecture review traced exact managed predecessor termination and portable old-exit receipts,
but neither excludes an unrecorded direct or other-port legacy BFF sharing the state directory.
A stable source snapshot therefore grants no authority to delete the journal. The independently
safe implementation scope is bounded, idempotent canonical import under the existing logging policy,
with same-descriptor durability proof and unconditional source retention. Its frozen implementation
now passes an independent replay of 76 server tests (1.07 seconds) and 70 CLI tests (22.27 seconds);
owner server/CLI builds, scoped lint and formatting also pass. Independent security review found
three medium issues (URL/prose accepted in legacy fields, silent deferred outcomes and missing
fresh-process partial-tail recovery) and one low issue (descriptor leakage after exceptional source
reads). Regression tests failed before repair: nine strict-field cases, one deferred-warning case,
one fresh-module partial-tail case and two descriptor-cleanup cases. The frozen repair now passes
the lead's independent replay of 108 server tests (681 ms) and 72 CLI tests (14.51 seconds); owner
build/lint/format checks pass. Independent security re-review is APPROVE with zero findings;
initial green tests are not being substituted for these regression proofs.
The canonical operation catalog is regenerated with 246 entries; all 15 drift tests pass (4.54 seconds),
including `update.runtime.legacy-snapshot-imported` and `update.runtime.legacy-import-deferred`.

Independent architecture review settles this register item under the acceptance alternative
“explicitly justified”: the current JSONL producer is retired and consolidated into canonical
`logs/server.log` / `update.runtime.event`; existing files remain read-only historical migration
input, with no current writer or recovery authority. Import does not create a second state store,
invent causal joins, or authorize source deletion.

The compatibility reader and source recognition expire together with updater runtime-state
schema-1 migration, in a reviewed release-impact/support-baseline change that excludes every
release capable of writing schema-1 updater state or `update-audit.jsonl`. These surfaces entered
the shipped line together in `v0.2.12`. ADR-0099 defines `supportedFrom` as the reviewed compatibility
authority; the [release-impact runbook](../release/release-impact-runbook.md#catalog-rules) and
`scripts/check-release-impact.mjs` still require inclusion of the `0.2.0` baseline. No current policy
closes that window, so this disposition invents neither a date nor a removal release. At that
reviewed boundary, remove the importer, CLI startup seam, server exports, tests, operation-catalog
entries and historical-input guidance together with schema-1 runtime migration.

Physical unlink remains a separate data-safety action: durable import of an unchanged snapshot does
not establish exclusion of an older direct or alternate-port writer. Deletion needs both proofs or
an explicit reviewed support/retention decision. Until then, retaining the inert source is required.
The release owner's future baseline decision is not represented as completed qualification, and
this item does not settle the remaining deletion register or the epic's native proof requirements.

## Prepared release impact

This is feature-review metadata, not a published release entry or qualification claim. Under the
[release-impact runbook](../release/release-impact-runbook.md#feature-prs-and-release-cut-prs),
catalog insertion is deferred to the release-cut/metadata PR until the target package version and
genuine release-owner approval reference exist. Do not append this repair to already published
`0.3.17`, reuse an unrelated approval, or infer production one-click eligibility.
The unchanged current catalog passes `npm run check:release-impact`; that result validates existing
metadata only and does not grant approval to this prepared repair record.

| Field                          | Prepared value                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-visible change            | Explicit governed updates retain candidate identity and recoverable progress/outcomes, with truthful reconnect and manual guidance. This intended behavior still requires the proof listed above. |
| Category / priority            | `update-notes` / `high`; state-compatibility and security implications are described in the same record to avoid duplicate default bullets.                                                       |
| Release-note bullet            | Make Keiko updates recoverable, signer-rotation-safe, and natively verified across Windows x64 and macOS Intel/Apple silicon. Publish only after those claims are proven.                         |
| Affected state                 | Updater runtime-state schema, activation/recovery control data and canonical activity evidence; no customer content migration is claimed.                                                         |
| Supported-from                 | First release containing the completed repair and native qualification; exact package-version binding remains a release-owner decision. Earlier evaluation releases remain manual-only.           |
| User action / remediation      | A one-time manual evaluation-to-production installation may be required. Keep `manual-review-required` guidance until the verified transition and production canary establish a supported path.   |
| Approval / catalog disposition | Pending release version and release-owner evidence. Carry this prepared block into the final epic PR and the release-cut handoff; no approval or catalog insertion is claimed.                    |

## Final verification checklist

These commands are required evidence, not a claim that they have all run. Native qualification
commands and their owning required lanes must be recorded here once implemented; do not invent a
command or substitute a unit test for the missing harness.

- [ ] `npm run build:packages`; focused backend/CLI/security tests named by #3404/#3405.
- [ ] Focused API/Update window/startup notice tests and `npm run test:e2e:update-ui-1696`.
- [ ] `npm run portable:manual-review`, `npm run smoke:portable-launch-setup`,
      `npm run smoke:portable-secure-read`, `npm run check:portable-manifest`,
      `npm run check:portable-approvals`.
- [ ] Three target-native real-artifact lanes plus `npm run check:e2e-suite-wiring`.
- [ ] `npm run generate:op-catalog`, `npm run check:op-catalog`,
      `npm run check:error-observability`.
- [ ] UI workspace typecheck/lint, `npm run test:coverage:ui`,
      `npm run check:editor-release-evidence`, `npm run check:ui-i18n`.
- [ ] `npm run check:package-surface:assembled`, `npm run check:version-consistency`,
      `npm run check:release-impact`, `npm run check:release-alignment`,
      `npm run test:coverage:quality`.
- [ ] Root typecheck/lint/format/test/architecture/negative-architecture checks and a real
      production request-path smoke.
- [ ] Workflow/dependency gates when touched: `npm run check:zizmor-anchors`,
      `npm run check:dependency-currency`.
- [ ] `npm run gates:sonar`; document any unavailable local prerequisite honestly, never as a pass.
- [ ] Final SHA-bound verify, clean independent audit, runnable UI plan/receipt, required GitHub
      checks, and resolved review conversations.

Run the assembled package-surface aggregate after tests because it prunes the checkout's live
dependencies. Keep the supported toolchain and environment in the result record. Current `dev`
has advanced to `c5c03d48fa1066c985a656d29880ae1c02e68c48`; the clean epic branch now includes it in
`b76198dc2614dfe28214dc2e5f4dd2cf1e680cd6`. The child includes that integration in `78f52c774`,
with clean dependency refresh and package build passing. Final child and merged-epic verification
must still cover their actual delivery heads after the remaining implementation and review fixes.

## Handoff boundary

No child/epic completion is asserted by this ledger. Child integration requires real green receipts
and exact-head CI. The final epic PR targets `dev` for human review; the agent does not merge it.
Production-signed qualification remains explicitly external if the prerequisites are unavailable,
and the issue/epic must not be closed as production-qualified on that basis.
