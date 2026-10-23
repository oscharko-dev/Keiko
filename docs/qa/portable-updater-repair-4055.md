# Portable updater repair evidence (#4055)

Collected on macOS arm64 on 2026-10-21 for
[PR #4056](https://github.com/oscharko-dev/Keiko/pull/4056), targeting `dev` with auto-merge disabled.
This ledger distinguishes full-package fixture updates, the existing SSD installation, and release
acceptance. It does not attest a new public release.

## Real published-release attempt (2026-10-23)

The protected 1.2.6 release completed from `4f838cbd56f604dd183bc056c63e724f9e47d3ea` and
became GitHub Latest and npm Latest. The existing SSD's real Settings update button accepted that
release and authenticated, downloaded and staged its macOS arm64 archive. The update then failed
before native handoff; publication is not updater acceptance.

The recorded original exception was `PortableHandoffPlanError: portable handoff plan is unsafe`.
The production builder used the canonical runtime-state root, while `buildPeripherals` supplied
the UI database parent to the coordinator, session lock and recovery. With the normal `ui` child
directory, the coordinator therefore looked for the plan in a different directory. Earlier
component fixtures passed a shared directory directly and did not exercise that composition.

The regression now runs the real dependency composition with nested and separately configured UI
storage and actual plan/receipt/lock files. Both cases fail before the correction. The correction
uses the existing runtime-state resolver for all three consumers. Recovery continues to emit the
existing body-free `update.runtime.state-write` evidence; the regression asserts it. The complete
SSD update, data continuity, restart and normal eject must still pass before this issue can close.

## Stop failure follow-up (2026-10-22)

After the long-running SSD session, the root process exited but its native receipt remained
`owned`. The stop command therefore refused completion. Normal work-image and physical SSD ejects
succeeded after no open work-volume files remained; no reap receipt was fabricated.

A first regression reproduced loss of previously established unrelated ancestry during reclamation.
Preserving that history fixed the regression and short stops, but the complete application failed
normal stop again after 1,665 seconds. That correction was insufficient and was not released.

A controlled follow-up reproduces the underlying ambiguity: a foreign process forks through an
intermediate parent that exits between host snapshots. Its surviving child remains unclassified,
even after every owned process exits. Ignoring unknown processes would also lose real detached
Keiko descendants, so the repair replaces host-ancestry inference with a distinct kernel resource
coalition created by a temporary launchd job. No Apple membership, entitlement or administrative
operation is involved. The existing private owner protocol, exact process identities, audit-token
signals and zero-live requirement remain enforced. Unavailable or incomplete observations still
refuse proof. Normal ownership lifecycle outcomes use the existing Activity Log.

The executable regression pauses the observer, creates both an owned detached descendant and a
foreign orphan through already-exited intermediate parents, then resumes observation. Cleanup must
remove the owned descendant, preserve the foreign process and emit a real zero-live proof. The
temporary job disables keepalive and is removed on completion. Separate model controls cover
80,000 foreign generations, identity reuse, inaccessible observations and exhausted enumeration.
Long-running full-application stop and actual SSD update/eject acceptance remain required.

## Full-package update qualification

A separate copy of the complete portable application completed **99.0.0 → 99.0.1 → 99.0.2**.
Both transactions used the real UI/BFF, streaming archive staging, native handoff, successor startup
reconciliation and terminal session settlement. Each successor reported `succeeded` without another
restart. The second transaction exercised release of the preceding session lock.

The fixture supplied its own Ed25519 key and release transport through dependency injection. Its
bundled catalog contained only the starting version; future impacts came from the authenticated
offered manifests. Its workspace marker and synthetic key-file digest remained unchanged through
both updates. The final application stopped normally. The helper carried additional failure-only,
body-free diagnostics for this local qualification; this fixture bundle was never installed on the
work SSD. Customer data and production release signing keys were not used.

The checked-in native qualification is reproducible with `npm run check:native:macos`. It separately
executes two forward handoffs, coalesced cancellation, failed-start restoration followed by another
update, process identity churn, protocol refusals, compiler warnings and static analysis. The full
gate passed again for `645dad3e09ccb95022f6f88e09d9172d7eafe83e`.

## Existing SSD installation

The original 1.2.5 work installation was stopped before its state was copied. Closed-state backups,
the original app bundle, registration and private launcher material remain on the encrypted SSD.
A pristine local source build from `645dad3e09ccb95022f6f88e09d9172d7eafe83e` was installed through
the existing `portable setup` path. It retains version 1.2.5 and records its source commit and local
bootstrap classification in `.portable/source-build.json`; it is not a republished release. It
contains the production trust roots and no fixture bootstrap or fixture trust root. The app seal
passed `codesign --verify --deep --strict` using ad-hoc signing, without Apple membership.

| Check                | Observed result                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent data      | All 67 tables across three existing SQLite stores remained present; no row count decreased after startup or reopening.                      |
| Private material     | Key file, launcher secret and private launch wrapper remained byte-for-byte unchanged.                                                      |
| Managed installation | Existing setup reported managed and update eligible.                                                                                        |
| Runtime              | Real UI returned HTTP 200; the application ran beneath native helper ownership on the SSD.                                                  |
| Close and reopen     | Normal stop released the work image. The existing Open command reopened it through the existing keychain and started the application again. |
| Final stop and eject | Normal stop, work-image eject and physical USB SSD eject all succeeded; no forced eject or privileged process termination was used.         |

The SSD's Close command now selects the current managed Node runtime instead of its stale 1.2.4
path. Its previous privileged process-kill workaround was removed. A busy volume produces a failure
instead of forced ejection. At the end of this check the SSD was safely ejected and the work
application was stopped.

These continuity checks establish table presence, row-count preservation and unchanged key bytes;
they are not a semantic comparison of every customer record. No customer row contents or secrets
are included in this ledger.

## Cross-platform and release boundaries

The Linux container passed compiler, static analyzer and protocol-only controls, including the
shared deadline and launcher fixtures. This does not attest Linux kernel containment or an installed
Linux cross-version update. Windows manifest, signing/repack and shared protocol regressions were
checked; no full Windows installed-product run was performed. Existing Windows Authenticode checks
remain enforced.

The already published 1.2.5 reader cannot acquire future impact entries from the offered manifest.
The verified local bootstrap repairs that reader without rewriting existing release assets. A
subsequent production-signed public release remains necessary to demonstrate an automatic update
from this SSD installation to a new public version. Production signing here means Keiko's Ed25519
release trust; an Apple Developer account is not required. The owner subsequently requested the
current published Latest version as the SSD baseline, followed by release 1.2.6 and a live SSD
update after successful deployment. That release and installed-product acceptance remain pending.
Auto-merge remains disabled.

## Release qualification follow-up (2026-10-22)

The full macOS coverage run at `77d6660e3` passed 57,282 package tests, 10,868 UI tests and
7,645 script tests. All 27 package coverage floors passed. Local new-code coverage still reported
84.2 percent against the unchanged 85 percent requirement; that result was not accepted as green.

The follow-up adds real filesystem controls for managed runtime admission, including modified
launchers, foreign platforms, corrupt registrations and failed setup. Separate transport admission
controls reject workers and foreign launch identities before touching the private control descriptor.
The complete affected CLI suite and owning server/tooling controls pass 1,566 tests across 86 files
with one skipped test. An earlier mixed-source build/test attempt failed three support controls;
a stable rebuild, all 109 affected support controls, and the complete affected suite pass afterward.
Builds and catalog regeneration must finish before tests consume the emitted CLI.

Three existing native qualification programs now use the repository's existing test filename
conventions. Their consumers remain wired to the actual native lanes; no product source, rule or
coverage threshold was excluded or weakened. The macOS qualification runner uses `node:test` with
explicit asynchronous assertions. Startup cleanup uses lazy asynchronous timer iteration, retaining
sequential reconciliation, exponential backoff and the original completion deadline.

The native handoff fixture's readiness observation now uses its existing admitted 15-second startup
grant. Previously it rejected readiness after 10 seconds despite admitting 15 seconds. The product
startup grant and all handoff, cleanup and containment assertions remain unchanged.

Coverage aggregation retains the successful full-run measurements for unchanged product sources and
uses fresh affected-suite measurements for the changed startup source. Istanbul's standard merge
and report writers produce the combined reports; stale source offsets and failed-run reports are
not reused. This qualification does not replace the pending public-release update on the SSD.

## Kernel-coalition application acceptance (2026-10-22)

The committed coalition implementation `22f674821` completed a normal full-application stop after
2,256 seconds (over 37 minutes); the PID record was removed by the normal stop path. The earlier
ancestry implementation had failed after 1,665 seconds. This longer run used the complete packaged
application with an isolated state directory, not only a native process fixture.

A fresh isolated full-application update fixture with the coalition implementation completed
**99.0.0 → 99.0.1 → 99.0.2**, preserving its synthetic workspace marker and synthetic key-file digest.
Both sessions reached `succeeded`, and the final application stopped normally. Its release transport
and Ed25519 test trust were process-local fixture inputs; no fixture bundle or trust was installed on
the SSD. This does not replace public-release acceptance.

The SSD baseline was normally stopped, its genuine reaped receipt retained, and its closed state and
original application backed up inside the encrypted work volume. The local 1.2.5 bootstrap now uses
the committed coalition native components. All 17 existing record identities remain: 16 rows retain
every value, while the workspace project's `last_opened_at` advances through the existing startup
`createProject`/UPSERT path. All other existing column hashes and the key file, launcher secret and
private wrapper bytes remain unchanged. The resolved configuration loads its three providers. The
actual packaged UI loads with zero page errors or CSP violations. The provided Close command normally
ejects the work image, and the provided Open command remounts it through the existing keychain and
starts Keiko again. Public 1.2.6 deployment, actual SSD update and final physical-eject acceptance
remain pending.

Review follow-up adds failure-first controls for an early bridge setup error and an unavailable GUI
login domain. The existing KRS1 observation error is emitted before descriptor transfer. After rights
transfer the job remains the sole response writer, including a lost installation acknowledgement;
a real transferred-descriptor negative control requires exactly one error frame. GUI admission uses
a bounded read-only domain query, and timeout cleanup reaps its owned query process.

The earlier-head Intel macOS CI failure in the unchanged OpenCode cold-refusal test was replayed
locally: the exact test and its complete 68-test native-host suite pass on this ARM Mac. Intel
execution is unavailable locally (no Rosetta); the required Intel CI lane remains authoritative.
The Firefox Files journey's lost click was reproduced in a Linux browser event trace: a retained
folder receives `pointerdown`, then an asynchronous status line changes its position before
`pointerup`, which targets the tree's free area. Two deterministic real-pointer controls hold the
directory and Git-status responses between press and release after browser actionability has
settled. Both fail against the earlier rendering. Refreshes retain stable rows and report their busy
state with `aria-busy`; initial empty loads retain their visible loading notice. Git results retain
their reserved line without displaying a message for an ordinary non-repository folder. Existing
read lifecycle evidence remains on the Activity Log. Complete affected browser qualification and
current-head CI are still required before integration or release. Both corrected pointer cases and
the exact failing inline-editor journey pass three consecutive runs each with the patched Next.js
runtime. The complete affected Firefox shard then passes all 61 cases. Its navigation helper also
requires the lazy navigation controls' actual flex layout before the original pointer actions;
functional assertions, timeouts and retry policy remain unchanged.

Fresh broad package qualification records 57,307 passing tests. One suite cannot initialize because
its Darwin-only C adapter still names the retired app-runtime dispatch function. Updating those
inert fail-closed stubs to the two current job entrypoints preserves the actual consumed-root cleanup
code and its assertions; all nine controls pass afterward. The complete fresh scripts coverage run
also passes all 7,657 tests, including that suite. This test-adapter correction changes no production
Node source or coverage offsets. Fresh UI coverage passes all 10,872 tests.

The 2026-10-22 OSV scan newly matched `next@16.3.8` against GHSA-2464-fhr4-w9xw and
GHSA-p3m5-59mp-jv5r. The same local scanner reproduces both findings on the earlier lockfile and
reports no open findings after the aligned `next` / `eslint-config-next` update to the advisory's
patched 16.4.1 release. No exception was added to the vulnerability policy.

The subsequent required scan newly matches three DOMPurify advisories and `ip-address` in both
dependency lockfiles. The exact local OSV invocation reproduces all five findings. Updating the
existing DOMPurify override to 3.4.17 and the two `ip-address` resolutions to 10.7.4 clears them;
the same scanner reports no open findings. Existing vulnerability exceptions remain unchanged.

The subsequent macOS CI restoration failure is reproduced locally. Receipt writers create the
exclusive destination before writing its bytes; the native reader previously treated that visible
empty or incomplete file as a terminal failure. A deterministic C control pauses publication after
creation and fails against that reader. The corrected reader retries unavailable evidence within
the original phase deadline and advances only after full chain validation. Permanent malformed
receipts, wrong kinds and symlinks still fail without advancing the sequence. The complete native
macOS gate passes afterward, including restoration, consecutive handoffs, compiler/static analysis
and all five containment controls. Existing handoff lifecycle evidence remains authoritative.

Intel CI also observes the expected stale-database refusal at 5,262 ms, after the five-second EOF
shutdown helper has already failed. That fresh process is still loading its fixed module graph.
The fragmented-packet test now observes refusal with the same existing ten-second startup helper
as the dedicated stale-database test, requiring no ready endpoint, exit 1 and the constant refusal
verdict. The separate five-second acquired-process shutdown bound is unchanged. All 68 native host
tests pass locally; Intel execution remains CI-owned on this ARM Mac.

The next CI run clears Intel but still fails restoration after consuming nearly the entire cleanup
grant. The native receipt wait previously ignored an already queued private runtime outcome and
waited until the verification deadline before starting recovery. A deterministic C control queues
the canonical failed-root outcome and forbids idle waiting; it fails against that implementation.
The wait now reports unavailable verification as soon as the private outcome is readable, without
consuming or trusting it. The existing stop/reconcile path must still read the complete zero-live
frame, reap its exact child and validate the durable owner receipt before restoration can proceed.
The exact restoration replay then passes in 28.4 seconds within the original unchanged plan grants.

The following macOS CI failure reaches the second successor's `start/completed` receipt but its
fixture stops observing after 15 seconds, before the plan's verification and cleanup deadlines.
Six ordinary local restoration/re-update runs pass. Delaying the second successor's JavaScript
startup by 16 seconds then reproduces the same provisional-owner/missing-verification failure
against the old observation cutoff. The fixture now derives its remaining observation time from
the admitted plan's absolute cleanup deadline, without extending any native phase grant. The same
delayed-start control passes afterward, including restoration, the subsequent update, ownership,
environment/data markers, receipt completion and normal final shutdown. That delay remains in the
restoration fixture as a regression control. Failed observations now include the expected version,
elapsed observation, expected-owner classification and receipt timestamps; invariant assertion
failures propagate immediately instead of being retried as transient connection failures. This
establishes a test defect and does not by itself establish the cause of every prior hosted failure.
Public-release deployment and the actual SSD update/eject acceptance remain required.

Local qualification of this fixture correction passes the complete macOS native gate, including
compiler/analyzer checks, all three handoffs and all five containment controls, plus scoped ESLint,
Prettier, JavaScript syntax and the real local Sonar analyzer. The separate hosted elapsed-deadline
failure passes its exact replay on macOS and in the pinned Linux Node 24.18 container; its complete
189-test suite also passes on macOS. The Windows fixed-entry EOF failure passes its exact replay on
macOS, which does not qualify the Windows behavior. Neither unrelated failure has a reproduced
cause yet; their required hosted lanes must pass before integration.

The receipt and acknowledgement unit controls now advance a test-owned monotonic clock at each
retry and publish pending evidence through an explicit test hook. They perform no real sleep:
exact retry counts and clock values assert both successful publication and the original timeout
boundary. Native process integration continues to use the real clock; product code is unchanged.

### First production release build after PR #4056

PR #4056 was integrated as signed commit `53d88924c16289f6f368d9a29cc911b31abe8813` after
all exact-head required checks passed and every review conversation was resolved. Owner release
request 39848103550 bound `v1.2.6` to that commit. The Linux production build 39848171761 then
failed before qualification because its manifest reader still imposed the 256-KiB receipt limit.
The embedded stable-release catalog alone exceeds that limit. Staging and the installed updater
already admit manifests up to 1 MiB.

The Linux signing reader now imports the installed updater's existing manifest bound. Receipt and
Sigstore bundle limits remain 256 KiB. Failure-first controls exercise the actual catalog and the
exact manifest boundary; oversized manifests, receipts and bundles remain rejected. The existing
Linux staging test now hands its real generated manifest to the production preparation function,
including payload rebinding, instead of stopping before that release boundary.

The same integrated commit exposes GitHub's skipped-job name behavior: job-level lifecycle name
expressions remain unevaluated when the verified-tree path skips `ui` and the package build. The
release verifier previously classified both required checks as missing. It now recognizes only
the existing strict lifecycle-name grammar for completed, skipped checks. That produces a skipped
verdict, never success: the existing same-app, identical-tree evidence is still mandatory. Tests
reject different apps, unknown expressions, inactive names and successful or failed expression
names, and preserve a newer canonical failure. Both positive regressions fail before their fixes.
Publication and the actual production-release SSD update/eject proof remain pending.

### Browser fixture failures during PR #4061 qualification

The metadata-triggered CI run 39864904899 retained a WebKit failure in the Workbench stop/retry
journey. Its trace contains no retry POST: the fixture root is absent from the real repository
catalog and its unmocked branch reads return 400. The ready-runtime fixture now serves the
catalog entry and branches derived from its existing active-workspace fixture. Other roots and
non-GET requests still reach the real server. Two focused controls fail before that correction;
all 24 route-fixture controls pass afterward, including missing, empty, malformed,
traversal-shaped and trailing-slash branch roots.

A later Chromium attempt fails the Composer/Voice grounding-parity journey: the second page
restores the first page's Composer window instead of its seeded Voice window. Both pages share
localStorage while the first page can still persist its workspace layout. The journey now closes
the completed Composer page before opening and seeding the sequential Voice page. Its grounding,
accounting, citation, persistence and playback assertions remain unchanged. These changes repair
test preparation; they do not establish the pending production-release SSD acceptance.

### Real catalog review admission before publication

Passing the actual repository catalog through authenticated-catalog admission and update-impact
resolution for 1.2.5 to 1.2.6 reports the target as unreviewed. Its approval reference is a GitHub
URL, while installed readers require the existing canonical audit-reference form. The catalog now
encodes that same owner comment as `github-issue-comment:oscharko-dev/Keiko#4056#6323955124`.
Release authority and runtime admission guards remain unchanged. The existing real-catalog suite
now resolves the actual latest target from its preceding stable version, so validation of the
catalog shape alone cannot hide another review-admission mismatch. That regression fails before
the metadata correction. The historical runtime comment now reflects ADR-0177's retirement of
live GitHub authorship verification.
