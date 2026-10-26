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
No customer model, secret, endpoint, workspace, or private runtime log was used.

| Command / check                                                                                                                              | Result and limits                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build:packages`; `npm run typecheck`                                                                                                | PASS, including compiler and package graph checks                                                                                                                                                                                                        |
| `node scripts/stage-dev-coding-runtime.mjs`                                                                                                  | PASS: approved 2.1.4 payload and both local Windows helpers staged                                                                                                                                                                                       |
| `node scripts/provision-ripgrep.mjs`                                                                                                         | PASS: pinned archive and extracted `rg.exe` verified                                                                                                                                                                                                     |
| Staged `opencode.exe --version`; `rg.exe --version`                                                                                          | PASS: 2.1.4 and 15.1.0                                                                                                                                                                                                                                   |
| `node scripts/testing/test-windows-gateway-filters.mjs`                                                                                      | PASS: C compiler/analyzer and policy validation. Default mode installs no WFP filters and proves no network isolation                                                                                                                                    |
| `node native/runtime-supervisor/test-protocol.mjs --helper .portable-sidecar-payloads/windows-x64/native/keiko-runtime-supervisor.exe`       | PASS: actual helper, ordinary and detached descendants, cancellation and control-pipe EOF. Both PIDs must be live before cancellation and gone afterward; explicit cancellation additionally requires zero active Job Object processes before completion |
| `node native/secure-workspace-read/test-protocol.mjs`                                                                                        | PASS: source-built helper, protocol, controlled races and load tests. Observed load sample: 1,000 sequential reads, p95 5.6 ms; 100 concurrent reads, batch 386.9 ms; resource delta 0. These are local observations, not canonical performance budgets  |
| `node native/secure-workspace-read/test-protocol.mjs --binary .portable-sidecar-payloads/windows-x64/native/keiko-secure-workspace-read.exe` | PASS after the fixture repair described below, against the same staged bytes: 32/32 known-generation reads, concurrent ancestor-alias proof and load tests; p95 5.7 ms, concurrent batch 387.4 ms, resource delta 0                                      |
| `node scripts/__tests__/windows-git-reparse-smoke.mjs`                                                                                       | PASS: actual Windows Git executable reparse containment                                                                                                                                                                                                  |
| `node scripts/__tests__/windows-cmd-spawn-smoke.mjs`                                                                                         | BLOCKED: `EPERM` creating the adversarial file symlink to `cmd.exe`. The later argv/injection matrix did not execute; junction support alone is insufficient                                                                                             |

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

Final checks of this increment: the five directly affected supervisor/logging/build/native-quality
test files pass (**58 tests, zero skips**); the separately diagnosed macOS abstraction case above
is not included in that scoped count. Typecheck, targeted ESLint/Prettier, MSVC `/W4 /WX /analyze`
on the changed C fixture, PowerShell syntax, the ADR index and all four changed documentation
files' relative links/anchors pass. The real local Sonar command was attempted through Git Bash,
but Docker's Linux engine pipe remained unavailable after `docker desktop start --detach`;
`docker desktop status` still reported stopped. No Sonar pass or full Windows native-quality gate
pass is claimed. That gate also includes privileged SMB and .NET checks beyond this local run.

Concurrent work was revalidated against open PR
[#4076](https://github.com/oscharko-dev/Keiko/pull/4076): its macOS runtime-package pin and native
nightly journey repairs do not supply Windows runtime approval or Windows service qualification.
No unmerged branch was used as acceptance evidence or merged into this branch.

## Acceptance disposition

| Group                                | Evidence / remaining work                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 — OS boundaries                   | BLOCKED. Mapped profile retained by explicit decision. Production gateway confinement still refuses Windows. Native filesystem and foreign-process boundaries remain unqualified                                                                                 |
| W2 — Owned process tree              | PARTIAL. Real Job Object helper cancels/reaps ordinary and detached descendants and handles control EOF. Workbench concurrency release, original service, watchers and active turns remain untested behind W1                                                    |
| W3 — Customer installs               | BLOCKED. Fresh development dependencies and staging pass, but the npm runtime target map and approved npm runtime identities contain macOS only. No clean Windows npm/npx/Yarn/start/reload/upgrade qualification                                                |
| W4 — Artifacts / approvals           | PARTIAL. Approved OpenCode and ripgrep bytes verified, local helper built. No approved Windows npm package/helper release; retained-state and stale-helper refusal still need installed-artifact execution                                                       |
| W5 — Platform lanes                  | PARTIAL. Existing required Windows native-quality lane now runs the actual supervisor protocol harness against its freshly compiled helper. Real service execution remains blocked; native macOS-only and environment-gated suites are not Windows certification |
| W6 — Three-mode task comparison      | BLOCKED by W1 and the missing live model/Gateway qualification. No task or mode counted as passed                                                                                                                                                                |
| W7 — Windows paths / filesystem      | PARTIAL. Git reparse and both source-built and staged-binary secure-read protocol/race tests pass. Full instruction/media/external-root, linked-worktree move/watcher and path-form matrix remains open                                                          |
| W8 — Shell / real repair             | BLOCKED. 113 Windows shell unit cases pass; actual shell smoke stops at the symlink prerequisite. No project-selected Node/Vitest or Java/Maven/Gradle failing-test-to-repair loop                                                                               |
| W9 — Persisted sessions / locks      | NOT RUN. Requires functioning admitted service; no session, WAL, authority expiry or restore claim                                                                                                                                                               |
| W10 — Agents / IPC / active input    | NOT RUN. Native capabilities are unavailable under the retained mapped profile. Native local MCP still constructs `/usr/bin/env -i`; no native Windows MCP execution claim                                                                                       |
| W11 — Network / environment          | BLOCKED. Policy-input validation is not an installed WFP socket proof. No inherited proxy/CA/OpenSSL/FIPS, endpoint-failure, long-stream or orphan-request qualification                                                                                         |
| W12 — Visible identity / state       | PARTIAL, static only. Production selects `direct`, not `native`. Actual UI/model/agent/mode state and reload flows remain untested                                                                                                                               |
| W13 — Upgrade / rollback             | BLOCKED. No approved/released Windows npm runtime pair or installed portable candidate supplied for this run. No executable-lock, rollback or retained-state qualification                                                                                       |
| W14 — Large repositories / resources | NOT RUN. Secure-read load observations above cannot substitute for standalone/Workbench task measurements or another platform's reference budgets                                                                                                                |
| W15 — Private skills / races         | NOT RUN. No actual model dispatch, compaction, revision replacement or multi-turn repair evidence                                                                                                                                                                |

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
