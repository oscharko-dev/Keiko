# Portable updater repair evidence (#4055)

Collected on macOS arm64 on 2026-10-21 for
[PR #4056](https://github.com/oscharko-dev/Keiko/pull/4056), targeting `dev` with auto-merge disabled.
This ledger distinguishes full-package fixture updates, the existing SSD installation, and release
acceptance. It does not attest a new public release.

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
