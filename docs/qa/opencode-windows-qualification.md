# OpenCode Coding Workbench: Windows qualification

Issue [#4068](https://github.com/oscharko-dev/Keiko/issues/4068), parent epic
[#3897](https://github.com/oscharko-dev/Keiko/issues/3897). Execution date: **2026-10-26**.

## Decision and current result

The task owner selected **qualification of the existing mapped profile**, with the remaining
native gaps explicitly retained, on 2026-10-26. Windows continues to select `direct` through
`productionOpenCodeToolProfile`; this is not native OpenCode parity. No native filesystem policy,
release approval, runtime package approval, or authority ceiling changes in this increment.

**Overall result: customer Workbench launch remains unqualified.** The production adapter now
selects SCM/WFP for a release-qualified Windows x64 package with a pinned supervisor. The
installed adapter proof and the separate Windows Workbench UI observation appear below.

The dependency on [#4064](https://github.com/oscharko-dev/Keiko/pull/4064) is satisfied: it merged
into `dev` at `37b1ee9d0c6308b1a59eef3470aa47036fb8362b`, the fetched base of this qualification.
All W1–W15 acceptance groups remain open. Individual component results below do not close their
broader Workbench acceptance group.

## Revalidation on 2026-10-28

Completed CI for head `867c14540b516fee1940ad3d3f340b65ecfc5091` confirms that the earlier
merge-candidate race is resolved. In [run 40591821995](https://github.com/oscharko-dev/Keiko/actions/runs/40591821995),
the Windows, macOS and Linux cross-platform jobs, all four portable secure-read jobs, core quality,
semantic duplication and UI jobs pass. The [Windows job](https://github.com/oscharko-dev/Keiko/actions/runs/40591821995/job/122497875743)
executes native quality, supervisor cleanup, setup bootstrap, checkout binding, Git reparse,
command-wrapper and installable-package smokes successfully. Customer-shape run 40591806766,
CodeQL and Dependency Review also pass. These are component and package checks; they do not
establish an admitted Windows Coding Workbench or add a Windows npm runtime approval.

Both failed test jobs have exactly one failure, the unchanged helper-source approval pin:
package coverage shard 1 has **15,671 passed, one failed, 101 skipped**, and Node 26 compatibility
shard 1 has **30,265 passed, one failed, 222 skipped**. The aggregate coverage/SonarCloud and `ci`
jobs consequently remain red. No source pin, binary approval or gate assertion is relaxed.
PR #4090 remains unchanged at `38f7e01d432e283ca14c21e9f7e650c4085559d0`, and PR #4088 has no
inline review threads. Production gateway availability is still blocked.

The continuation integrates completed `dev` through `246efd4638066b26cfb50ee329e6d3c099599f66`
(Keiko 1.3.1, #4097, #4102 and #4116), without importing the unfinished gateway branch. The CI
results above remain bound to their earlier head and must not be relabeled as results for this
new merge. Fresh `npm ci` installs 989 packages; build, typecheck/package graph, scoped ESLint and
semantic duplication pass (932 baseline groups).
Architecture and negative architecture checks, final formatting, relative documentation targets
and `git diff --check` also pass. Required local Sonar completes without unresolved findings
(analysis task `fb3525a3-0ad5-4ea7-9f8d-3973ab79d7c8`). The two repaired suites pass separately
with **97/97 tests**; the three new storage controls also pass independently. Their focused run
filters out the other 72 retention cases and does not replace the full-suite result below.

### Windows session persistence components

Eight existing session/history/export/import suites were executed on native Windows with
Node 24.18.0 and synthetic, isolated test data. The initial run produced **449 passed, six failed**.
Two failures were fixture defects: the export assertion used `/` to split a real Windows path,
and a continuation assertion opened a SQLite database without closing it, preventing Windows
fixture cleanup. The assertions now use the host path basename and close the connection in
`finally`; export redaction, exact message counts and cleanup requirements remain unchanged.

The existing retention suite now also exercises:

- A real WAL writer with an open transaction: retention and checkout contain only the three
  committed messages; after commit the same operations contain all four messages.
- A real exclusive SQLite lock: retention raises `SQLITE_BUSY` (code 5), leaves both prior
  database and manifest byte-identical, removes staging, and keeps the previous entry readable.
  Retention succeeds again once the writer closes.
- A real Windows directory junction as the retention root: retention refuses it and the target
  stays empty. This adds Windows reparse evidence without replacing the existing symbolic-link
  refusal test.

On the integrated 1.3.1 tree, all three new cases and both repaired suites pass. The complete
eight-file selection yields **461 passed, four failed, zero skipped**. Seven files pass; the
retention file has 71 passes and four unresolved Windows observations:

- Two assertions require Unix owner-only mode bits. Windows reports other mode bits, and the
  current `chmod` checks do not qualify Windows ACL isolation. This execution neither proves
  that another account can read the data nor certifies that it cannot.
- Creating the original symbolic-link fixture fails with `EPERM` on this developer host. The
  passing junction case is separate evidence, not a substitute for that symlink proof.
- The 5,000-character filename fixture does not raise its expected `ENAMETOOLONG` on Windows.
  An isolated native Node 24.18.0 `lstat` probe confirms `ENOENT` for that path component, which
  the store classifies as an absent source. The expected error-propagation assertion remains
  in place and is not counted as passed.

The SQLite files use the producer-derived persistence schema with synthetic rows. No original
OpenCode service, model turn, Workbench restart/resume/fork, or installed upgrade is executed by
these suites. W9 advances to partial storage-component evidence and remains open alongside W1.

### Retention-root redirection repair

Further native Windows qualification reproduced a productive defect: `retain` rejected a linked
retention root, but `checkout`, `prune` and `remove` traversed a root replaced with a real directory
junction after retention. Three regression cases failed before the repair. They use only isolated
synthetic state; no application or customer state is involved.

The existing root validation now runs at every public store entry point. A non-directory,
symbolic link or junction raises `retained-root-invalid` before entry traversal. Absent roots
retain their normal no-state/no-op behavior. All three regression cases pass after the repair,
including byte-identical target database/manifest and unchanged directory contents. A fourth
production-composition case proves that startup pruning preserves a canary in the redirected
target and records exactly one existing `coding-runtime.session-continuity` warning with the
startup correlation, `errorKind: internal`, `action: prune`, `outcome: failed` and `reason:
copy-failed`. Its serialized event contains no fixture path and passes the existing log proof.
The startup/continuity suite passes **27/27**. The full eight-file selection now gives
**465 passed, four failed, zero skipped**; the four previously recorded platform observations
remain unchanged. No POSIX permission assertion or symlink/error-propagation test is relaxed.

This fixes deterministic redirection of the configured root between operations. It does not
qualify ancestor containment, concurrent pathname replacement, Windows ACL privacy, or the
original-runtime Workbench. The shared security owner already labels its Windows permission
assurance `platform-inherited`; Unix mode bits cannot establish a Windows DACL proof.

Build/typecheck, scoped ESLint, formatting, semantic duplication and the ADR index pass. The
Activity Log aggregate initially cannot start its prerequisite on Windows: its default runner
directly spawns the resolved npm command with `shell: false`. Running the same seven-step gate
through its existing runner injection, with the qualified Node executing npm's CLI directly,
executes every constituent. Six checks pass: build, registry (97 tests), failure paths,
architecture, negative architecture and release impact. The scenario check remains **failed**:
126 passed, 17 failed, five skipped across 11 files. All failures are in the unchanged
`support-report-cli.test.ts`, involving Unix mode/private-permission expectations or local
symlink privileges. No scenario is removed or counted as passed, and no successful aggregate
verdict is claimed. The storage failure's own production-composition/log proof passes above.
The required local Sonar rerun passes without unresolved findings (analysis task
`a9e5d336-93f3-4a07-bd12-8946a74a7a2a`). On the preceding pushed head `ae8b28957`, customer-shape,
CodeQL, Dependency Review and Workflow hygiene have completed successfully; both full CI runs
remain queued at revalidation. These results do not include the subsequent root-validation fix.

### Activity Log gate launcher repair

The Windows gate-launch defect above is reproduced by an actual child-process regression: the
existing runner returns failure before its synthetic npm script can execute. The gate now uses
the existing host-executable owner to select npm's installed CLI and starts it with the current
Node executable, preserving `shell: false`. It does not use an environment-provided
`npm_execpath`, fall back to a shell, or change the seven constituent scripts.

The regression passes after the repair, including a path with spaces, Unicode, `&` and `%PATH%`,
and a nonzero child exit still fails. Missing CLI files, workspace-local targets and a real
directory junction redirecting the CLI outside the selected npm installation are refused.
The two affected suites pass **91 tests**, with **nine existing platform-specific tests skipped** on
Windows. These skips are separate from the five new passing regression/containment cases.

The regular `npm run check:activity-log` now executes **all seven steps without runner injection**:
six pass, the scenario step fails with the same **126 passed, 17 failed, five skipped**, and no
step is omitted. Its nonzero aggregate exit is preserved. The failing file remains the unchanged
support-report CLI suite described above. Build, TypeScript, package graph, scoped ESLint,
formatting, semantic duplication (932 baseline groups), both architecture checks, release impact
and ADR index pass. This repairs execution of the gate, not the remaining Windows support-report
permission/symlink observations or Workbench launch boundary.
The required local Sonar rerun also passes with no unresolved finding on the changed files
(2026-10-28, scanner completion 18:45 UTC; scanner duration 7 minutes 18 seconds).

On head `aa7319b82d201235c69cf09d497e460c8350feaf`, Dependency Review, Workflow hygiene,
customer-shape qualification and CodeQL now pass. Both full CI runs remain incomplete at this
revalidation; these partial results are not a complete current-head CI verdict. The gateway PR
#4090 remains unchanged, so the production Windows launch blocker remains open.

### Retained-entry boundary repair

The next Windows increment reproduces redirection below the already-validated retention root.
A retained entry replaced with a directory junction was accepted by checkout and kept by pruning;
stored manifests and databases with another hard link were also accepted. Four native regression
cases fail before the repair. They use synthetic runtime-schema databases and real NTFS links.

The store now checks the entry itself with `lstat` before reading its manifest. Retained manifests
and databases must be regular, single-link files; final symbolic links and hard links are refused
before reading/copying the stored file. Checkout returns the existing `integrity-failed` result
and removes the invalid entry, while pruning counts redirected entries as invalid. The runtime's
source-database input semantics remain unchanged.

All four regressions pass after the repair. Two additional read-only hardlink cases prove that
refusal preserves both external file bytes and its read-only attributes. A seventh production
composition case confirms startup removal of a redirected entry, an unchanged external database,
and exactly one existing `coding-runtime.session-continuity` event with the startup correlation,
`action: prune`, `outcome: pruned`, `prunedCount: 1` and `entryCount: 0`. The event passes the
registered Activity Log proof and contains no fixture path; the generated failure-surface
inventory now includes this proof site.

The wider session test selection additionally exposed two path-fixture defects in the native
session-tree suite. Its workspace and moved-directory fixtures now use host-absolute normalized
paths. The previously failing directory tracking and two-job cancellation assertions remain
unchanged, and all **31 session-tree tests pass** after the fixture repair.

The final expanded selection covers ten complete retention, continuation, session-tree, history,
export and import suites: **489 passed, four failed, zero skipped**. The four failures are the
previously documented retention observations (two Unix permission assertions, local file-symlink
privilege and the overlong-filename error behavior). No assertion was relaxed or omitted. Build,
TypeScript/package graph, scoped ESLint and semantic duplication (932 baseline groups) pass.
After regenerating the proof inventory, the complete Activity Log gate again executes all seven
steps: six pass, including all 97 registry tests, and the unchanged support-report scenario step
has 126 passes, 17 failures and five skips. Architecture, negative architecture and release-impact
checks pass; the aggregate remains nonzero and no complete gate pass is claimed.
Required local Sonar passes on the final source/test set with no unresolved findings
(analysis task `fb4b484b-2564-4504-ac52-2dcc27606d68`, 2026-10-28 19:10 UTC). Final formatting,
ADR index and `git diff --check` also pass. No inline review threads are present on PR #4088.

These are deterministic entry/file-link and component proofs, not atomic filesystem-race,
Windows ACL, native-service or full Workbench qualification. The production gateway and source
approval blockers remain open; no W1–W15 acceptance group is closed.

### Windows npm tooling and archive-list parsing

Native Windows execution reproduced the remaining direct-`npm.cmd` start failure in the audit
runner and runtime-candidate packing owner. Both regression cases fail before the repair; the
actual local npm pack fails with `EINVAL`. The audit, OSV waiver-scope, root/workspace SBOM,
release-alignment, runtime-candidate pack and non-managed tool-consumer qualification scripts
now reuse `hostNpmInvocation`, the same trusted shell-free owner as the Activity Log gate.
Arguments, environment/retry limits, advisory verdicts, byte checks and approval gates remain
unchanged. The POSIX release-publishing and canonical performance lanes are outside this Windows
tooling qualification; no package is published and no runtime approval is changed.

The audit regression runs a real local child with synthetic output: literal arguments survive,
exit zero succeeds and an advisory exit remains nonzero. The pack regression uses real npm
11.16.0 with an isolated synthetic package, paths containing spaces/Unicode/shell metacharacters,
and a deliberately failing prepack script. Packing succeeds with `--ignore-scripts`, contains
exactly the intended files, and its reported SHA-512 integrity matches the actual archive bytes.
This is a pack-launch proof, not a Windows OpenCode runtime package qualification or a live audit
against current advisory feeds.

The complete tooling suites also exposed a host-path fixture error and a productive archive-list
parser defect: native Windows tar emits CRLF, but the qualifier split only LF and consequently
misclassified directory/file names. The parser now recognizes CRLF and LF line boundaries without
trimming archive paths. The real staged-package fixture passes; added-file inventory drift and
changed file bytes still fail the existing exact-content checks. The builder's output-path fixture
now supplies a host-absolute path. Its existing macOS candidate `0755` executable-mode assertion
remains unchanged and fails on this Windows filesystem; this is not a passing macOS build proof.

The final seven-suite tooling selection reports **197 passed, one failed, 13 existing platform
skips**. The sole failure is that unchanged macOS executable-mode assertion (`0755` expected,
Windows reports `0666`). Scoped ESLint/Prettier, package build/typecheck/package graph, semantic
duplication (932 baseline groups), shell-spawn guardrails and `git diff --check` pass.
The regular Activity Log command again runs every step: six pass, the scenario step reports
126 passed, 17 failed and five skipped; aggregate exit 1, zero omitted steps. The unchanged
support-report permission/symlink observations remain open. Architecture, negative architecture,
failure-path and release-impact checks pass; this is not a green aggregate qualification.

The required local Sonar scan passes with no unresolved finding on the changed files (task
`0629cfa1-499f-4ee7-902c-7e90147c227c`, 2026-10-28 19:33 UTC). Its final source scope includes
all six tooling owners and all three changed regression suites.

On preceding head `acc954287`, Dependency Review, Workflow hygiene, CodeQL and customer-shape
qualification have completed successfully. Both CI workflow runs are still queued at revalidation.
Draft gateway PR #4090 remains unchanged since 2026-10-26. Neither observation qualifies this new
tooling increment or closes the gateway/source-approval blockers.

### Windows Activity Log scenario fixtures

The next continuation reproduces all 17 support-report CLI failures on head `f94dc59d3`:
85 passed, 17 failed and five skipped. Inspection confirms the production filesystem owner already
reports Windows permissions as `platform-inherited`; Node's Unix mode bits do not attest an NTFS
DACL. No production permission, publication, report-sufficiency or link-refusal rule is changed.

The existing scenarios now additionally plant real Windows directory junctions (including dangling
junctions) and retain hardlink and original file-symlink cases on both platforms. Only native
Windows `EPERM` while creating a file-symlink fixture is reported as an explicit privilege skip;
other errors fail, and privileged Windows CI can still execute the original pins. Reachable
canaries prove live redirects resolve
before the operation is refused. The checks retain target contents, modes, no-overwrite behavior,
missing dangling targets, absence of success events and the failure lifecycle. Default-directory
and Activity Log alias controls also run with native Windows junctions. Replay creation asserts
the existing Windows pre-open `unsafe-target` refusal; POSIX file symlinks and existing regular or
hardlinked files retain the exclusive-create `target-exists` assertion.

Published files must remain regular and single-link. POSIX retains exact `0600`/`0700` assertions;
Windows export completion must state `platform-inherited`, never verified privacy. Two POSIX-only
mode-refusal cases are explicitly skipped on Windows because `chmod(0644/0444)` cannot express the
ACL condition they test. Two new Windows cases verify readable read-only report/segment files,
unchanged read-only attributes and the existing inherited-assurance contract. The formerly skipped
default-directory redirection case now executes on Windows. These are component and fixture
repairs, not NTFS ACL isolation or Windows file-symlink privilege qualification.

The final eleven-file scenario selection reports **144 passed, zero failed, 15 skipped**. Nine
skips are the preserved file-symlink cases, which cannot create their fixtures without Windows
symlink privileges on this host. Six are explicit platform cases: the two POSIX mode-refusal pins,
the existing browser-download mode pin, two POSIX write-permission cases and a macOS firmlink
control. Native junction/hardlink and Windows inherited-assurance cases execute normally. The
operation-catalog checks pass 97/97; regenerating the inventory produces no content change
(608/608 proofs and 30/30 scenarios resolved). Scoped ESLint, strict typecheck, Prettier, semantic
duplication (932 baseline groups) and `git diff --check` pass. POSIX execution remains for the
corresponding CI hosts; native Windows results do not substitute for it.

The regular `npm run check:activity-log` command now **passes all seven checks**, with zero failed
or omitted steps (202.5 seconds). Its build, registry, scenarios, failure-path, architecture,
negative-architecture and release-impact checks all pass on the final expanded fixture matrix.
The required local Sonar scan also passes with no unresolved finding on the changed files (task
`8ae7c84f-b215-4dcf-afca-bd6da65294db`, 2026-10-28 19:56 UTC). The earlier scan was stopped after
the file-symlink matrix was retained; only this final frozen-source scan is the delivery verdict.

### Windows update image locks and handoff paths

The continuation from `53fdbc5be` extends the existing mandatory native cutover probe with a real
`SEC_IMAGE` mapping of a private copy of the probe executable. The mapped candidate refuses an
independent write-open and atomic replacement. The old active file retains its bytes and file ID;
the candidate retains its full executable bytes and file ID. After unmapping and closing the
image handles, the same candidate replaces the active name successfully, keeps its candidate file
ID, and leaves no pending name. This uses the existing production atomic replacement owner,
without a mocked sharing failure or a fallback to copy/delete.

Native MSVC `/std:c17 /W4 /WX /analyze` compilation and actual execution pass on the recorded
Windows/NTFS host: `image-locked=1`, `image-recovered=1`, and all existing allowing/denying-handle,
invalid-candidate, pre/post-termination and contention controls pass. Flush checks report
38/38 before and 42/42 after. The measured probe source SHA-256 is
`83e72d3a8e6dd9a0170a0e6b9f79056847d5edc622530da0ec5a4e42c18a9ea5`; the locally compiled test
binary SHA-256 is `35da99260b9354ef275d6bbe496be2deaf4c15af1e06bc304f135c29cc85d854`.
These are test-probe identities, not runtime/helper approvals. The Windows native-quality gate
already compiles and executes this probe; its existing wiring test now additionally pins that
source, compile invocation, execution and both failure exits. The complete host-changing gate
(including its SMB-share qualification) was not rerun locally; the new native probe itself ran
with the gate's compiler/analyzer flags. Current-head CI remains required.

The six-file generation/handoff/recovery/startup selection initially reports 122 passes, three
failures and one skip. One failure exposes a production path-grammar defect: when inspecting
POSIX package paths on Windows, the layout owner joined their children with the host's Windows
path API. It now explicitly selects `posix` for POSIX syntax and keeps `win32` for drive/backslash
syntax. Exact Linux/macOS child paths and forward-slash Windows drive paths are checked without
changing any release, provenance or generation admission rule.

The other failures occur while creating privileged symlink fixtures. Original directory/file
symlink controls remain executable and explicitly report Windows `EPERM`; separate native
junction controls now verify publication-path and plan-file redirection, reachable positive
controls and unchanged target contents. The oversized-file refusal is a separate test so missing
symlink privilege cannot hide it. The final six-file selection passes **126 tests, zero failures,
three skips** (two unavailable symlink fixtures and the existing POSIX canonical-plan case).
Scoped lint, strict typecheck, formatting, duplication (932 baseline groups) and diff checks pass.
The full regular `npm run check:activity-log` also passes all seven checks in 199.7 seconds:
registry 97/97 and scenarios 144 passed, zero failed, 15 explicit skips. Local Sonar passes with
no unresolved findings (task `569fe986-bf5c-437c-82b1-aa3f7a633816`, 2026-10-28 20:21 UTC).

This is a native image-lock/recovery component proof and a layout repair. It does not execute an
installed Keiko upgrade, original runtime restart, Authenticode release chain or Workbench task;
the image is mapped as executable code but is not a running installed Keiko process. W13 remains
partial, and gateway, source-approval and Windows npm publication blockers are unchanged.

### UI source-evidence CI repair

CI run [40759101186](https://github.com/oscharko-dev/Keiko/actions/runs/40759101186) on the preceding
head `53fdbc5be` reports 11,785 UI tests passed, one failed and one skipped. Its sole failure is the
source-input binding in `globals.css.test.ts`: the earlier Windows npm launcher repair changed the
shared `host-executable.mjs`, invalidating all four visual proof documents. The exact test also
fails locally before repair. The original component, editor, accessibility and running-app producers
were executed again on Windows with the pinned Chromium; all pass, including 427 component probes,
14 editor reference captures, seven accessibility modes and 108 running-app screenshots. The full
stylesheet/evidence suite then passes **281/281**. No source hash was manually rebound and no
producer, fixture, inventory or assertion was relaxed. The evidence and environment are recorded in
[the existing producer record](../design-system/evidence/1300/README.md).

These are seeded static-export UI fixtures, not a working model-backed Windows Workbench or an
installed update qualification. The source-approval and gateway/service blockers remain. The earlier
CI run is not evidence for the new commit; required CI must rerun on its exact head.

## Revalidation on 2026-10-27

The continuation starts from PR #4088 head `475e91a3f9745a70a3371400c9fe265adf363bae` and
integrates completed `dev` work through `44cfbbb3e` (Keiko 1.3.0, including #4092, #4080, #4095,
#4096 and #4098). The original environment and artifact observations below retain their original
source identity; this merge does not turn them into release or final-head evidence.
The public [Keiko v1.3.0 release](https://github.com/oscharko-dev/Keiko/releases/tag/v1.3.0)
was published at 2026-10-26 22:53 UTC (2026-10-26 23:53 Europe/Berlin). Publication does not add
the absent Windows npm runtime target or reconcile this branch's changed helper source pin.

The latest completed [CI run 40403258236](https://github.com/oscharko-dev/Keiko/actions/runs/40403258236),
its duplicate run 40403248564, and customer-shape run 40403248664 failed before functional tests
at `Verify pull-request merge candidate consistency`. The event expected base
`1c4464abbf1b352d3c280e7c67d9dcf2f1b22f10`, but the checked-out GitHub merge commit
`d2bcb8dc4dd6f91fc79a713d2e13346d0c309364` had release commit
`f9b26cc59b8f5a383fc88775114a3397da0bd67e` as its first parent. This is a base/merge-ref race,
not evidence that those platform tests executed and failed. Dependency Review, Workflow hygiene,
CodeQL and semantic duplication passed. The consistency guard remains unchanged; the updated
feature branch requires a fresh GitHub merge candidate and new current-head results.

The sole merge conflict was the generated semantic-duplication baseline. Regenerating it with
the existing shrink-only producer preserves both changes and reduces 933 groups on `dev` to 932.
Fresh native Windows `npm ci` installs the current lockfile (989 packages, zero audit findings);
build, typecheck and package graph pass. Nine affected test files yield **138 passed, one failed,
five skipped**. The failure is the unchanged macOS native-profile PATH fixture constructing a
POSIX policy with Windows temporary paths (`runtime-gateway-policy-invalid`); the five skips
remain explicit foreign-platform proofs. The real supervisor harness separately passes ordinary
and detached descendants, cancellation and control EOF against the retained quality-build binary.
Changed-file ESLint/Prettier, semantic duplication, architecture and negative architecture checks
also pass; all five relative documentation link targets resolve.
The required local Sonar rerun passes without unresolved findings (analysis task
`965f8eb0-c6f1-406a-a3b7-9e288b35c83e`). Its first attempt aborted with an unresponsive JavaScript
bridge and provides no successful verdict. The retry uses the repository-supported 8-GiB analyzer
heap and, after the merge commit, the normal 19-file feature diff against `origin/dev`.

The two substantive blockers remain unchanged:

- The helper approval test still gives **four passed, one failed**, with approved source
  `88fb376091f406c3fa63c05d0f963d7ba038f650c0824f893ac77089bb30b28b` versus current source
  `29f5e262d3d268b9785a1a2ae7a2875107a5ce106f1cb7d655ec37e97bf0249b`.
  No runtime approval, source pin or assertion is changed.
- [PR #4090](https://github.com/oscharko-dev/Keiko/pull/4090) remains draft at
  `38f7e01d432e283ca14c21e9f7e650c4085559d0`. Installed service/state machine, helper/server
  composition, restart reconciliation, installer/runtime packaging and actual Workbench execution
  remain outstanding. Production still refuses non-macOS gateway confinement before spawn.
  Its [diagnostic run 40384624097](https://github.com/oscharko-dev/Keiko/actions/runs/40384624097/job/121789510335)
  has completed with failure: the host-to-AppContainer HTTP control still times out
  (`winsock=10060`) for IPv4 and IPv6, including the unfiltered inbound-provisioned controls.

No inline review threads or PR discussion findings were present when rechecked. Full W1–W15
acceptance and merge readiness remain unclaimed.

### Published Windows helper execution

The newly available `v1.3.0` Windows portable archive was downloaded separately, without running
the installer or starting a product instance. Its 193,372,622 bytes match the published manifest
and SHA256SUMS: `47ebc7321bb28c5d6cf18b90c0669c457d6d2b33bfce0e462c2f2a9d9d715410`.
The existing `verifyPortableReleaseTrust` verifies the manifest using Keiko's built-in trusted
public keys (`ok: true`, metadata version 424854975). Only the two uniquely named native helper
entries were extracted; their lengths and hashes match that verified manifest:

| Helper                | Bytes   | Published and measured SHA-256                                     |
| --------------------- | ------- | ------------------------------------------------------------------ |
| Runtime supervisor    | 115,712 | `8fb041805d804904bfe89684b8122e4f78bd217ab28693b50c6fbaf6fc255578` |
| Secure workspace read | 129,024 | `1bebc2ccfc3fe1b0f9f5a8ce07219303c58939612c433c7bb2661cc6579b64f3` |

The existing native harnesses execute these exact release bytes:

- `node native/runtime-supervisor/test-protocol.mjs --helper <extracted-supervisor>`:
  **PASS**, ordinary and detached descendants, cancellation and control EOF, with real live-PID
  positive controls and disappearance checks.
- `node native/secure-workspace-read/test-protocol.mjs --binary <extracted-secure-read>`:
  **PASS**, including spaces/Unicode, case/root aliases, long paths, ADS/device namespace refusal,
  file-generation and ancestor-alias consistency. All 32 file-generation reads observe known
  bytes, with nine mutation attempts, eight after spawn and five sharing denials. Load observations:
  1,000 sequential reads, p95 5.8 ms; 100 concurrent reads in 406.4 ms; resource delta zero.

This advances W2/W4/W7 component evidence from locally built helpers to published portable bytes.
The release's own signing report and runtime activation trust anchor remain
`evaluation-unqualified`, with no verified Authenticode publisher chain or timestamp. The release
manifest signature proves provenance; it does not replace those platform or product qualifications.
No complete portable install/start, Windows npm package, Workbench model turn, upgrade or rollback
is claimed. The optimized shipped supervisor passing does not invalidate the independently
reproduced unoptimized handle-lifetime defect repaired by this PR.

## Environment and artifact identity

| Item           | Observed value                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OS             | Windows 11 Home 25H2, build 26200.9711, x64                                                                                           |
| Filesystem     | Local NTFS volume; separate Git linked worktree                                                                                       |
| Product source | Keiko 1.2.7, base `37b1ee9d0c6308b1a59eef3470aa47036fb8362b`                                                                          |
| Node / npm     | Node 24.18.0 / npm 11.16.0, isolated toolchain; the host default Node 22.16.0 is outside the declared engine range                    |
| Installation   | Fresh `npm ci --no-audit --no-fund`, 989 packages; package build and typecheck passed                                                 |
| OpenCode       | Approved Windows x64 payload, `opencode v2.1.4`                                                                                       |
| ripgrep        | Approved Windows x64 payload, 15.1.0, revision `af60c2de9d`                                                                           |
| Helpers        | Locally built by the existing dev-lane staging script using MSVC; no release attestation                                              |
| Evidence class | Native Windows component execution and static production-path inspection; not a signed release qualification or model task comparison |

SHA-256 identities of the initially staged executables:

| Component             | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| OpenCode              | `b12b0613e9b4a491e5b12d90a5e9bbae6d261fe9688c82bf73125a036963d399` |
| ripgrep               | `decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408` |
| Runtime supervisor    | `3c4686521deb13747cc18ba68632e978128dbd69471d04302f0cd6e303687e25` |
| Secure workspace read | `717342608116797c0b347aaf6a0f7782d356675033b07ef8139c4e53dae42335` |

The initial extended supervisor harness was run against these exact supervisor bytes. Subsequent
execution of the quality-gate build exposed the handle-array lifetime defect described below;
that defect is now repaired in the supervisor source. The dev-lane source-tree digest
also covers fixture source, so restage after applying this change before testing dev-lane discovery.
Locally compiled helper hashes identify this run, not newly approved distributed binaries.

## Executed checks

Commands are relative to the checkout and use the supported Node/npm toolchain above. Tests ran
on native Windows, outside the agent execution sandbox where it prevented Vitest cache renames.
No customer model, secret, endpoint, workspace, or private runtime log was used. The privileged
WFP follow-up below ran only on a disposable GitHub-hosted Windows runner.

| Command / check                                                                                                                              | Result and limits                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build:packages`; `npm run typecheck`                                                                                                | PASS, including compiler and package graph checks                                                                                                                                                                                                        |
| `node scripts/stage-dev-coding-runtime.mjs`                                                                                                  | PASS: approved 2.1.4 payload and both local Windows helpers staged                                                                                                                                                                                       |
| `node scripts/provision-ripgrep.mjs`                                                                                                         | PASS: pinned archive and extracted `rg.exe` verified                                                                                                                                                                                                     |
| Staged `opencode.exe --version`; `rg.exe --version`                                                                                          | PASS: 2.1.4 and 15.1.0                                                                                                                                                                                                                                   |
| `node scripts/testing/test-windows-gateway-filters.mjs`                                                                                      | PASS: C compiler/analyzer and policy validation. Default mode installs no WFP filters and proves no network isolation                                                                                                                                    |
| `node scripts/testing/test-windows-gateway-filters.mjs --guarded-lifecycle`                                                                  | BLOCKED: the sandboxed attempt compiled and passed policy validation, then returned Win32 `ERROR_ACCESS_DENIED` (5). Privileged filter-state proofs remain assigned to disposable Windows runners; no local socket-proof was run                         |
| `node native/runtime-supervisor/test-protocol.mjs --helper .portable-sidecar-payloads/windows-x64/native/keiko-runtime-supervisor.exe`       | PASS: actual helper, ordinary and detached descendants, cancellation and control-pipe EOF. Both PIDs must be live before cancellation and gone afterward; explicit cancellation additionally requires zero active Job Object processes before completion |
| `node native/secure-workspace-read/test-protocol.mjs`                                                                                        | PASS: source-built helper, protocol, controlled races and load tests. Observed load sample: 1,000 sequential reads, p95 5.6 ms; 100 concurrent reads, batch 386.9 ms; resource delta 0. These are local observations, not canonical performance budgets  |
| `node native/secure-workspace-read/test-protocol.mjs --binary .portable-sidecar-payloads/windows-x64/native/keiko-secure-workspace-read.exe` | PASS after the fixture repair described below, against the same staged bytes: 32/32 known-generation reads, concurrent ancestor-alias proof and load tests; p95 5.7 ms, concurrent batch 387.4 ms, resource delta 0                                      |
| `node scripts/__tests__/windows-git-reparse-smoke.mjs`                                                                                       | PASS: actual Windows Git executable reparse containment                                                                                                                                                                                                  |
| `node scripts/__tests__/windows-cmd-spawn-smoke.mjs`                                                                                         | PARTIAL: real ordinary `.cmd` and npm-shim argv/injection cases and fake/junction SystemRoot refusals pass. The mandatory final file-symlink probe still fails with `EPERM`; the command exits nonzero and reports no overall PASS                       |

Two diagnostic Vitest selections were also executed:

- Baseline: `windows-shell`, `runtime-gateway`, `devLanePortableCodingRuntime`,
  `productionOpenCodeBackend`, `nativeRuntimeProcessBackend`, and `runtimeProcessSupervisor`:
  **227 passed, 27 failed, 25 skipped** across six files. Failures are in the native gateway and
  production-backend suites; POSIX/macOS filesystem fixtures reach host-canonical path validation
  on Windows (`runtime-gateway-policy-invalid`). Platform-specific OS proofs explicitly skip.
  This is not a green Windows suite.
- Focused: `nativeRuntimeProcessBackend.gateway-confinement-logging`,
  `nativeRuntimeProcessBackend.gateway-abstraction`, `nativeRuntimeProcessTree`,
  `check-windows-native-quality`, `build-runtime-supervisor`, and `native-protocol-source-contract`:
  **63 passed, one failed**. The remaining failure is the macOS sealed-helper case reaching the
  same filesystem-policy validation. The four refusal-logging tests pass, including the body-free
  `runtime.confinement.failed` event and refusal before spawn. These are unit tests, not a live
  Workbench service run.

The eight pure `runtime-gateway` policy failures were subsequently isolated and repaired: the
POSIX filesystem capability used the inspecting host's `node:path` implementation. It now uses
explicit POSIX semantics, including normalization and descendant checks, on every host. The full
file passes on Windows (**37 passed, 25 existing macOS OS-proof skips**), including Windows drive,
UNC/device path, root, normalization and sibling/traversal refusal controls. This does not admit a
Windows filesystem capability or enable a native launch. The broader selection still reports
**20 failed, 132 passed, 25 skipped**: those remaining tests construct macOS/Linux native services
using real Windows temporary paths, and one requires unavailable symbolic-link privilege. They are
not represented as successful native Windows or foreign-platform execution.
The direct backend consumer suite `backends.test.ts` also passes all 39 tests on Windows after
this repair. Policy inspection and these seam tests remain distinct from real OS confinement.

A follow-up selection of Windows security/shell, workspace paths/discovery, checkout binding and
portable handoff tests produced **344 passed, 21 failed, 12 skipped** across 11 files. Seventeen
failures came from POSIX-only test roots and path comparisons, or the directory-link fixture:
`paths.test.ts` and `workspacePathDiscovery.safety.test.ts` now use host-absolute paths, and the
native directory-alias case uses real Windows junctions. All **36 tests in those two files pass**
after the repair, preserving denial, incomplete coverage, abort/deadline and root-rebinding checks.
The other four failures in the selection require symbolic-link privileges (system binary identity
and portable handoff files); none was converted into a skip. The checkout-binding suite and
portable discovery suite passed in the initial selection. These component results do not qualify
a running Workbench or installed upgrade.

The native secure-read protocol harness also now exercises spaces and Unicode in actual directory
and file names, ASCII case aliases, alternate root separator spelling, an existing relative path
beyond 260 characters, an existing NTFS alternate data stream, and device/namespace root refusal.
Successful reads must return the exact expected bytes; rejected reads must remain content-free.
Both the source-built helper and the unchanged staged helper pass, together with the existing
link/race/load controls. The staged follow-up observed 32/32 known-generation reads, 11 replacement
attempts (10 after spawn), seven sharing denials, p95 5.5 ms and resource delta 0.

The shell harness now performs its mandatory final-binary symlink probe after its independent
live argv/injection checks. Missing file-symlink privilege therefore leaves useful component
evidence while still failing the complete smoke. No assertion, privilege requirement or exit
status was relaxed.

The existing Windows gateway development workflow also passed on the disposable `windows-2025`
runner: [run 40392166306](https://github.com/oscharko-dev/Keiko/actions/runs/40392166306), exact head
`1048f05e96aefbc6e25c67ed03a5bd7500118368`. It compiled/analyzed the C sources and passed dynamic
filter cleanup, durable-deny guard cleanup after gateway permit revocation, and real AppContainer
socket probes for IPv4 and IPv6. Both process trees and their descendants reached all seven
baseline connections before filtering; with filters, both trees produced five observations with
only the gateway TCP bit allowed, and neither UDP receiver observed a datagram. The policy and
socket proof sources are unchanged by the subsequent path/fixture increment. This is executable
component evidence, not installed-service, crash-recovery or production launch qualification.

The preceding head `5576b9046ffb75bd064517dc6502e6abf4900d07` also completed the hosted
[Windows cross-platform job](https://github.com/oscharko-dev/Keiko/actions/runs/40386177102/job/121803672625).
It passed the full native-quality gate, both supervisor descendant variants, the complete shell
smoke (including its privileged final symlink control), Git reparse checks, checkout binding
(30 passed, one skipped), and handoff fixtures (41 passed, one skipped). Product npm/Yarn smoke
passed with optional dependencies both omitted and included. Those package-install smokes do not
provide a Windows npm coding-runtime package or an admitted Workbench service. The latest path
extensions still require their own current-head CI results.

That earlier CI run was not wholly green: the npm helper-source approval test detected the changed
protocol harness in the pinned source tree, and the macOS coalesced-handoff fixture timed out
without reaching its selected owned version. The source-digest mismatch reproduces locally
(four approval tests pass, one fails). No approval is changed merely to hide this mismatch.
The existing portable helper qualifier now records the binary hash, size, target and source-tree
hash after a successful native build and smoke, before temporary artifact cleanup. This provides
reviewable rebuild evidence without approving or publishing a runtime. Its native Windows tests
and the workflow module-graph suite pass all 12 cases; two existing module-graph fixture path
expectations now use host path separators. Requalification and source-pin reconciliation remain
required before merge. The identity-output increment also passes targeted ESLint/Prettier and the required local Sonar rerun (analysis task `e0c7f39d-724f-4dcb-a389-c9d84f564fff`).

The first ARM64 identity receipt on head `c758a9e1e` passed its native smoke but used the qualifier's
temporary basename `helper`, unlike the npm builder's `keiko-secure-workspace-read`. Its 34,872-byte
artifact is not used to replace the 34,888-byte approval. The qualifier now uses the shipped
basename: the [Mach-O code-signature layout](https://llvm.org/doxygen/MachOLayoutBuilder_8h_source.html)
includes the output filename, so equal compiler inputs alone do not make differently named build
outputs comparable. The six native Windows qualifier tests pass again after this correction.
The full macOS native-quality step on `c758a9e1e` also passed, including the previously failing
coalesced-handoff case; no handoff production code or timeout was changed.

The corrected-basename rebuilds on `abffb2e942c561da20932db4f05ab2343407ed90` both pass native
qualification, but neither reproduces its existing approved binary hash:

| Target      | Rebuilt SHA-256                                                    | Bytes  | Hosted evidence                                                                                     |
| ----------- | ------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| macOS ARM64 | `a94c71bd6ca2bafdf00148e0ce585c082d88d9c0ad3230262cc315170c95621a` | 34,888 | [job 121844786821](https://github.com/oscharko-dev/Keiko/actions/runs/40399793207/job/121844786821) |
| macOS x64   | `27c246af9d5967711d39e7fec2513af7495c52fe25d4d12e32fad8a3babd9eb8` | 18,160 | [job 121844786855](https://github.com/oscharko-dev/Keiko/actions/runs/40399793207/job/121844786855) |

Both receipts bind source tree `29f5e262d3d268b9785a1a2ae7a2875107a5ce106f1cb7d655ec37e97bf0249b`.
The retained approvals are `1c758e0c05e90daac97ed6615ed4f6cc0a324c0304b5ea0d40417fdeb759b6a7`
and `2b722685dc1059a9eec75164e8f5157602a7802cf6a5b27da6f2a9fd78e07ac6`, respectively.
Fetching their pinned source commit `330a71436d0d739bac2cfe7f8dd4c577f6344cf9` and comparing the
whole helper directory confirms that only `test-protocol.mjs` changed; the productive C input is
byte-identical. The build recipe is not identical: since that commit,
`scripts/build-secure-workspace-read.mjs` added `-mmacosx-version-min=13.0` for both macOS targets.
The existing calibration also records Darwin 27, while these rebuilds used macOS 15. The receipts
do not isolate the contribution of compiler, SDK and deployment-target differences. Successful
smoke execution does not by itself approve different binary bytes. The npm source-pin gate therefore
remains unresolved pending the governed runtime-package rebuild/qualification/approval path;
neither the binary trust anchors nor the source-consistency assertion were relaxed. The qualifier
basename correction passes all six local tests, ESLint/Prettier and local Sonar (analysis task
`e7d4bd5d-94b5-43ba-8cab-a941ef0168fd`).

On the same head, all four portable secure-read jobs pass (Windows x64, Linux x64, macOS ARM64
and x64), and the macOS cross-platform job passes. The
[package coverage shard](https://github.com/oscharko-dev/Keiko/actions/runs/40399793207/job/121844427340)
still fails only the source-pin assertion: **15,542 passed, one failed, 101 skipped**. These are
head-specific component results, not a green required-check set or completed Windows acceptance.

Before this PR can merge, the release owner must reconcile the source pin through the existing
runtime-package builder and candidate qualification. Use the measured helper identities above as
review inputs, verify the complete package candidates, and preserve compatibility with already
published packages (the main package selects runtime version 1.1.4). Merely replacing the current
binary pins can refuse an installed package; merely changing the source hash misstates the old
binary's provenance. Issue #4068 W13 reserves release-approval changes to the owner release step.
No package was published and no runtime approval was changed in this qualification increment.

The follow-up diff passes typecheck/package-graph, targeted ESLint/Prettier and local documentation
link checks. The required local Sonar gate was rerun against this diff and again reported no
unresolved finding (analysis task `8a95a402-03d2-4345-863a-be1b9673b34a`).

Final checks of this increment: the five directly affected supervisor/logging/build/native-quality
test files pass (**58 tests, zero skips**); the separately diagnosed macOS abstraction case above
is not included in that scoped count. Typecheck, targeted ESLint/Prettier, MSVC `/W4 /WX /analyze`
on the changed C fixture, PowerShell syntax, the ADR index and all four changed documentation
files' relative links/anchors pass. The prescribed local Sonar gate passed on 2026-10-26 using
the existing Ubuntu/WSL Docker engine, repository-pinned analyzer images, Node 24.18.0 and verified
Compose 5.6.1. Docker Desktop's Windows-side engine remained unavailable. SonarJS does not certify
the native C code, which has separate compiler/analyzer and process-lifecycle evidence above.
No full Windows native-quality gate pass is claimed: that gate also includes privileged SMB and
.NET checks beyond this local run.

The initial concurrency review inspected
[#4076](https://github.com/oscharko-dev/Keiko/pull/4076) while open. It subsequently merged into
`dev` at `1c4464abb`; this branch integrated that completed work before the follow-up runs above.
Its macOS runtime-package pin and native journey repairs do not supply Windows runtime approval.

The missing gateway implementation is owned by [#3423](https://github.com/oscharko-dev/Keiko/issues/3423)
and [#3666](https://github.com/oscharko-dev/Keiko/issues/3666), with current work in
[draft PR #4090](https://github.com/oscharko-dev/Keiko/pull/4090). Its unmerged record identifies an
additional host-to-AppContainer HTTP control-route blocker; successful outbound filtering alone
does not establish OpenCode service connectivity. Its service, installer and production launch
composition remain incomplete. That branch was inspected for dependency coordination only;
no unfinished implementation or its results were imported as this branch's qualification.

## Acceptance disposition

| Group                                | Evidence / remaining work                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 — OS boundaries                   | PARTIAL. SCM/WFP admission and filter readback pass for a single synthetic job. The installed gateway TCP positive control fails. Filesystem and foreign-process boundaries remain unqualified.                                                                                                       |
| W2 — Owned process tree              | PARTIAL. Coding and MCP roots enter their kill-on-close jobs at creation. Ordinary and detached descendant cancellation, control EOF, MCP owner death and final stdio drain pass. Watchers, active turns and Workbench concurrency release remain open.                                               |
| W3 — Customer installs               | PARTIAL. Published 1.3.3 root CLI/UI installation, package.json start, restart and npx pass on Windows x64. A customer Windows coding-runtime package, installed upgrade and an admitted model-backed task remain open.                                                                               |
| W4 — Artifacts / approvals           | PARTIAL. Approved OpenCode/ripgrep and published v1.3.0 portable helper bytes verified; release helpers pass isolated execution. Portable remains evaluation-unqualified; Windows npm approval and installed retained-state/stale-helper proofs remain open                                           |
| W5 — Platform lanes                  | PARTIAL. The Windows reference runner builds the actual supervisor, tests SCM admission and executes the MCP harness. Feature pushes also require a real gateway TCP connection. Required product CI and full hardware qualification remain open.                                                     |
| W6 — Three-mode task comparison      | BLOCKED by W1 and the missing live model/Gateway qualification. No task or mode counted as passed                                                                                                                                                                                                     |
| W7 — Windows paths / filesystem      | PARTIAL. Git reparse, checkout binding, portable discovery, and source-built/staged secure-read paths and races pass, including Unicode, case aliases, long paths, ADS and namespace refusal. Full instruction/media/external-root and linked-worktree move/watcher qualification remains open        |
| W8 — Shell / real repair             | PARTIAL. 113 shell unit cases and actual `.cmd`/npm-shim argv/injection controls pass; the final binary-symlink proof lacks privilege. No project-selected Node/Vitest or Java/Maven/Gradle Workbench failing-test-to-repair loop                                                                     |
| W9 — Persisted sessions / locks      | PARTIAL. Synthetic-schema SQLite WAL snapshots, exclusive-lock failure/recovery, retained-state integrity, history/export/import and Windows junction refusal executed. Four retention observations remain; original-runtime Workbench restart/resume/fork and Windows ACL isolation are unqualified  |
| W10 — Agents / IPC / active input    | NOT RUN. Native capabilities are unavailable under the retained mapped profile. Native local MCP still constructs `/usr/bin/env -i`; no native Windows MCP execution claim                                                                                                                            |
| W11 — Network / environment          | BLOCKED on the installed path. The live hostile port is denied; the attested IPv4 TCP port times out. The separate fixture with a loopback exemption passes. Proxy/CA/OpenSSL/FIPS, inbound sidecar control and long-running requests are still open.                                                 |
| W12 — Visible identity / state       | PARTIAL, static only. Production selects `direct`, not `native`. Actual UI/model/agent/mode state and reload flows remain untested                                                                                                                                                                    |
| W13 — Upgrade / rollback             | PARTIAL. Published v1.3.0 helpers executed; native candidate-image lock refusal and recovery preserve bytes and file identities. Generation/handoff/recovery components pass. No installed upgrade/rollback or original-runtime retained-state qualification; Windows npm runtime pair remains absent |
| W14 — Large repositories / resources | NOT RUN. Secure-read load observations above cannot substitute for standalone/Workbench task measurements or another platform's reference budgets                                                                                                                                                     |
| W15 — Private skills / races         | NOT RUN. No actual model dispatch, compaction, revision replacement or multi-turn repair evidence                                                                                                                                                                                                     |

## CI and remaining capability gaps

The existing `cross-platform-smoke` Windows leg invokes `npm run check:native:windows`.
[`check-windows-native-quality.ps1`](../../scripts/check-windows-native-quality.ps1) now invokes
[`test-protocol.mjs`](../../native/runtime-supervisor/test-protocol.mjs) with the exact helper it
just compiled, and fails on a nonzero result. The harness runs cancellation and owner-control EOF
against both ordinary and `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` children. It checks live
positive controls and PID disappearance, and reports native execution separately from the explicit
non-Windows source-contract-only skip. No workflow condition or required check is relaxed.

The new Windows CI invocation found a supervisor defect hidden by the optimized local build:
`initialize_startup_info` passed a callee-local handle array to `UpdateProcThreadAttribute`, which
retains its pointer until the attribute list is destroyed. The unoptimized quality build then
failed `CreateProcessW` with `ERROR_INVALID_PARAMETER`. The exact CI compiler/linker options
reproduced this locally. Keeping the array in the launching caller until attribute-list teardown
fixes the lifetime; the same build now passes both descendant variants and both termination paths.
The existing launch/reap/error protocol and body-free server lifecycle logging remain unchanged.
The [Windows API lifetime contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
requires this storage lifetime independently of compiler optimization. Restaged/distributed helper
identities must be regenerated and qualified; the initial hash above is not the repaired binary.

A subsequent runner exposed binary fixture output passing through Windows CRT text mode: a
process-ID byte equal to `0x0a` gained a carriage return, corrupting the observed PID. The fixture
now writes the frame with `WriteFile`. A deterministic encoding check includes newline, carriage
return, NUL and EOF bytes; it failed with the old writer and passes with the repair. These synthetic
values are used only for serialization, never as process-liveness evidence. The actual ordinary and
detached descendants still pass both cancellation and control-EOF probes locally.

The initial staged-helper concurrency run failed its positive control: all 32 reads returned
`CHANGED_DURING_READ`. The updater created and removed temporary siblings of the target, changing
the root directory metadata even when Windows sharing protection correctly denied target
replacement. Moving those temporary files into a pre-created staging subdirectory removes that
unrelated ancestor churn. Atomic replacement still targets the same file, and all race, known-byte
and positive-success assertions remain active. The same unchanged staged helper then passed, with
32/32 known-generation reads, nine mutation attempts (eight after spawn) and five sharing denials.
No production helper guard or accepted status was relaxed.

The source-built secure-read protocol, released-helper qualification and live OpenCode service
tests are separate evidence classes. This increment does not add a passing substitute for the
unavailable service. The existing `productionOpenCodeBackend.functional.test.ts` dev-lane discovery
cases are macOS-only; `opencodeRuntime.real.test.ts` additionally retains old 2.0.10/POSIX staging
assumptions. The generic functional supervisor is a test seam, not the production Windows boundary.

Under `direct`, the governed tool facade remains the effect owner. Native shell, filesystem,
MCP/plugin/configuration, agent/Code Mode, native snapshot/session and native input-reference parity
must not be inferred from a mapped task. The full inventory and current dispositions remain in the
[capability matrix](opencode-capability-parity.md).

Historical dependency order before SCM integration (see the current priorities below):

1. Integrate and qualify Windows gateway confinement through the existing native backend and
   helper owners, with actual positive/negative network controls and inherited descendant policy.
   Keep current refusal until that proof exists; WFP policy parsing alone is insufficient.
2. Run the shell smoke on a host with file-symlink privileges. Reconcile the
   Windows applicability of native/POSIX test fixtures without counting skips as execution.
3. Extend the existing npm builder/discovery approval path for Windows; obtain the release owner's
   approved package/helper versions and publication. Do not invent approval digests or bypass them.
4. Execute the remaining W1–W15 matrix with owner-approved model/Gateway configuration, isolated
   synthetic repositories and body-free Activity Log evidence, including installed portable/npm
   upgrade/rollback and all three authority modes. Do not close #4068 on this component increment.

## Dev integration revalidation — 2026-10-31

PR #4088 integrates `dev` at `55e4b02b2131f35b2afd7063604eba227f74da1e`.
The supervisor harness retains the binary PID encoding regression and both ordinary and
detached descendant cancellation/control-EOF checks. It also executes the new MCP stdio
ownership and final-response drain checks from `dev`; the complete native Windows harness passes.
The fixture preserves both the observation-encoding and MCP argument probes.

The supply-chain merge retains the current production dependency-closure projection and applies
the existing trusted Windows npm invocation at its shared `npmJson` owner. The real Windows gate
emits all 28 workspace SBOMs and accepts their licenses. The targeted supply-chain, host-executable
and supervisor-build suites pass 63 tests with nine existing platform skips. Package build,
package graph, TypeScript, scoped ESLint/Prettier and semantic duplication pass; the latter retains
920 baseline groups without widening the baseline.

All four original #1300 visual producers were regenerated for this combined source: 427
component probes, 14 editor captures, seven accessibility modes and 108 browser captures pass.
The complete stylesheet/evidence suite passes 281 tests. The separate dependency-inventory
test reproduced a Windows separator mismatch; normalizing only path notation restores both
tests while preserving every dependency assertion. This is fixture evidence, not W1–W15 closure.

The runtime-approval suite still has four passes and one failure: approved helper source
`88fb376091f406c3fa63c05d0f963d7ba038f650c0824f893ac77089bb30b28b` does not match
`29f5e262d3d268b9785a1a2ae7a2875107a5ce106f1cb7d655ec37e97bf0249b` on this branch.
Passing the same suite on another branch does not qualify this source. Release-owner approval
and the previously identified reference-environment measurements remain separate obligations.

The latest [Windows gateway run for #4090](https://github.com/oscharko-dev/Keiko/actions/runs/41147212616)
passes on `5499afbef1c646ac52935daecd809bc30ba59b80`, including both socket proof modes.
This supersedes historical socket timeouts, but does not implement the installed service or
qualify Workbench acceptance. The regular PR CI remains separate: its merge-candidate guard
rejects a candidate based on `55e4b02b2` when the event expects `18648cad9`, and workflow hygiene
reports dependency advisories in `glob` and `minimatch`. No guard, approval or advisory is waived.

## Unsafe Job Object admission on 2026-10-31 (W1/W2 component)

On Windows 11 Home 10.0.26200 x64, NTFS, Node 24.18.0, the default
`node scripts/testing/test-windows-gateway-filters.mjs` run compiled the native
fixture with MSVC and reported `gateway-policy-validation: passed` (exit 0).
The run used production WFP sources from `377ce5ddd898587c6e045bde817e2e1b3930b27a`
with the additional Job Object cases in this change. SHA-256 of the test executable
was `159682bd233b7d18d993bb4c9ed2c6ed6b9eacc5a96cc45f55f4bea987cfa97d`.

Both guarded open and recovery rejected real jobs missing kill-on-close, or permitting
explicit or silent breakaway despite kill-on-close, with `ERROR_INVALID_PARAMETER`.
The fixture retained no job or engine handle. This default validation mode installs
no filters. Installed-service recovery, positive and negative socket isolation, and
the production Workbench launch remain outside this run.

## Integrated dev and local broker transport on 2026-10-31

Merge `d018f5c29` incorporates `dev` at `6194949d5`. The merged source uses the
range-scoped dependency overrides and the corresponding lockfile. On Windows x64,
the four visual fixture producers passed (427 component probes, 14 editor captures,
seven accessibility modes and 108 browser captures). The UI package's 281 stylesheet
and evidence tests passed.

On Windows 11 Home build 26200 x64 (NTFS, Node 24.18.0), the coding supervisor now
places the suspended workbench child in its kill-on-close Job Object inside
`CreateProcessW` using `PROC_THREAD_ATTRIBUTE_JOB_LIST`. This closes the orphan
window if the supervisor dies between process creation and job assignment.
`node native/runtime-supervisor/test-protocol.mjs` passed ordinary and detached
descendant cancellation and control-channel EOF.

The broker transport incorporates the OS peer checks from the gateway development
branch at `cc91d1e1a`. The single-instance local message pipe grants authenticated
clients read and message-write access without granting pipe-instance creation. On the
same host, `node scripts/testing/test-windows-gateway-filters.mjs` built the native
fixture with MSVC static analysis. The expected image passed using long and short
paths, a different approved image and an anonymous caller were refused, and a second
listener could not take the endpoint. These executions used a synthetic named pipe.

### Installed SCM broker and suspended child on Windows Server 2025

The [privileged Windows run for `8ebb24d38`](https://github.com/oscharko-dev/Keiko/actions/runs/41220096642/job/124592675721)
passed on the `windows-2025` image `20261021.278.1` with Node 24.18.0.
`scripts/testing/test-windows-gateway-scm.ps1` built the supervisor, installed it
under Program Files as the manual-start LocalSystem service `KeikoRuntimeGateway`,
started it through SCM and removed the temporary service and files after the proof.

The native `--gateway-supervised` path validates the pipe server against the running
SCM process. The broker authenticates the installed supervisor and issues a fresh
challenge. The supervisor creates a challenge-specific AppContainer profile and
places its suspended root atomically into a kill-on-close job. The broker duplicates
the authenticated peer's job handle, reads the root's token SID, validates the policy
digest, installs the filters and reads them back before returning the challenge-bound
acknowledgement. The supervisor resumes the root only after validating that reply.

- With the service absent, the supervisor returned an error and no child marker appeared.
- With the policy withheld, a separate process observed a root in the job and no marker.
  An invalid digest then caused refusal and no marker appeared before supervisor exit.
- With a valid digest, the child ran. An independent BFE query for the live job root's
  token SID found persistent outbound blocks for IPv4 and IPv6 and the TCP permit for
  `127.0.0.1:1`. The child exited successfully and the supervisor reported zero
  active job processes. The subsequent filter cleanup, guarded lifecycle and
  AppContainer socket proof also passed.

This run covers a single tree with a temporary service on an elevated Windows runner.
Customer installation, standard-user launches, concurrent trees, crash reconciliation
and release-owner approval remain open.

### Workbench adapter and UI start on Windows

Only the release-qualified Windows x64 package path selects the WFP planner and the
approved helper digest. The verified execution copy looks up the running SCM service,
locks the image path, checks the installed binary against that digest and launches it
with the original control pipes. The mapped policy reaches the installed supervisor
through KGB1. Dev and evaluation lanes keep their existing admission rules.

The [Windows Server 2025 adapter run](https://github.com/oscharko-dev/Keiko/actions/runs/41222287996/job/124599195730)
used a synthetic executable and the built server adapter. A mismatched installed image
produced no child marker. Matching bytes produced a child marker, the independent BFE
inspection for its actual SID passed, and the job reported zero live processes on exit.

Separately, the built CLI served the real Workbench in Chromium on Windows 11 x64.
The paired UI registered and selected a disposable Git repository on `dev` (HTTP 201
and 200). It remained idle with no configured model gateway, no available coding
runtime, and no start action. The host's portable installation record reported
`setup-failed`; the npm runtime approval list contains only macOS targets.
End-to-end OpenCode startup, including its authenticated host/control connection and
a model-backed task, is still outstanding.

### Published package and installed transport results, 2026-10-31

The standard npm and pinned Yarn consumers installed the published root package
`@oscharko-dev/keiko@1.3.3` on Windows Server 2025 Datacenter 10.0.26100 x64 and
macOS 15.7.9 (24G830) on an Intel Core i7-8700B. Both runners verified the CLI,
SDK import, packaged UI, selected launch project, `package.json` start, status,
restart, stop and separate npx execution. npm used a fresh cache with scripts and
optional dependencies disabled; Yarn used a private cache and skipped build scripts.
The npx execution used a fresh cache and the exact registry version.
Both registry responses reported SRI
`sha512-2nA985R3p8QFdKk3P7YoJ2pYQikdHaX6U9+YiPg/2H1vRMQUAicTWtxh4azXSkOiuqzYkvKsel8XDIDYVMAMjA==`;
the registry did not supply a gitHead. These are root-package results. Runtime release
approvals, installed upgrade/rollback, and three-mode standalone comparisons remain open.
[Windows](https://github.com/oscharko-dev/Keiko/actions/runs/41225074058/job/124607417047)
and [Intel macOS](https://github.com/oscharko-dev/Keiko/actions/runs/41225074058/job/124607417490)
ran the published-package smoke on the physical architecture specified in the
[scope transfer](https://github.com/oscharko-dev/Keiko/issues/4068#issuecomment-6499350524).

The local registry security and customer-shape gate suites passed 170 tests on
Windows. The POSIX Corepack permission-denial case was skipped there and passed
in a focused ten-case Linux run. The Windows fixtures keep PATH isolated and
invoke the system-verified command interpreter. Process-group unit tests exercise
the POSIX branch with mocked signals rather than issuing taskkill against a test PID.
Local Sonar analysis of the PR diff found no unresolved findings (task
`d94c0718-9f80-4838-a154-e56c7f16a0bc`).

On Windows the MCP stdio owner now uses the same creation-time job attribute as the
coding supervisor, eliminating the interval in which a supervisor crash could orphan
a newly created provider. The native runner confirmed provider and descendant
termination on owner death and delivery of the final stdio response.
[Windows lifecycle run](https://github.com/oscharko-dev/Keiko/actions/runs/41224891068/job/124606873049)

The installed transport probe uses two live host TCP listeners and verifies an
unrestricted connection and payload at each before testing the confined root.
With the unmodified production SCM service, the two listeners received only their
unrestricted controls. The root reported Winsock 10060 at the permitted gateway
and 10013 at the other port. Windows' capability diagnostic returned success with
`NETISO_ERROR_TYPE_NONE`; it did not identify a missing capability. The separate
socket fixture installs a temporary loopback exemption and does not reproduce these
production conditions. Feature-branch pushes exercise the strict installed test.
[Strict Windows evidence](https://github.com/oscharko-dev/Keiko/actions/runs/41225286961/job/124608043894)

The read-only BFE query on the following push found two classify drops for the
host listener at the gateway port. Both filters belonged to the Windows application
isolation sublayer at `ALE_AUTH_RECV_ACCEPT_V4`. The query was limited to the
synthetic probe and listener images, the two test ports and the preceding 30 seconds.
The hostile-port drop was associated with the probe; its filter could no longer be
read back after teardown. Earlier filter-lifecycle, durable-deny and fixture socket
tests passed in the same job. Its final installed-transport step failed.
[Windows drop classification](https://github.com/oscharko-dev/Keiko/actions/runs/41226253557/job/124610905307)

### Current acceptance priorities

1. Resolve the application-isolation drop on the gateway listener's receive path
   while preserving the actual hostile-port denial and foreign-tree isolation.
   Then prove authenticated host-to-sidecar control and
   concurrent tree isolation. These are prerequisites for a successful task (W1/W11).
2. Qualify standard-user service setup, crash recovery, stale installation refusal and
   upgrade/rollback. The release owner must approve the Windows runtime/helper inputs
   before a customer npm launch can be qualified (W3/W4/W9/W13).
3. Run the standalone and Workbench task suites in all three modes with an approved
   model, on Windows and Intel macOS. Record real edits, tests, cancellation,
   resource measurements and private-skill behavior against W2/W6–W10/W12/W14/W15.

## Update impact

Release-impacting supervisor reliability fix: retain inherited-handle storage through Windows
process creation. Category `fixes`, priority `normal`, remediation `no-action-required`; no state
formats or protocol versions change. The retention-root repair additionally affects validation
before accessing the existing retained-session store, without migration. Proposed notes: "Fix a
Windows runtime supervisor startup failure caused by expired process-attribute storage" and
"Refuse redirected retained-session directories before restoring or removing session state."
Target release version and release-owner
approval are pending; catalog insertion is deferred to the release-cut PR under the
[release-impact runbook](../release/release-impact-runbook.md). The SCM qualification above
adds an opt-in native supervisor entry point and a service dependency on Windows BFE.
