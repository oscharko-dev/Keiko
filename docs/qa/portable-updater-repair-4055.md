# Portable updater repair evidence (#4055)

Collected on macOS arm64 on 2026-10-21 for
[PR #4056](https://github.com/oscharko-dev/Keiko/pull/4056), targeting `dev` with auto-merge disabled.
This ledger distinguishes full-package fixture updates, the existing SSD installation, and release
acceptance. It does not attest a new public release.

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
The Firefox Files journey also fails in CI and intermittently in the Linux local shard; its root
cause is still under investigation, so this change is not yet ready for integration or release.
