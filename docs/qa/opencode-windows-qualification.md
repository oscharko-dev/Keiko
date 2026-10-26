# OpenCode Coding Workbench: Windows qualification

Issue [#4068](https://github.com/oscharko-dev/Keiko/issues/4068), parent epic
[#3897](https://github.com/oscharko-dev/Keiko/issues/3897). Execution date: **2026-10-26**.

## Decision and current result

The task owner selected **qualification of the existing mapped profile**, with the remaining
native gaps explicitly retained, on 2026-10-26. Windows continues to select `direct` through
`productionOpenCodeToolProfile`; this is not native OpenCode parity. No native filesystem policy,
release approval, runtime package approval, or authority ceiling changes in this increment.

**Overall result: blocked, not qualified.** Even the mapped Workbench cannot currently launch
through its production Windows gateway boundary. `assertNativeGatewaySupported` in
[`nativeRuntimeProcessBackend.ts`](../../packages/keiko-server/src/coding-runtime/nativeRuntimeProcessBackend.ts)
refuses a gateway-confined non-macOS launch before spawning. The Windows WFP policy sources and
their passing validation test are not wired into that launch path. Removing this refusal would
weaken the required boundary and is not a remedy.

The dependency on [#4064](https://github.com/oscharko-dev/Keiko/pull/4064) is satisfied: it merged
into `dev` at `37b1ee9d0c6308b1a59eef3470aa47036fb8362b`, the fetched base of this qualification.
All W1–W15 acceptance groups remain open. Individual component results below do not close their
broader Workbench acceptance group.

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

| Group                                | Evidence / remaining work                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 — OS boundaries                   | BLOCKED. Mapped profile retained by explicit decision. Production gateway confinement still refuses Windows. Native filesystem and foreign-process boundaries remain unqualified                                                                                                               |
| W2 — Owned process tree              | PARTIAL. Real Job Object helper cancels/reaps ordinary and detached descendants and handles control EOF. Workbench concurrency release, original service, watchers and active turns remain untested behind W1                                                                                  |
| W3 — Customer installs               | BLOCKED. Fresh development dependencies and staging pass, but the npm runtime target map and approved npm runtime identities contain macOS only. No clean Windows npm/npx/Yarn/start/reload/upgrade qualification                                                                              |
| W4 — Artifacts / approvals           | PARTIAL. Approved OpenCode and ripgrep bytes verified, local helper built. No approved Windows npm package/helper release; retained-state and stale-helper refusal still need installed-artifact execution                                                                                     |
| W5 — Platform lanes                  | PARTIAL. Existing required Windows native-quality lane now runs the actual supervisor protocol harness against its freshly compiled helper. Real service execution remains blocked; native macOS-only and environment-gated suites are not Windows certification                               |
| W6 — Three-mode task comparison      | BLOCKED by W1 and the missing live model/Gateway qualification. No task or mode counted as passed                                                                                                                                                                                              |
| W7 — Windows paths / filesystem      | PARTIAL. Git reparse, checkout binding, portable discovery, and source-built/staged secure-read paths and races pass, including Unicode, case aliases, long paths, ADS and namespace refusal. Full instruction/media/external-root and linked-worktree move/watcher qualification remains open |
| W8 — Shell / real repair             | PARTIAL. 113 shell unit cases and actual `.cmd`/npm-shim argv/injection controls pass; the final binary-symlink proof lacks privilege. No project-selected Node/Vitest or Java/Maven/Gradle Workbench failing-test-to-repair loop                                                              |
| W9 — Persisted sessions / locks      | NOT RUN. Requires functioning admitted service; no session, WAL, authority expiry or restore claim                                                                                                                                                                                             |
| W10 — Agents / IPC / active input    | NOT RUN. Native capabilities are unavailable under the retained mapped profile. Native local MCP still constructs `/usr/bin/env -i`; no native Windows MCP execution claim                                                                                                                     |
| W11 — Network / environment          | PARTIAL. Disposable Windows runner passes IPv4/IPv6 WFP lifecycle and actual AppContainer socket/descendant controls. Installed service, inherited proxy/CA/OpenSSL/FIPS, endpoint failures, long streams and orphan requests remain unqualified                                               |
| W12 — Visible identity / state       | PARTIAL, static only. Production selects `direct`, not `native`. Actual UI/model/agent/mode state and reload flows remain untested                                                                                                                                                             |
| W13 — Upgrade / rollback             | BLOCKED. No approved/released Windows npm runtime pair or installed portable candidate supplied for this run. No executable-lock, rollback or retained-state qualification                                                                                                                     |
| W14 — Large repositories / resources | NOT RUN. Secure-read load observations above cannot substitute for standalone/Workbench task measurements or another platform's reference budgets                                                                                                                                              |
| W15 — Private skills / races         | NOT RUN. No actual model dispatch, compaction, revision replacement or multi-turn repair evidence                                                                                                                                                                                              |

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

Next work, in dependency order:

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

## Update impact

Release-impacting supervisor reliability fix: retain inherited-handle storage through Windows
process creation. Category `fixes`, priority `normal`, remediation `no-action-required`; no state
stores or protocol versions change. Proposed note: "Fix a Windows runtime supervisor startup
failure caused by expired process-attribute storage." Target release version and release-owner
approval are pending; catalog insertion is deferred to the release-cut PR under the
[release-impact runbook](../release/release-impact-runbook.md). This does not itself enable the
still-unimplemented Windows gateway service.
