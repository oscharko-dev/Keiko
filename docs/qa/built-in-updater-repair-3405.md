# Built-in updater repair evidence ledger (#3405)

Status: implementation and qualification in progress. This is not a clean-audit receipt or a
production one-click claim. Parent epic: [#3403](https://github.com/oscharko-dev/Keiko/issues/3403).
The [reviewed baseline audit](built-in-updater-audit-3404.md) defines the repair contract and deletion
register; the [issue](https://github.com/oscharko-dev/Keiko/issues/3405) owns acceptance criteria.

## Release-trust amendment (2026-09-10)

The release owner confirmed that no production-signed Apple or Microsoft qualification will be
available and that the updater must work without it. ADR-0121 D7 now makes a protected,
platform-neutral Ed25519 signature over the final API-bound manifest the mandatory update trust
anchor. Historical references below to production-signed canaries remain evidence of the prior
contract, not current blockers. Native verification is still strict when evidence is present, but
its absence no longer blocks stable publication or one-click update. The unchanged archive digest,
provenance, target, release-impact, containment, atomic activation, recovery, and exact-version
checks remain mandatory.

## Current delivery checkpoint (2026-09-10)

Delivery continues in PR #3456. The published-manifest verifier now requires the protected Keiko
Ed25519 trust root, while unsigned Apple/Microsoft platform status remains explicit and acceptable.
KHA1 dispatches the native coordinator on macOS and Windows; the shared engine, macOS mechanics,
Windows generation mechanics, and Windows crash-checkpoint recovery are wired into required native
quality lanes. Production staging runs on Windows x64, macOS arm64, and macOS x64 without signing
provider credentials. The browser evidence, source/harness freshness gate, durable startup refusal,
canonical activity logging, bounded downloads, tree identity, recovery outcomes, and deletion of the
obsolete JavaScript activation path are integrated as signed review checkpoints.

Final exact-head gates and GitHub CI are still in progress. A two-release native canary remains
release evidence to collect once two Keiko-signed eligible releases exist; it is not blocked by
#2198 and does not require Apple Developer ID, notarization, Authenticode, or an external signing
provider. No final one-click qualification or merge is claimed by this checkpoint.

## Historical checkpoint (2026-09-08; superseded by the owner decision above)

Later dated entries supersede historical failures below. The repaired restricted-token
Windows helper now passes the actual four-probe loader job and the C# analyzer job
in run [34216315755](https://github.com/oscharko-dev/Keiko/actions/runs/34216315755)
on `4028c1f83`. The full Windows native gate also passed on that exact head. The fix changes the
helper's derived-token default object DACL to the current user plus SYSTEM; it does
not change production trust or environment. Independent static review found no issues.

The canonical scripts run passed 4,438 tests (two skips). The refreshed UI coverage
run passed 7,519 tests (one skip). Package coverage passed 36,137 tests with one stale
generated-catalog failure; regeneration and all 15 catalog tests then passed. The
fresh reports meet every existing package, release, and per-file coverage floor.
The complete working-tree new-code measurement was 83.363%, below the unchanged
85% bar. The focused failure/recovery tests described below address that gap before
the final canonical rerun. They exposed a terminal-session recovery write rejection.
The narrow completed-WAL settlement repair now passes 84 focused tests and independent
static review with zero findings. A broader current-source run passes 561 updater tests
(two platform skips) across 38 suites. Its provisional coverage union measures 84.869%;
the final generator-input tests then bring the provisional union to 85.387%, above
the unchanged 85% threshold. Fresh canonical coverage still must confirm it. The full
Update window suite now passes all 55 tests.

The isolated updater browser suite passed 8/8 in 58.6 seconds with all 12
source/harness hashes verified; accessibility/design-system review found no issues.
The permission timing/matcher regression is fixed. Full repository/UI lint, the root
TypeScript no-emit check, and full formatting now pass. Complete final verify,
canonical coverage, and required CI remain outstanding. The unapproved functional-native-proof
proposal and unavailable local Sonar image access remain explicit prerequisites;
genuine production-signed canaries remain external. No final audit receipt, ready
status, or merge is claimed.

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
confirmed findings. That prerequisite did not settle normal-startup recovery or real installed
two-process proof; the subsequent recovery review and repairs are recorded below.

The Mac normal-startup slice was frozen in `a4c2dbd9f` for independent security review. Its early CLI
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
15 drift tests (4.49 seconds). Those owner results required the package rebuild and independent
review recorded next; final integrated-head proof remains required and KHA1 is still disabled.

On integrated commit `78f52c774`, clean `npm ci` completes with zero reported vulnerabilities and
`npm run build:packages` passes using Node 24.18.0/npm 11.16.0. Independent replay passes all
68 tests in the seven complete local-state, normal-startup, handoff, production-handoff,
handoff-recovery, session-lock-recovery and activation suites (18.19 seconds). The sequential CLI
lifecycle/portable replay passes all 142 tests (34.47 seconds); macOS arm64 native quality also
passes its compiler, analyzer and boundary checks.
The first independent review identified two medium recovery gaps despite that green
replay: a lone durable prepared receipt before native acceptance cannot settle on retry, and
timeout teardown can replace the child PID before confirmed native exit. A dedicated owner repaired
those gaps with additional crash/teardown regressions and distinguished the unreleased KUR1 recovery
control from the unchanged binary supervisor KRC1 protocol. That review reported no critical, high
or low findings. The resulting four-file repair was frozen for independent re-review. It attests the old tree and
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
hashes. The independent arm64 native replay also passes. The reviewed repairs are preserved in
`8dacddb02`; later integrated delivery verification and
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

The shared KHT1 extraction is now frozen and independently security-approved with zero findings.
One IO-request state machine preserves grammar, budgets, identity/link/mutation checks and cleanup;
the server driver retains asynchronous filesystem operations. Security typecheck, scoped lint/format
and built subpath import pass. Owner and lead each pass all nine shared tests; the lead additionally
passes five selected existing server tree regressions with one explicitly filtered plan-builder
case (12.04 seconds). Full server typecheck remains pending the concurrent B2 plan/builder fields;
its observed failure is not counted as green. The CLI now invokes the synchronous attestor directly
and removes the B1 regression that read the entire Node executable for presence/type-only checks.
Independent security review identified an additional medium availability defect in the new root
launcher/support checks: unbounded reads could exhaust memory. The repair streams launcher hashing
in 64 KiB chunks with a 64 MiB ceiling and shares one absolute deadline with generation attestation.
Canonical support validation reads only its exact expected size, checks immediate EOF, and rechecks
file identity and metadata; a lead-identified growth race after the initial size check is covered by
a deterministic regression. Owner checks pass 22 installer tests, scoped lint and formatting.
Independent security re-review approves the final two files with zero findings. The lead confirms
both frozen source hashes and passes all 31 installer/shared-attestor tests (2.31 seconds), including
oversized sparse files, support growth, bounded hashing and deadline rejection. These checks do not
substitute for final assembled-package or native platform qualification.

The shared KHP fixtures are frozen under `native/portable-launcher/fixtures/`. Independent decoding
confirms Mac KHP2/32 (1,282 bytes; SHA-256
`40623f9023666e9101b7fbedd0038da372cd6dd8eb5ee224c4f3671413cd1e3f`) and Windows KHP3/37
(1,540 bytes; SHA-256 `957ad255b762f2f6d4aaaffad29b64838b9005883228d97da13ebaf9e309fdd7`).
The lead plan-suite replay passes 22 tests with one explicit Windows-host encoder-equality skip
(13.30 seconds). Mac prior/new encoder equality and Windows field-order assertions run locally;
the Windows equality must run in its genuine host lane. A formerly silent early return was changed
to an explicit skip, and a required Windows CI step is being added. Native code consumes the
TypeScript-owned fixtures read-only; local fixture proof is not native replacement qualification.

The B2 plan/capsule slice is frozen for independent static security review. Owner checks pass
112 core/wiring tests with one explicit Windows-host skip, 26 adjacent handoff tests, scoped
lint/format and the final server typecheck. Earlier attempts failed on a stale flat fixture path,
15 lint findings, a `lstatSync` return type, and an unresolved shared-security subpath before its
approved build; those attempts are not green evidence. The lead independently passes the initial
111-test core/wiring batch with one skip (16.17 seconds), the final seven-test active-binding suite
(13.41 seconds), and all 27 Windows parser/staging/rename tests (14.05 seconds).
The broader Mac recovery replay then fails five tests with 23 passing (15.26 seconds): two
normal-startup and three production-handoff fixtures now return recovery-required after the new
active setup/launcher checks also apply to Mac. The checkpoint is held for contract-preserving
repair and independent re-review; the narrower green runs do not settle this regression.
Static review confirms that Mac behavior regression and a second medium availability finding:
the new Windows active-registration check reads setup/launcher bytes without bounds before its
caller reaches bounded KHT1 attestation. The owner repairs both findings: Mac keeps its reviewed
schema-1 authority, while Windows setup reads are capped at 64 KiB and launcher hashing streams
64 KiB chunks with a 64 MiB ceiling under one 15-second deadline. No-follow/single-link reads and
identity, size, mtime and ctime checks reject oversized, changed and rebound files. Independent
security re-review approves the production repair with zero findings. Initial adversarial tests
fail three cases because their copied fixture is read-only; only temporary fixture permissions
are corrected. A later official-Node replay passes 38 tests and fails two because copying that
120,965,360-byte executable exceeds the deliberate native ceiling. The unit fixture now uses
deterministic bounded launcher bytes; its existing mocked process/verifier boundaries and real
capsule operations are unchanged. The lead verifies final source/test hashes and independently
passes all 40 activation, normal-startup, production-handoff and recovery tests with official
Node 24.18.0 (14.28 seconds). The five Mac regression cases pass unchanged. Scoped lint/format,
server workspace typecheck and B2 test typing fixes are green. This reviewed development checkpoint
does not settle B3 consumers, root-wide test typings or native replacement qualification.

The CLI registration/selected-generation maintenance slice is frozen for independent security
review. Strict Windows schema-2 records bind setup, launcher, root and generation identities;
historical flat schema-1 records remain readable but always project manual-only eligibility without
rewriting stored bytes. Failed generation setup retains its attestation through real KHT1 recovery.
The lead verifies the frozen hashes and passes all 72 registration/install/shared/maintenance/
rename-backoff tests (1.68 seconds), then all 89 portable lifecycle tests under the default timeout
in a quiet execution lease (17.40 seconds). Earlier shared-load runs exceeded one existing test's
15-second timeout; the owner's 30-second override run is historical, not the final default result.
The owner's CLI workspace typecheck and scoped lint/format pass. Active-WAL maintenance allowances
and startup transport remain a subsequent integration tranche.
Independent review finds one medium production-shape gap: the selected-generation allowlist omits
`runtime/native/keiko-runtime-attestation.exe`, which the production signing pipeline stages and
fresh qualification executes. Valid production installs would therefore fail maintenance/recovery
inspection. The source owner adds that exact path and its fixture while retaining all unknown
entry and retained-generation rejection checks. Independent re-review approves with zero remaining
findings. The lead verifies the repaired hashes and passes all 18 maintenance tests again
(422 milliseconds). No active-WAL inspection or deletion authority is introduced by this repair.

The subsequent CLI active-WAL inspection allowance and startup transport are implemented across six
files. The allowance is validated and consumed only inside the live managed-mutation lock callback;
its inspection capability expires when the callback returns or rejects. Exact generation/incoming
roots are bounded, and generic removal retains selected-generation-only authority. The lead passes
all 93 portable lifecycle tests under the default timeout (16.90 seconds) and 46 focused install/
maintenance tests (1.27 seconds). Independent security review finds no security issues but catches
one test-only TypeScript closure narrowing error. The owner fixes it without a cast or suppression,
passes all 26 install tests (1.49 seconds), and independent re-review approves with zero findings.
The lead's root no-emit replay confirms that error is gone; four server test typing errors remain
in the pending startup/integration scope. This CLI transport does not itself produce server WAL
allowances or authorize the unfinished native startup path.

The B3a server generation consumers freeze separately across 14 source/test files. Canonical package
layout authority feeds staging, install detection, preflight and production runtime roots. Windows
launcher hashing streams bounded chunks, and control reads enforce finite limits and pre/post-read
identity checks. Historical flat Windows registration remains readable and ineligible; macOS schema-1
behavior is preserved. After a worker accidentally invokes pnpm and disrupts the npm dependency
tree, the lead restores the committed lock with official-Node `npm ci`: 783 packages, 809 audited,
zero vulnerabilities, 16 seconds, no tracked package/lock changes. The lead verifies all 14 frozen
hashes and passes the final nine-suite aggregate, 170 tests (24.17 seconds). The owner reports server
workspace typecheck and all 14 scoped lint/format checks green. Independent security review finds
zero critical/high/medium issues and three low issues requiring repair: mapped network drives are
not excluded by lexical root policy, production runtime discovery omits setup runtime platform/CPU
validation, and its new root setup/launcher reads lack descriptor-bound size/deadline enforcement.
The latter reads are distinct from the already bounded install-mode detector. The runtime owner
repairs exact platform/CPU validation and adds 64 KiB descriptor-bound setup reads plus 64 MiB
launcher streaming under a five-second deadline. The lead passes 72 runtime tests (14.43 seconds),
including sparse oversized files, malformed metadata, links and identity drift. Independent
security re-review settles those two findings with zero residual issues. Network-root locality
remains the sole open low B3a finding and has a separate native/CLI/server integration plan. B3b
startup/recovery consumers and final root-wide verification remain outstanding.

Native filesystem mechanics are snapshotted separately in diagnostic commit
`8e1ffb09c492eed84f3879dcd957a34f395014c9`, based on reviewed child checkpoint `52ac76881`.
The lead verified all 17 copied file hashes. Local owner evidence includes Mac focused protocol/
recovery tests, production launcher compilation and MinGW syntax/link checks for Windows sources;
none establishes Windows runtime behavior. Initial native wiring verification failed one of 35
tests because its compiler-argument extractor stopped at a nested array. The hardening flags were
present in production. The repaired extractor balances arrays and quoted brackets, retains the
adversarial flag checks, and passes all 36 tests in the lead replay (4.94 seconds). A genuine Windows
diagnostic is dispatched in [run 34140199765](https://github.com/oscharko-dev/Keiko/actions/runs/34140199765);
the Windows job fails MSVC analysis on a nullable cleanup handle. The owner repairs that guard
without suppressions, and a header-only diagnostic checkpoint `8e450d0de` is dispatched in
[run 34140647807](https://github.com/oscharko-dev/Keiko/actions/runs/34140647807). It fails on three
further cleanup guards with the same nullable-handle root cause. After the full nullable-handle
repair, diagnostic `73291ae3c` runs in
[run 34141479042](https://github.com/oscharko-dev/Keiko/actions/runs/34141479042) and fails MSVC C6001
on receipt-handle cleanup. The owner separates handle closure from the short-circuit expression
and invalidates the consumed handle; diagnostic fix `23185ac11` uses no analysis suppression.
All three actual native failures are retained; the remaining workflow jobs are cancelled after
the target job finishes. The diagnostic integrates reviewed B2 checkpoint `a7eb2437f` in
`b0ab2bc87462a366c66c082e49199b4f53f7f3a5`, including the Windows encoder-fixture CI step.
Before another dispatch, lead review also requires temporary-file cleanup to remove only files
created by that invocation and generation copies to enforce the KHT1 entry/path/byte budgets
during traversal. Pre-copy retained handles and post-copy hashes do not alone bound newly added
directory members. The copy repair is snapshotted in `a5caf6aaf`; its
[run 34143450298](https://github.com/oscharko-dev/Keiko/actions/runs/34143450298) stops before native
analysis at the newly integrated Windows TypeScript plan suite: 24 tests fail. The Mac golden fixture
uses POSIX absolute paths on Windows, Git converts the hexadecimal fixture to CRLF, and real plan
publication reaches unsupported directory `fsync` with `EPERM`. The last failure is a production
persistence gap, not merely a fixture failure; plan and receipt publication must preserve file flush
and atomic publication while following the existing Windows directory-refusal policy. No native
analysis or runtime result is available from that run. The remaining jobs are cancelled. The
diagnostic also exposes stale
root-test typings; green workspace typechecks did not cover those tests. Windows process/supervisor
callback integration remains in progress and
KHA1 remains disabled. This branch is neither delivery-head CI nor native N−1/N qualification.

The full native Windows callback implementation then freezes for separate independent security
review. The lead verifies all 16 source hashes and replays macOS arm64 native quality successfully.
The owner also reports 36 wiring tests, MinGW warning-clean cross-compilation and GCC analysis
passing. These checks cover source/compiler boundaries only. The full callback snapshot awaits
the Windows plan/receipt repair before another real Windows diagnostic. The Windows coordinator
entry remains fail-closed without production KHA1 acceptance.
The next diagnostic, `b93a4894d` in
[run 34145519032](https://github.com/oscharko-dev/Keiko/actions/runs/34145519032), includes the full
native callback snapshot and the shared handoff directory-sync repair. Its Windows handoff suites
pass 39 tests and fail two, with one explicit Mac encoder skip. Windows encoder equality and real
plan/receipt publication now pass. The two static symlink fixtures expose reliance on ineffective
Windows `O_NOFOLLOW`: readers reject the link only after reading through it. The repair must reject
the named unsafe entry before opening/reading and bind the opened descriptor to that precheck;
relaxing the expected error or skipping the cases is not an acceptable fix. Native analysis remains
unreached, and the remaining workflow jobs are cancelled.

Independent native review also identifies a medium durability gap: production file replacement
does not perform the ADR-required post-cutover flush, although the separate probe does. That finding
requires the productive helper and its failure-boundary tests to be repaired before acceptance.
Its final report has one medium and two low findings: the missing post-cutover flush, an unpinned
intermediate receipt directory permitting junction redirection, and synchronous pipe writes that
can outlive the plan deadline when a trusted child stalls. No critical/high finding is reported.
The native owner is repairing all three; the common Mac ordering and Windows generation-prefix
logic otherwise survive the static review.

The pre-read link repair runs in diagnostic `b22e8ed4f`,
[run 34146159822](https://github.com/oscharko-dev/Keiko/actions/runs/34146159822). All 41 Windows
plan/receipt tests pass with one explicit Mac encoder skip (12.08 seconds), including canonical
Windows encoding, real persistence and unchanged symlink-rejection assertions. Native analysis is
now reached and fails MSVC C6262: the new launcher resume function uses 197,768 bytes of stack.
That requires bounded heap ownership, not an analysis suppression or raised stack budget. The
native runtime stage remains unproven; other workflow jobs are cancelled after the Windows failure.

Diagnostic `182a76e7c`,
[run 34146945279](https://github.com/oscharko-dev/Keiko/actions/runs/34146945279), passes all 41 Windows
plan/receipt tests with one explicit Mac encoder skip (13.41 seconds). Both launcher variants pass
MSVC analysis. The real cutover probe passes success, allowing/denying handle sharing, invalid
input, pre/post-cutover failure, contention, and flush fault boundaries (36/36 before, 40/40 after).
The job then fails MSVC C6262 in the coordinator test fixture's 65,548-byte stack allocation. This
is a partial mechanics result, not a green Windows job or end-to-end native qualification.

The owner freezes all three native review repairs plus bounded heap fixtures in a verified 17-file
snapshot. The productive replacement helper binds and flushes the renamed destination; capsule and
receipt directories remain pinned; supervisor writes use nonblocking pipe mode with process and
deadline checks. Owner macOS native quality, MinGW analysis/link checks and 95 official-Node wiring
checks pass. Independent security re-review is pending. The snapshot is dispatched in diagnostic
`7e99e81d6`, [run 34149173415](https://github.com/oscharko-dev/Keiko/actions/runs/34149173415), for actual
Windows MSVC analysis and runtime execution. Its 41 plan/receipt tests pass, but the cutover probe
fails at the post-termination scenario. The retained new-source writer conflicts with the helper's
new post-rename reopen sharing flags; aggregate success and later contention checks consequently
report false. Independent review confirms that medium correctness regression, closes the receipt
parent-pinning and nonblocking-write findings by static/API review, and requires separate durable
rename/flush and exclusive productive digest ownership. The repair is in progress. KHA1 remains
disabled; no green Windows job or native N−1/N result is asserted.

The next native repair separates durable rename/flush from exclusive productive digest authority.
Diagnostic `00b56e4ef`,
[run 34150171223](https://github.com/oscharko-dev/Keiko/actions/runs/34150171223), passes all 41 Windows
plan/receipt tests (one Mac encoder skip), the complete cutover probe (all success/handle/crash/
contention cases, flush-before 36/36 and flush-after 40/40), and coordinator MSVC analysis. The
coordinator executable then fails its unchanged KRP1 packet-kind assertion. The Windows encoder
sets version 1 but omits launch-request kind 1; the existing supervisor correctly rejects zero.
This is a production encoder defect, not a fixture expectation to relax. The remaining jobs are
cancelled after that native failure, and the encoder repair is pending.

A broader root lint replay at the B3 checkpoint reports 26 errors and no warnings, all in the
updater repair. Fourteen belong to the handoff receipt source/tests; the remaining twelve cover
candidate tests, activation factoring, native-verifier typings, remediation and session tests.
The UI lint stage is not reached. Scoped owners are repairing these without suppressions; this
failed diagnostic is not a final lint or verification receipt.

The KRP1 request-kind fix changes one production byte assignment and passes independent review
with zero findings. Diagnostic `bf2862b5b`,
[run 34150829494](https://github.com/oscharko-dev/Keiko/actions/runs/34150829494), passes the packet,
nonblocking-pipe, generation publication, productive cutover/flush and recovery assertions, then
fails the final capsule-directory positive fixture's ownership/ACL check. The existing junction
refusal succeeds. Test-only, body-free ACL classification is frozen in diagnostic `604f9738d` to
identify the exact failed permission predicate; production ownership policy is unchanged.

The handoff receipt refactor clears its 12 source and two test lint findings while preserving
canonical bytes, pre-read link rejection, descriptor/name identity, bounded reads, hardlink ACK
reconciliation, sequence/hash-chain authority, fsync ordering and cleanup exception precedence.
Independent security re-review approves the exact frozen source/test with zero findings. The lead
passes all 41 plan/receipt tests with one explicit Windows encoder host skip (21.16 seconds); the
owner also passes 13 receipt tests, server workspace typecheck, scoped lint and formatting. The
remaining twelve broad-lint findings have a separate narrow owner. The outstanding CLI update-test
type import is also replayed independently: all 14 existing tests pass (1.18 seconds).

The diagnostic editor-evidence mismatch is independently traced to the local Node distribution's
zlib. Homebrew Node 24.18.0 reports zlib 1.2.12; the checksum-verified official Node 24.18.0 binary
reports 1.3.1-e00f703. Measuring the same already-built JavaScript with the official binary produces
CI's exact fingerprint `63a3cb02c83e260cdf38599c08596ed1ff6b603fb09ed15dc5e953d9b572103d`.
The committed evidence is regenerated with that runtime and its check passes: zero first-load
Monaco markers, 1002.6 KiB shipped lazy runtime against 2560 KiB, and 110.1 KiB largest worker
against 750 KiB. No UI bytes or budget guard are changed. Subsequent final evidence commands use
the official Node distribution; earlier Homebrew-derived measurement results remain historical.

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

The first Windows consumer slice is frozen as a development checkpoint in ten CLI/staging/parser
files. It binds strict outer/provenance/reviewed schema-2 generation copies to extracted setup,
selects the generation resource paths, verifies root launcher/support and closed-generation KHT1,
and rejects unsafe links, rebound authority and extra generation content. CLI schema 1 remains
launch/manual compatible. Owner verification passes 190 tests in 12 affected files, CLI and server
workspace typechecks, scoped lint, format and diff checks. Earlier attempts remain red evidence:
one mutation fixture failed at JSON parsing before the intended KHT1 check (moved to a non-PE file),
one broad test exposed a changed malformed-schema diagnostic (restored), and CLI typecheck exposed
type-narrowing/fs-overload errors (repaired before the green serial replay).
This slice is not accepted as complete: direct CLI KHT1 attestation has passed its shared-security
extraction/hookup review, while staging review, registration v2, maintenance, handoff and native cutover
remain subsequent integration work. Native implementation has a separate file owner after the Mac
reviewed checkpoint; its KHP3 parser must consume the TypeScript owner's frozen byte fixtures.

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

### Historical native proof proposal (superseded 2026-09-10)

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

## Historical acceptance evidence map (superseded 2026-09-10)

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

## Historical native qualification record (as of 2026-09-05)

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

The required CI workflow invokes the tagged real-BFF updater journey in its existing browser lane,
and `docs/qa/unwired-e2e-suites.json` records this suite as `runs-per-pr`. The wiring gate proves
reachability, not behavior or a completed GitHub run at the final head. KHA1 now invokes the native
executor and the native quality lanes exercise its transaction order and platform mechanics.
Supported target-native release workflows must still record real N−1/N product-byte results through
that coordinator; declarations, fixtures, or skipped jobs cannot be reported as those results.

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

## Remaining lint repair checkpoint (2026-09-07)

The remaining twelve lint findings were repaired in six server files. Production changes only
factor handoff capability validation and plan preparation without changing durable operation order,
and add an explicit native-verifier callback return type. Test changes replace unsafe assertions
with existing guards and type the mocks. Two remediation restart fixtures now use a valid stale
ISO timestamp instead of the invalid literal `stale`; the production state validator and restart
assertions remain unchanged.

The lead independently reviewed all six diffs and replayed candidate authority, native verification,
remediation, session, and activation suites with official Node 24.18.0: **92/92 tests passed in
12.97 seconds** (`/tmp/keiko-3405-six-lint-fixes-root-replay.log`). The owner's scoped lint passed
with zero findings. This checkpoint does not replace the pending full lint, verification, or audit.

## Startup and Windows boundary verification checkpoint (2026-09-07)

The lead's official-Node replay of eleven startup, recovery, generation-allowance, CLI root-policy,
security helper, install-mode, and runtime suites passed **148/148 tests in 45.98 seconds**
(`/tmp/keiko-3405-b3b-locality-root-replay.log`). Subsequent test-only typing repairs preserve the
lock-acquisition assertion order and the local-state writer's returned state; the owner replayed
both affected suites with **68/68 tests passing**. Canonical package build and package-graph checks
passed, followed by a successful root TypeScript 7.0.2 no-emit replay
(`/tmp/keiko-3405-b3b-root-noemit-replay.log`). UI lint passed separately. Broad lint reduced the
previous twenty-six server errors to four errors in the new locality helper and its test; those
remain part of the helper repair. None of these results is a final SHA-bound delivery receipt.

Windows diagnostic `eee979c77`, run `34153165932`, passed the complete native coordinator test,
including the ACL owner fix, and the real cutover probe with all success/sharing/invalid/pre/post/
contention checks and flush boundaries passing. It then failed MSVC C4996 in the protocol fixture's
`fopen` call. The checked MSVC-specific `fopen_s` test repair is frozen and pushed as diagnostic
`d8b199b6e`; run `34153596557`, Windows job `101840774198`, subsequently reported the entire
**Verify productive native sources on Windows** step successful. This covers compiler/analyzer,
cutover, coordinator, protocol and later native boundary fixtures at those exact frozen bytes.
The fifteen changed native/script files are checkpointed from that diagnostic commit without
including the concurrent locality work. The overall job/workflow is still pending; no full CI pass,
new locality proof, or production-signed update qualification is inferred.

Independent security review confirmed a High defect in the uncommitted local-volume helper:
PowerShell 5.1 CodeDOM scratch storage inherits an environment-selected temporary parent's ACL,
which permits cross-user compiler-artifact replacement when that parent is shared. The accepted
repair removes CodeDOM and filesystem scratch entirely through transient Reflection.Emit P/Invoke.
It requires a fresh independent review and genuine Windows local-volume and mapped-SMB evidence.
Native setup/coordinator directory pinning is being implemented in parallel. Production eligibility
and KHA1 remain disabled, and the real-artifact qualification decision remains unresolved.

## Windows local-volume TypeScript repair settlement (2026-09-07)

The scratch-free helper received independent security approval with **zero findings**. The prior
High CodeDOM artifact-replacement issue is closed: fixed `kernel32.dll` P/Invoke methods are emitted
only in an `AssemblyBuilderAccess.Run` assembly, with no compiler files or temporary-directory
environment. The existing identity-resolved PowerShell executable, exact output protocol, bounded
stdin/output/time, native-buffer cleanup, canonical-path check and local drive types 2/3/6 remain.
CLI policy, install-mode detection and runtime discovery check the lexical root before realpath.

Reviewed source SHA-256: `b3237c3825f091c82cbe31f4fbc4a95cdcb6a3f6fe1b452d17dbc0fa049ca955`;
test SHA-256: `4c124d3ab2553ab088a03af54573cbe1851e9c13e95566b769ff95d7c564061a`.
The lead rebuilt the security package with the canonical compiler, replayed five affected suites
(**83/83 tests passed, 18.51 seconds**), and ran scoped lint and root no-emit checks successfully.
The subsequent complete `npm run typecheck` also passed with official Node 24.18.0 and compiler
7.0.2 (`/tmp/keiko-3405-current-canonical-typecheck.log`). Actual Windows PowerShell 5.1 and mapped
SMB behavior remain pending in the native locality diagnostic; static approval is not that proof.

## Windows startup recovery review settlement (2026-09-07)

The twelve-file Windows generation startup/recovery slice received independent security approval
with **zero findings**. The review traced canonical receipt validation and WAL anchoring before
phase-specific inspection allowances, exact generation/setup/registration/launcher attestation,
Windows `coordinator.exe` selection and unchanged KUR1 raw-state/lock binding, observed native exit
versus ambiguous teardown, and retention of verified N. It confirmed that macOS continues using
its whole-root attestation and that no package-root export exposes the new internal allowance.

The reviewed normal-startup test hash is
`56ceaeaba86ede05781ca397f7e773e669412f25bfec24deabd6e3e854d3361f`; the other eleven reviewed
files match the frozen B3b slice. The lead's 148-test combined replay, the owner's final 68-test
startup/session replay, and the now-green complete canonical typecheck support this checkpoint.
Native process seams in these host tests are unit/integration fixtures, not real-artifact updater
qualification. Final integrated verification, issue audit and platform evidence remain required.

## Broad integration repair checkpoint (2026-09-07)

The complete root test run finished with **36,085 passing, 10 failing and 27 skipped tests** across
1,811 files in 1,455.79 seconds (`/tmp/keiko-3405-integrated-full-test.log`). This is a red run,
not a verification receipt. The unrelated wide-root fixture failed only its 10-second cleanup hook
under concurrent load; an isolated replay passed with unchanged timeout settings in 7.66 seconds.

Three route assertions now prove that the manager receives the response's server-generated UUID
correlation rather than a body-selected request ID. The hostile-shortcut test isolates and observes
its local-volume prerequisite while restoring the real helper afterward. The portable launch/setup
smoke explicitly keeps flat Windows schema-1 evaluation fixtures manual-only; both macOS expectations
and all three targets' setup/relaunch/manual-upgrade assertions remain. The lead replayed these
three repaired suites plus the session suite with official Node: **157/157 passed, 20.26 seconds**.

Performance review traced one synchronous PowerShell launch per active status poll (2.5-second UI
cadence). The manager now retains a private, session-ID-bound install-mode snapshot for active status
projection. Independent security review confirmed zero findings: fresh detection still precedes
candidate consumption and execution, and the status snapshot cannot authorize mutation. Idle status
remains fresh; replaced, restored and terminal session states have explicit snapshot handling.
Reviewed session source SHA-256: `2a6d8c08424674813ef1f4768645d6eca615a87bf4332ad7e2ace8fa56e4c38a`.
The complete canonical typecheck passed again after these changes.

Root/UI lint, positive and negative architecture gates, version consistency and QI supply-chain
checks passed. Four formatting findings were repaired without behavior changes. The operation
catalog was regenerated from source (247 entries, no naming violations) and its 15 drift tests pass.
The native inventory repair preserves schema v1, explicitly enrolls thirteen headers under actual
compiler/analyzer/behavior owners, and passes the lead's official-Node 25-test replay. Its declaration
does not substitute for the pending locality runtime proof. The coverage inventory still needs fresh
measurements for contracts (195 sources), security (28) and server (615); no floor is lowered here.

Windows diagnostics established that temporary positive fixtures used aliases and that metadata-only
opens do not participate in rename-sharing exclusion. Test-owned directories now use canonical handle
paths; retained production pins request the least directory data right (`FILE_LIST_DIRECTORY`) plus
attributes, with no delete sharing. Independent review approved that repair with zero findings.
Diagnostic `763a1b93d`, run `34156460872`, passed the native local-directory, rename-exclusion and real
mapped-SMB rejection checks, then failed the shared TypeScript local positive. The PowerShell carrier
remains under diagnosis; production eligibility and KHA1 remain disabled.

### Current UI and macOS replay

With official Node 24.18.0, the UI coverage run passed 432 files and 7,516 tests (one
skipped), in 144.71 seconds. Coverage measured 89.91% statements, 82.34% branches,
91.49% functions and 92.79% lines. The separate macOS native quality command passed
compiler, static analyzer and boundary checks; this is host-native boundary evidence,
not the outstanding signed N−1/N upgrade qualification.

The eight update browser journeys passed in 1.3 minutes, including actual BFF outage
and reconnection. The regenerated manifest at 2026-09-07T19:58:34.304Z matches all eight
UI source and four harness hashes. Its thirteen fidelity captures pass, and all twelve
axe captures have zero violations. These generated artifacts remain source-bound;
the final merge-time UI receipt still requires the audited delivery commit.

Error observability (eleven call sites), E2E wiring, changed-UI i18n, portable manifest,
portable approvals, release impact, release alignment and zizmor anchors passed.
Release alignment identifies existing 0.3.17 consistently; it does not publish or qualify
this repair. Windows diagnostic `d5fb829b5` / run `34157645968` adds only closed diagnostic
stage tokens to isolate the remaining shared locality query failure.

### Packaging and documentation follow-up

`portable:manual-review` prepared the disposable 0.3.17 fixture inventory; this command
prepares scenarios and is not a real packaged upgrade run. `smoke:portable-launch-setup`
passed all three target formats. Invoking `smoke:portable-secure-read` without its required
stage-root and platform arguments exited 2; no staged bundle was available from that
preparation, so this standalone artifact smoke remains unverified. The macOS native gate
separately passed its actual secure-read protocol/load checks.

Editor release evidence passed B1 (zero first-load editor markers across nineteen scripts),
B2 (1,002.6 KiB / 2,560 KiB) and B3 (110.1 KiB / 750 KiB). Dependency currency passed
thirty-eight governed dependency and fourteen action rows. Independent documentation review
found and settled two stale descriptions: Windows generation consumers are implemented,
and automatic replacement remains a qualified future contract while coordinator acceptance
is disabled. No production eligibility or acceptance criterion was changed by these edits.

Diagnostic `d5fb829b5` failed after the local TypeScript query and diagnostic each consumed
approximately ten seconds; the closed diagnostic result was `spawn-error`. This suggests
but does not yet establish a timeout. Native local/rename/mapped-SMB checks passed again.
The diagnostic-only Knip failure names the temporary probe file, which must be removed
before final delivery gates. The full package coverage run remains in progress against
frozen product sources; its known baseline source-count assertion is still red.

### Measured coverage and governed baseline refresh

The official-Node package coverage run completed in 1,455.82 seconds: 1,802 files passed,
two failed and seven skipped; 36,098 tests passed, two failed and twenty-seven skipped.
It remains a red test run. Aggregate coverage measured 90.83% statements, 84.53% branches,
95.59% functions and 93.02% lines. Before any refresh, all twenty-five package metric
floors, two release targets and sixty-nine governed file floors passed.

The documented writer generated a candidate baseline from these fresh measurements.
Review verified that every effective package floor (`min(85, recorded percentage)`) held
or rose, all absolute file floors were unchanged, and existing file ratchets held or rose
with unchanged tolerance. An independent static review confirmed zero weakening. The
accepted artifact updates contracts/security/server inventories to 195/28/615 and adds
two mechanically selected file floors. All sixty-six baseline tests now pass; the refreshed
quality gate passes all twenty-five packages and seventy-one governed file floors.

The other coverage failure was a 100 ms startup-challenge fixture returning `start-timeout`.
That exact case passed in isolation under coverage with unchanged limits. A full-file replay
then passed that case but timed out in the separate first lifecycle test at its existing
fifteen-second bound. This file remains under focused diagnosis; no limit has been raised
and no complete current-head root test pass is claimed.

Windows diagnostic `dde12fba4` / run `34159212513` reliably classified `timeout-assembly`.
The preceding `timeout-path` classification was ambiguous because Windows CRLF could skip
one instrumentation replacement. Diagnostic-only normalization and exact-match assertions
now guard every substitution. No production path, timeout or trust authority was changed.

### Windows locality boundary verified on the native runner

Diagnostic `bef4bb401` / run `34159907995` isolated the timeout to the exact `New-Object`
assembly-name construction before dynamic assembly creation. The repair replaces that call
and both fixed StringBuilder constructions with direct .NET constructors. Independent security
review approved the three substitutions with zero findings; all native checks, environment,
input, output and timeout bounds remain unchanged. Temporary diagnostic code is removed.

Diagnostic `fa132874a` / run `34196895373`, Windows job `101966584709`, passed the complete
productive native quality step at 2026-09-08T07:06:08.384Z. This includes the native retained
local-root/rename checks, real native and TypeScript local-positive and mapped-SMB-negative
checks, compiler/analyzer, coordinator, protocol, setup boundary, supervisor and .NET fixtures.
The twelve primary locality/inventory files are byte-identical to that tested diagnostic head.
The lead's focused constructor/runtime/wiring replay passed all sixty-seven tests. The existing
native inventory repair also retains its independent twenty-five-test pass and schema v1.

The Windows job remains red: its next, separate setup-bootstrap smoke returned status 17
where zero was expected (stdout 282 bytes, stderr 103 bytes). That downstream failure is under
bounded diagnosis. Neither the full job nor production-signed N−1/N qualification is claimed
green. KHA1 coordinator acceptance remains disabled. On 2026-09-08, GitHub `dev` is still
`c5c03d48fa1066c985a656d29880ae1c02e68c48`, and issue ownership is unchanged.

### Runtime composition test collection repair

Cold dynamic loading of the runtime composition consumed 10.5–11.7 seconds inside a
15-second test budget; measured startup and shutdown took approximately 60 and 6 milliseconds.
The test now statically imports the factory during collection and checks its fixture interface
against the production types. Existing startup/test timeouts and permission shape assertions
are preserved. The lead reviewed the final test-only diff at SHA-256
`6eb3b1540f10021cb2cfda37963c2ad4ff29b8ccb1629345291b31f1034d1eb8`.

The typed fixture replay passed all 25 tests in 18.49 seconds, and the two timing-sensitive
cases passed with coverage in 18.67 seconds. Canonical Node 24.18.0 package/root typechecking
also passed. The final diff restores the original permission guard after those executions;
the complete final-head suite is still required. No production lifecycle behavior changed.

### Windows setup smoke verified after canonical fixture preparation

Diagnostic `e2c17c77b`, run `34198289921`, Windows job `101971015297`, passed both the
complete productive native quality step and the following setup-bootstrap smoke. It also
passed Windows package-graph typechecking and package build. The smoke fixture now resolves
its newly created temporary root with `realpathSync.native` before deriving Unicode/custom
installation paths. The primary smoke file is byte-identical to the runner input, SHA-256
`d87826e9ba3e53931884733a25255dbd0d880bb54792ad1c9db2e0b9a7185bac`.
No production canonical-path check was relaxed. The overall run remains incomplete; its
protected-branch gate rejects the temporary diagnostic branch by design, and this diagnostic
run is not final child-head CI or signed release qualification.

Scripts coverage completed with 183 passing files, 4,283 passing tests, 51 failing tests and
85 skipped tests in 908.79 seconds. The two failing files were environmental: the scripted
release test could not resolve a trusted `gh`, and route wiring rejected source timestamps
newer than the pre-run build. After freezing source, rebuilding and supplying a protected
copy of the exact installed gh 2.92.0 binary through PATH, both complete files passed in the
four-file replay. That replay also passed runtime composition; its two failures were new
Windows preacceptance fixture construction, currently being corrected without weakening WAL
validation. All-report preliminary new-code coverage is 83.8% against 85%; meaningful missing
Windows recovery and generation-signing/staging cases are under test. No coverage or source
mapping gate is claimed green until the complete reports are refreshed.

### Additional Windows recovery authority regressions

Four test-only scenarios now cover legitimate pre-acceptance settlement, current-generation
drift before that settlement, a native launch exception before child PID publication, and
candidate-generation drift after native recovery. The fixture constructs pre-acceptance state
before any accepted receipt exists; it does not regress the persisted WAL. Drift retains the
WAL, and the launch-failure retry proves that the live recovery owner prevents a second launch.
The complete normal-startup file passed all 28 tests with isolated coverage in 17.78 seconds;
scoped formatting/lint and lead diff review passed. Frozen test SHA-256:
`c7237e3426de96ea0519b56f5fec799419cd06b18c27c65cf7267996c694fbcc`.
The isolated report remains separate from the full-suite coverage reports.

### Windows generation staging and signing command regressions

Three existing script suites now exercise production-generation lane rejection, exact generation
binding passed to the launcher compiler, malformed binding/missing fixed output, and the real
signing command dispatchers for inventory closure and generation verification. A changed launcher
digest is rejected against the closed generation. These are scoped deterministic command/fixture
checks; they do not claim a native compiler run or production signature qualification.

The isolated scripts-coverage replay passed all 64 tests across the three files in 3.70 seconds.
Scoped formatting, lint and lead diff review passed. The report is retained separately at
`/tmp/keiko-3405-windows-generation.LGM7nP/coverage` pending a complete coverage refresh.

### Authenticode producer-parity compilation fixture repair

Diagnostic run `34198289921` completed the full Windows packaging job successfully, including
native optional dependencies. Core quality and Linux/macOS package smokes also passed for that diagnostic branch. The manual
workflow deliberately checks out `dev` for every coverage producer and the Sonar aggregate:
those passing jobs verify `c5c03d48fa1066c985a656d29880ae1c02e68c48`, not the diagnostic or
repair head. Its Node 26 compatibility suite had one failure among 36,103 executed tests:
the producer-parity fixture concatenated two C# compilation units, placing productive source
`using` directives after runtime namespace declarations (CS1529). The fixture now sends the exact
source units as a JSON array and compiles each independently in the same PowerShell process.
Product C# and all canonical/adversarial parity assertions are unchanged.

At the repaired fixture, the lead's canonical full typecheck passed and the normal-startup plus
Authenticode replay passed 47 tests in 22.15 seconds. One producer-parity test retains its existing
macOS platform skip because producer SignedCms loading can block in Apple's Security framework;
the runtime DER probe did execute with PowerShell present. Linux/Windows parity at the repaired
head remains required. Frozen test SHA-256:
`20298e0266b91e2955c608a7a04bb11aa259568204a11f84d5c19bf84e8d15e8`.
No final child-head CI or complete epic-baseline new-code coverage result is inferred from the
passing manual Sonar gate on `dev`.

### Manual CI evidence binding correction

The workflow-dispatch coverage producers and Sonar aggregate explicitly select `dev`
(`.github/workflows/ci.yml:457`, `:561`, `:629`, `:730`). The scanner log for run `34198289921`
records `SONAR_HEAD_SHA` and SCM revision `c5c03d48fa1066c985a656d29880ae1c02e68c48` and a
passing main-branch gate. Those results establish the current `dev` baseline only. They do not
close this child's package/script/UI coverage or Sonar/new-code requirements. The diagnostic
Windows native/setup/type/build/full package evidence remains bound to its selected head.

A preliminary union of the complete local reports with isolated new regression coverage measures
84.5% against the unchanged 85% new-code floor. This diagnostic calculation leaves the canonical
reports untouched and is not a final gate receipt. The integrated report refresh remains pending.

### Real staged macOS secure-read smoke

The approved USearch input verified locally; approved sidecar preparation completed, and the
repository's normal staging command produced a real macOS arm64 bundle from package 0.3.17.
`npm run smoke:portable-secure-read -- .portable-runtime/staging/macos-arm64 macos-arm64 --load`
passed against its actual manifest-declared helper. Manifest SHA-256:
`5406ca8dc4bdd3115d56d93c6682a465e47d2d041e7d01893c069b576249644a`; helper shipped SHA-256:
`06e574a1fadf7239530f607e9a2bb03f2809918e4db06b31c5297286be092bac` (34504 bytes). The artifact records source commit
`90bbe2fd99c602e84547860d1c66197c1b3a5038` and explicitly remains `unverified-staging`.
This closes the earlier missing-staging-input smoke prerequisite, not signed upgrade eligibility.

Staging prunes package artifacts and workspace/native dependencies. The lead subsequently restored
the committed dependency graph with official Node 24.18.0 `npm ci --ignore-scripts` (783 packages,
zero reported vulnerabilities). Future package/test verification must rebuild after ongoing fixes.

### Final audit findings under repair

Independent PR review confirmed two default CLI composition defects: preflight/session did not
share candidate authority or pass the fresh report, and CLI sessions/local state lacked durable
state/canonical activity wiring. The CLI owner is repairing these together and adding default
composition regressions. The necessary existing authority factory will be consumed through the
private, non-independently-published server package's existing internal barrel; no new HTTP endpoint
or externally published package API is introduced. The export's actual CLI consumer must remain
part of final package/architecture verification.

Independent security review confirmed one Windows availability defect: production PowerShell 5.1
runtime C# compilation lacks a standard-user writable compiler temporary directory after environment
restriction. The selected repair precompiles the unchanged verifier into a private, deterministic .NET
Framework assembly and loads validated bytes in memory; ambient temporary authority must not be
restored. Generator/toolchain pinning and real restricted-token PowerShell 5.1 proof remain pending. The independent accessibility/design-system audit found zero findings and verified
that all eight UI and four harness hashes still match the existing browser/axe/fidelity evidence.
That source-bound review does not replace the final HEAD execution receipt.

### Default CLI repair review and focused replay

The CLI composition repair shares the actual candidate authority across preflight and session,
passes the fresh report to consumption, and wires local state plus canonical file activity into the
session. Cleanup attempts both owned store and sink closure on normal exit and construction failure.
Canonical package build/root typecheck passed for the production changes. The initial combined
focused replay passed all 25 runtime-composition tests; the new CLI fixture exposed an invalid
synthetic approval reference, which was corrected to the existing supported format without changing
the production parser. A construction-failure regression additionally proves both owned resources
close exactly once and the command runner remains untouched.

The owner then passed all 16 CLI tests plus scoped ESLint/Prettier. The lead's independent canonical
package-coverage configuration replay passed **25/25 tests across CLI and candidate-authority suites
in 33.61 seconds**, writing only isolated coverage under
`/tmp/keiko-3405-default-cli-final-root-coverage`. The CLI update module measured 88.53% statements,
78.67% branches, 90% functions, and 89.28% lines. Independent re-review found **zero findings** and
confirmed actual factories, issue/consume activity, durable session/recovery readback, and cleanup.
These results settle the two default CLI wiring findings; final integrated receipts remain pending.
Frozen source/test SHA-256 values are respectively
`9b627dc53735eef37806d79ec3e039749dc236a19b6ecfe6a398f52fd382af58` and
`40b84f8b04c42177c95204561cc14e4a8544756d59eb747a0ff14c074d1445d7`.

Independent consumer review also verified removal of 12 unused server-root aliases: the four
recovery lock helpers (adopt, claim, inspect, release), their recovery inspection/ownership types,
the recovered-launch encoder/reader/environment constant, and the three normal-startup
options/result/descriptor types. Leaf exports remain. The CLI-consumed normal-startup reconciler
and ordinary lock surfaces remain; the existing authority factory has one new consumed internal
barrel export. Final assembled package/architecture checks remain required.

### Remaining performance and diagnostic findings

The final performance audit found that each successful active Update window poll (every 2.5 seconds)
also prepares remediation, which reaches a synchronous recursive state scan without entry, depth,
or time bounds. This is a confirmed execution-path finding, not a measured latency claim. The repair
must avoid repeating unchanged remediation preparation and preserve safe handling of incomplete
scans for compatibility, snapshots, and repair. Existing UI evidence will need refreshing if its
covered source changes.

Diagnostic run `34201205684` at `e4660b5d9a0de7cda92ef7202d3a8a959b168be9` reports successful
Windows cross-platform job `101980236635` and Node 26 job `101980236677`. The completed Node 26 job log records
1804 passing files, seven skipped files, 36110 passing tests and 24 skipped tests in 1020.54 seconds.
All 20 Windows Authenticode fixture tests passed on Linux, including the repaired source-parity case. Core quality failed on one redundant typed null
condition in the runtime-composition test. The test-only repair retains the undefined/array boundary
and asserts the generated alias and scope together as an object before use. Scoped ESLint passed
with zero warnings and Prettier reported no changes; its focused runtime replay is pending. Frozen
test SHA-256: `e5fae99c156385332fbb8b3b92892d551932282849fed5fa421c51c67d8214fa`. The diagnostic
branch's protected-branch rejection is expected and is not a target-branch CI receipt. Coverage and
Sonar from this manual run still select `dev`, as documented above.

### Remediation performance repair re-review

The Update window now reuses only the server-returned remediation projection during unchanged
progress polls. Its key includes target, reviewed impact, session identity/location, persistence,
and lifecycle state; ordinary progress/messages/timestamps do not invalidate it. Manual checks,
actions, meaningful transitions and reconnect recovery refresh the projection. Unconditional
initial/manual/action refreshes retain concurrent session/remediation loading.

The private state scanner iterates directories incrementally and bounds entries (50000), depth (64),
relative-path UTF-8 bytes (4096), and monotonic elapsed time (250 ms). Time checks occur before each
further directory open and entry stat. This is a best-effort traversal budget between filesystem
calls, not a hard deadline on an individual synchronous call. An incomplete traversal has an explicit
private result: affected compatibility becomes manual review, snapshots fail before publication or
pruning, and repairs stop before permission mutation. Public contracts remain unchanged.

The owner passed **67 server tests and 54 UI tests**, with scoped ESLint/Prettier green. The new
regressions verify unchanged-poll call counts with advancing progress, transition/reconnect/action
refresh, concurrent initial requests, all four limits, no post-expiry entry syscall, no partial
snapshot, and zero partial permission repair. Independent performance re-review found **zero
findings** and verified the frozen source/test hashes. Earlier owner coverage used a text-only
reporter and produced no persistent LCOV; those temporary paths are not union evidence. The lead's
independent canonical-config replay now passed **67/67 server tests in 2.19 seconds** and
**54/54 UI tests in 4.58 seconds**, with persistent isolated LCOV under
`/tmp/keiko-3405-remediation-final-root-server-coverage` and
`/tmp/keiko-3405-remediation-final-root-ui-coverage`. The focused server modules measured 84.88%
statements, 74.29% branches, 90.9% functions and 87.83% lines; UpdateWindow measured
95.57/90.98/96.58/97.58 respectively. This is isolated coverage, not the full 85% new-code gate.
Final updater browser evidence remains pending.

Frozen Update window/source-scanner SHA-256:
`cc1e70deab4b55500fc3e219d7eba128e1ef0915c9a29dfd3fa475f995fa0199` /
`d3663ca6d9d481267d32b1606c2015fc1284a560f37742b410a08bd6b357d9fa`.

### E2E gateway prerequisite and Windows verifier generation

Both completed diagnostic Chromium smoke jobs (`34198289921` and `34201205684`) reported 60
failures and 13 passes. Read-only triage traced the shared failure to the E2E gateway fixture's
unprovisioned credential reference: the setup dialog covered the desktop and no configured chat
model was available. Restoring the fixture byte-for-byte to `origin/dev` restores its explicitly
non-secret `e2e-mock` value. The updater-specific harness's redundant key override was removed.
No production credential handling changed. The lead's real Chromium replay of shell startup,
chat, and both shell accessibility themes passed **4/4 tests in 48.8 seconds**. The full Chromium smoke
replay then passed **73/73 tests in 3.4 minutes**. This verifies the shared fixture repair against
the real BFF and browser. The updater-specific harness digest changed intentionally and its eight
source-bound evidence journeys must be rerun after the final polling follow-up. Fixture SHA-256:
`9ccdb592af0021033cb26f4868ff263badff5dcc4d716bb4a2fbac54c6dd69f6`; updater harness SHA-256:
`8831ac0020b34942be6867bdbc5c0c6480455798d9550ea95f639005b1fb7adf`.

Windows diagnostic inspection `34204823280` at `eb500083ec649d287869bf0bf108a74a451161cb`
measured the finite Roslyn distribution (111 files, 35634755 bytes) and four explicit .NET Framework
references. Generation run `34205246166` at `c53826aa7eeac0ca48f8e5cf90617d115c6feff7` used
those reviewed literal pins, compiled twice in separate temporary directories, and required identical
asset bytes. Both runs passed. The resulting assembly is 12800 bytes with SHA-256
`e67641e44c85b7d7e787edffe6aaad173f5277e257a7e1b58d00428d5f5e5a37`; generated TS SHA-256
`bdc2f45a722760d10cadbf21327f743f65b4fd5945ca9acfb2ee3e7a8eb98e96`. The lead independently
validated the canonical source, base64 round-trip, length and digests before copying those exact
bytes into the private runtime module. Source SHA-256:
`3038b1ba4e5852b4df291bfa890a7a22ebfcaf9d0e244d10e76576f4426bd04f`.

The compiler digest is `3aafb7b9c54fa31a7092af35148971ee616965e7f9a0b80fb7fdc4bdd1d1a555`;
its distribution digest is `ba14f4ef19598f640ba103fe352e0bdca7a9bb9421b8dd1629df725431bcb8c3`.
The recorded CLR version is `4.0.30319.42000`. The implementation accounts for Microsoft's
[documented deterministic compilation inputs](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/code-generation#deterministic).
Canonical root and UI native typechecks passed after the runtime stdin transport was integrated.
Restricted-token PowerShell 5.1 loading, analyzer evidence and final security review remain pending;
this generation evidence does not qualify signed upgrades.

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

### Verifier and browser follow-up (2026-09-08, pending final freeze)

- Official Node 24.18.0 root typecheck and the native UI typecheck passed after the
  precompiled-verifier integration. The seven focused verifier/tooling suites passed
  **97 tests, with one platform skip**, in 17.52 seconds. Persistent LCOV and JSON
  reports are under `/tmp/keiko-3405-precompiled-verifier-final-root-coverage`;
  the corresponding `.log` records the actual exit. These are focused reports,
  not the final canonical coverage or new-code verdict.
- The static security audit of the 19-file verifier repair found **zero actionable
  findings**. Its PASS remains conditional on real restricted-token execution and
  the native analyzer gate. Deterministic regeneration passed on Windows at
  `69d4115b42b8d2851644c6af8b16881db470fc81` in
  [run 34208078111](https://github.com/oscharko-dev/Keiko/actions/runs/34208078111).
- [Runtime proof 34208078216](https://github.com/oscharko-dev/Keiko/actions/runs/34208078216)
  passed the existing native C tests, secure-read protocol/load checks, and the
  deterministic verifier check, then failed in the new test helper with exit 115
  before loading the assembly. The helper incorrectly treated `IsTokenRestricted`
  as proof of disabled administrator membership; that API specifically tests a
  restricting-SID list. This is a failed qualification run, not loader success.
  The bounded helper repair and a fresh actual Windows run remain required.
- The updater browser command passed **8/8 journeys in 1.3 minutes**, including the
  real BFF outage/reconnect path, with log
  `/tmp/keiko-3405-final-remediation-updater-browser.log`. The run revealed migration
  of the tracked fake-key fixture to a vault reference; regenerated evidence was
  therefore retained under the default untracked output directory pending harness
  isolation and a clean rerun. It is not a final SHA-bound UI receipt.

### Isolated outage harness and refreshed UI evidence (2026-09-08)

The outage harness, separately from Playwright's main server, passed the tracked
fixture directly to the real CLI. Credential migration therefore rewrote that
fixture. `createOutageHarness()` now copies the fixture into its private state
directory and uses the copy for every CLI start/restart. The fixture remains the
exact committed fake-key fixture after execution.

Root reran `npm run test:e2e:update-ui-1696` under official Node 24.18.0:
**8/8 passed in 58.6 seconds**, actual exit zero, including the real BFF outage.
The log is `/tmp/keiko-3405-isolated-outage-final-updater-browser.log`.
All **12** recorded product/harness SHA-256 values were independently checked
against the current files before copying the **17** real-run artifacts into
`docs/design-system/evidence/3405/`. The manifest generation time is
`2026-09-08T09:17:58.786Z`. This refresh covers the final remediation-polling UI
projection and isolated outage harness. It remains distinct from the final
commit-bound UI receipt and native production qualification.

### Runtime-target analyzer settlement and current verification (2026-09-08)

The extracted Windows verifier now has a dedicated C# 5/.NET Framework 4.8.1
analyzer project with latest-all analysis, warnings as errors, four explicit
reviewed reference assemblies, no implicit framework references or reference-package
download, and an empty locked dependency graph. The existing .NET 8 producer
project retains its original scope and gates. Target-applicable source changes
are limited to read-only collection interfaces, empty-array reuse, and an explicit
`DecodeOid` null check. Static security review confirmed that the CMS, timestamp,
imprint, chain, EKU, publisher and native-read policy remained unchanged.

The dedicated Windows analyzer passed at `ff2306f503e2ea5187d08d9d8d64e65b380c7880`
in job `102008733798`. [Bootstrap run 34210083070](https://github.com/oscharko-dev/Keiko/actions/runs/34210083070)
produced two byte-identical assemblies. Root independently verified the canonical
source, canonical Base64, PE signature, byte length, assembly hash, and unchanged
compiler/distribution pins before copying the generated asset:

- Canonical C#: `4bf862e48434c6b955e30493bee0f58d40ffba5dcb4b41e61aa1ef94dc46c859`.
- Generated TypeScript: `3d082c81667b2fe35eec7c59a70354e233d6831fdf067fe8fabe60d1bef66bf2`.
- DLL: **12,800 bytes**, `ac4c55d5381903579b1277aae5e08a4e4e07587b533c5568b4c383c6f81ead43`.

These close deterministic generation and analyzer findings. They do not close
restricted-token execution: the current fast Windows probe fails before loading
with an out-of-range child exit mapped to helper failure 113. The next diagnostic
retains that failure and exposes only the numeric child status through a bounded,
closed grammar. Neither this work nor a green analyzer enables KHA1 or qualifies
production-signed updating.

Current independent root checks under official Node 24.18.0:

- Root typecheck passed: `/tmp/keiko-3405-regenerated-verifier-final-typecheck.log`.
- Seven regenerated-verifier/permission/tooling suites passed **125 tests**, with
  one platform skip, in **23.46 seconds**; loader-probe tests passed a further
  **7/7** in **442 ms**. Logs are
  `/tmp/keiko-3405-regenerated-verifier-permission-tests.log` and
  `/tmp/keiko-3405-closed-loader-probe-tests.log`.
- Canonical UI coverage passed **432 files / 7,518 tests**, with one skip, in
  **147.20 seconds**: 89.92% statements, 82.35% branches, 91.51% functions,
  92.80% lines. The canonical report remains at
  `packages/keiko-ui/coverage/lcov.info`; log
  `/tmp/keiko-3405-final-ui-canonical-coverage.log`.
- Fresh accessibility/design-system review passed with **zero findings**, including
  all 14 visual captures, all 12 axe captures, and all 12 source/harness hash bindings.
- Full lint identified an unsafe test matcher plus an archived staging copy inside
  the source tree. Direct typed assertions replace that matcher without weakening
  the permission check. The previously verified 562 MiB staging artifact was moved
  intact to `/tmp/keiko-3405-verified-staging-90bbe`; it is not production source.
  A complete lint rerun remains required.

### Canonical package coverage and catalog replay (2026-09-08)

The official Node.js 24.18.0 canonical package coverage run completed in 1,622.87 seconds
with 1,807 passing files, one failing file, seven skipped files; 36,137 passing tests,
one failing test, and 27 skipped tests. The sole failure was checked-in operation-catalog
drift at three source references: `windowsPortableAuthenticode.ts` lines 63/71 moved to
76/84, and `update-local-state.ts` line 1586 moved to 1605. No operation definition changed.
`npm run generate:op-catalog` regenerated 247 entries (nine dynamic, zero naming
violations), and `npm run check:op-catalog` passed all 15 tests. A complete direct replay
of the same catalog suite also passed all 15 tests in 4.53 seconds. The original full
run remains recorded as red; the replay settles its single observed failure.

Canonical package coverage measured 90.84% statements, 84.55% branches, 95.60% functions,
and 93.03% lines. `npm run check:coverage:quality` subsequently passed all four metrics
for all 25 packages, both strict release targets, and all 71 held per-file floors
with zero violations. Log: `/tmp/keiko-3405-fresh-package-ui-coverage-quality.log`. These fresh reports replace the earlier partial package measurements.
Logs: `/tmp/keiko-3405-final-packages-canonical-coverage.log` and
`/tmp/keiko-3405-final-op-catalog-replay.log`. The canonical scripts coverage run is
separate and still running; no merged new-code verdict is claimed yet.

Windows diagnostic run [34213453952](https://github.com/oscharko-dev/Keiko/actions/runs/34213453952)
on `2b474353af182044b52de3fcdb9c43df89d2c229` showed the original-token child exiting
zero under the same closed environment and private desktop. The restricted child still
exited with `C0000142` after explicit user/SYSTEM process/thread DACLs, despite successful
restricted query/synchronize access to both objects. This eliminates that minimal
child-object ACL adjustment as a demonstrated fix. Run
[34214763762](https://github.com/oscharko-dev/Keiko/actions/runs/34214763762) on
`00db0d66b2ec329fbd334ef278cfc6f4c368c82f` adds isolated group-only and privilege-only
controls and bounded token-shape classifications. Its required combined-token probe
remains unchanged; diagnostic controls do not grant a pass.

The isolated-token run completed with analyzer success and loader failure. Original-token
and privilege-only controls exited zero; group-only and combined controls failed with
`C0000142`. All classified normal user groups remained enabled; integrity remained high.
Removing Administrators changed the token owner from Administrators to the user, while
the token default DACL retained its original trustee classes (no explicit current-user
allow entry). This is a diagnostic hypothesis, not a proven cause. The next control
changes only the derived token's default DACL to current user plus SYSTEM and compares
it with the unchanged required probe. Log:
`/tmp/keiko-3405-authenticode-token-controls-00db.log`.

Windows diagnostic [34215483696](https://github.com/oscharko-dev/Keiko/actions/runs/34215483696)
on `d919b21af` isolated the token default-DACL cause: the derived token changed from
trustee class 14 to class 3 (explicit current user plus SYSTEM), retained high integrity
and all normal enabled user groups, and started the PowerShell child successfully
(exit zero). The unchanged required combined token still failed with `C0000142`.
The analyzer job passed; the workflow remains red because the unchanged required
loader probe intentionally remained the pass condition. The repair is confined to
test-helper token construction; it does not change production environment or trust.
The full four-probe loader and complete native gate must pass after simplification.
Log: `/tmp/keiko-3405-authenticode-default-dacl-d919.log`.

### Completed scripts coverage and remaining new-code gap (2026-09-08)

The canonical `npm run test:coverage:scripts` run passed all 188 files: 4,438 passing
tests, two skipped, in 805.78 seconds. Fresh coverage measured 78.30% statements,
73.91% branches, 83.82% functions, and 79.74% lines.
Log: `/tmp/keiko-3405-final-scripts-canonical-coverage.log`.

A diagnostic application of the repository's coverage parser to the complete working
tree (including new untracked source) and all three fresh canonical LCOV reports
measured 83.363% of 9,431 new lines/conditions. This is below the unchanged 85% bar
and is not a final committed-head gate. It supersedes earlier partial estimates.
Meaningful verifier, handoff, and recovery regression cases are being added through
existing test seams; no thresholds, exclusions, or production trust are changed.
Diagnostic data: `/tmp/keiko-3405-full-working-tree-new-coverage.json`.

The new recovery-pending UI test uses HTTP 409 so it exercises the specific
`STARTUP_RECOVERY_PENDING` branch independently of generic transient server errors.
The complete Update window suite passed all 55 tests in 3.85 seconds.
Log: `/tmp/keiko-3405-recovery-pending-ui-gap-tests.log`.

### Final precompiled Windows verifier execution (2026-09-08)

All three jobs passed in [run 34216315755](https://github.com/oscharko-dev/Keiko/actions/runs/34216315755)
on diagnostic commit `4028c1f83`: analyzer `102028783977`, required loader
`102028784133`, and complete Windows native quality `102029284977`. The required
loader proves stdin transport and real `Assembly.Load` under the non-administrator
combined token with only the fixed four-variable environment, plus truncated and
corrupt-input rejection. The full `npm run check:native:windows` path also passed.
The independent static review of final helper SHA-256
`42540e1f32fae7304af5d2975cbe4dcd16d25b09d1ccc6121c63eff39c24c9b7`
reported zero findings. All diagnostic branches were removed before this run.

The causal repair sets only the derived test token's default object DACL to current
user plus SYSTEM. Administrators remains disabled and the enabled-privilege cap is
unchanged; the original token and shared desktop/object permissions are unchanged.
This repairs the test helper's token construction, not production trust. The compiled
verifier source, deterministic asset, runtime loader, and analyzer inputs retain the
reviewed hashes recorded above. This is verifier execution evidence, not an eligible
production-signed N−1-to-N canary or an epic completion receipt.

Logs: `/tmp/keiko-3405-authenticode-required-loader-4028.log` and
`/tmp/keiko-3405-authenticode-full-native-4028.log`.

### Terminal-session complete-WAL regression found (2026-09-08)

The new production-composition test starts from a succeeded terminal `lastSession`,
no active session/candidate, and the surviving `complete` WAL and real handoff receipt
fixture. Pre-listen recovery succeeds and persists reconciling state. Post-listen
recovery incorrectly returns `persistence-failed` and retains the WAL. The rejection
occurs at the local-state write before verified-ACK publication: the completed-WAL
settlement validator requires a current active session, while the existing
`persistTerminalRecovery` path necessarily operates on the terminal last session.

The repair is scoped to `update-local-state.ts` and its tests. It adds a distinct
terminal-complete case with an unchanged succeeded last session, no active
session/candidate, complete receipt-bound WAL, matching recovery identity, and an
otherwise exact state projection. Existing active, remediation, and restored cases
remain. The original failing production regression is retained. All 84 tests in the
three owning suites passed, including a second restart preserving the succeeded last
session. The server production typecheck, scoped lint, and formatting passed; those
outputs are retained in the worker task transcript, not standalone filesystem logs.
Independent static review of the four-file freeze reported zero findings. This
supersedes any claim that all implementation gaps were already settled by the earlier
static acceptance map.

The lead then ran all 38 server updater suites against the current source: 561 passing
tests and two platform skips in 40.23 seconds, exit zero. The persisted log is
`/tmp/keiko-3405-terminal-state-broad-coverage.log`; fresh local-state coverage is under
`/tmp/keiko-3405-terminal-state-broad-coverage/`. The diagnostic full union replaces
the old local-state report entirely with this source-matching report, avoiding stale
line/branch indices, and measures 84.869% of 9,464 new lines/conditions. It remains
provisional and below the unchanged 85% requirement.

Reviewed product SHA-256: `d9b6ac004c3b88199f6a17dd207581cf2f448622ee67e5f67d5e4bd9524dfa95`.
Freeze manifest: `/tmp/keiko-3405-terminal-wal-and-recovery-tests-freeze/manifest.json`
(SHA-256 `bf3967c356c146e5a6d8d515643ba6c02d11ebac4630ad5660e2193cc0bb1092`).

### Generator input boundary and coverage freeze (2026-09-08)

The final generator test slice exercises the real CLI inspection path without
compilation and rejects missing references, unknown options, malformed reference pins,
malformed compiler-distribution JSON, and compilation without reviewed pins. All 19
generator tests and all 62 legacy-import tests passed; scoped ESLint, Prettier and
diff whitespace checks passed. No product source, coverage exclusion or floor changed.

Generator coverage increased from 96/131 to 122/131 lines and 43/79 to 66/79 conditions.
The provisional full union now covers 8,081 of 9,464 new lines/conditions (85.387%),
with the changed local-state source represented only by its fresh broader updater
report. Canonical coverage must still confirm the result; this is not a gate receipt.

Logs: `/tmp/keiko-3405-final-generator-import-gap-tests.log` and
`/tmp/keiko-3405-final-legacy-import-gap-tests.log`. Diagnostic union:
`/tmp/keiko-3405-provisional-covered-gap-union.json`.

The full root compiler subsequently caught an optional fixture spread in the new
negative state test. An explicit last-session guard corrected the test type without
a cast or assertion weakening; product source is unchanged. The local-state suite
passed 41/41, the root native TypeScript no-emit check passed, and scoped lint and
formatting passed. Final test SHA-256:
`c0ba33026643d3ffac30a67a2a84814fed433f7ceb704fa30a4b8b27a4b7dfc3`.
Logs: `/tmp/keiko-3405-terminal-test-narrowing-vitest.log`,
`/tmp/keiko-3405-terminal-test-narrowing-typecheck.log`,
`/tmp/keiko-3405-terminal-test-narrowing-eslint.log`, and
`/tmp/keiko-3405-terminal-test-narrowing-format.log`.

The source catalog was regenerated after the recovery fix and now points to
`update-local-state.ts:1656`. The full repository formatting check passed.
Independent review of all added test deltas found no weakened checks or artificial
coverage; that review was static and does not replace canonical execution.

Full root and UI `npm run lint` completed successfully, exit zero:
`/tmp/keiko-3405-frozen-root-lint.log`. Full `npm run format:check` passed:
`/tmp/keiko-3405-frozen-format-check.log`; this final ledger update was formatted
again afterward.
