# Proposal: a runnable Coding Workbench on Windows

Issue [#4068](https://github.com/oscharko-dev/Keiko/issues/4068). Status: **draft for owner
decision**, 2026-11-06. A1 is implemented for review; B–E remain proposals.

## Goal

Make a governed coding run start and finish on Windows, first from a checkout and later from a
release, without relaxing ADR-0043. Today every Windows start is refused before spawn, and readiness
reports `gateway-service-unqualified`.

## Decisions requested

| #   | Question                                                    | Recommendation                                                              |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| A   | May a checkout install and use the D18 broker?              | Yes: a dev-lane pin on the same broker (A1)                                 |
| B   | How does the confined tree reach its workspace?             | Grant on Keiko-managed worktrees and support roots only (B1)                |
| C   | How is `HKCU\Environment` closed to the confined tree?      | Less privileged AppContainer (C1), with a per-run deny ACE as fallback (C2) |
| D   | How does the host reach OpenCode's server in the tree?      | One brokered inbound loopback port per run (D1)                             |
| E   | Which model and gateway may the first model-backed run use? | Owner names one; until then, scripted-gateway runs only                     |

## Where it stops today

- **Broker.** Only a release-qualified package yields a helper pin, and both
  `keiko gateway-service install` and the launch require that pin (ADR-0043 D19,
  `productionOpenCodeActivation.ts` `windowsGatewayServiceFacts`). A checkout never sets
  `useInstalledWindowsGateway`, so `assertNativeGatewaySupported` refuses it.
- **Filesystem.** The per-tree AppContainer has no capabilities, and no production code grants it
  anything. Ungranted reads and writes are denied (W1 proof, 2026-11-03), including the workspace,
  the per-run state directory and the runtime root.
- **Environment.** The confined tree can read `HKCU\Environment`, so a value stored with `setx`
  bypasses the launch-environment allowlist (W1 open blocker).
- **Inbound control.** OpenCode's HTTP server must accept the host's connections. That route is
  unproven on the installed path (W11).
- **Smart App Control.** It refuses unsigned, locally built executables. It is off on the current
  development host.

## A. Broker for a checkout

- **A1 (recommended): dev-lane pin, same broker.**
  - Install: `keiko gateway-service install --dev-lane` runs only in a checkout with the dev lane
    enabled. It pins the supervisor digest from the verified dev-lane manifest, which discovery
    already re-hashes from its source tree.
  - Unchanged: UAC, placement under `%ProgramFiles%\KeikoRuntimeGateway`, image-identity peer
    authentication, the WFP filters, the loopback exemption and the deny guard.
  - Launch: uses the installed broker with the dev pin.
  - Evidence: stays `functional-not-platform-qualified`, so no dev run counts as platform
    qualification.
  - Switching to a release: a release launch reads a dev-pinned broker as `gateway-service-stale`,
    and `repair` replaces it, using the existing mechanism.
  - Risk: a LocalSystem service built from local sources, accepted through UAC by an administrator.
- **A2: wait for a release-qualified package.** That needs release-owner approval and a verified
  Authenticode publisher. No interactive Windows run is possible before then.
- **A3: hosted disposable runner only.** Proofs run, but nobody can run the Workbench itself.

## B. Workspace and support-root grant

- **B1 (recommended): grant only what Keiko owns.**
  - **Workspace:** Keiko-managed task worktrees under `%USERPROFILE%\.keiko\task-workspaces`. Each
    worktree gets a capability SID derived from its id
    (`DeriveCapabilitySidsFromName("keiko.workspace.<id>")`). An inheritable ACE is set on the
    worktree root before checkout, so files inherit it at creation and no tree walk is needed. A run
    receives only its own worktree's capability, which keeps concurrent trees isolated.
  - **Per-run state directory:** an ACE for the per-tree SID itself, set when Keiko creates the
    directory.
  - **Runtime root:** read and execute for one per-installation capability, set at staging or
    install.
  - **Access level:** read and execute on the workspace for the mapped profile, because Keiko's
    facade performs the tool effects (ADR-0137). Write access goes only to the state directory.
    Whether OpenCode needs more is verification item 1.
  - **Never granted:** a user's own checkout or an ordinary folder. On Windows those are refused
    with a closed reason until a separate decision.
  - **Crash:** a stale ACE names a SID no later process can obtain. A startup sweep removes Keiko's
    stale `S-1-15-2-…` ACEs, mirroring the D18 crash rule.
- **B2: per-run ACE on the worktree root.** The strongest isolation, but every run walks the whole
  tree to propagate it and then walks it again to remove it.
- **B3: no grant; every read goes through a Keiko helper.** OpenCode's own working directory and
  instruction reads would fail, so this is a large protocol change.

## C. Persisted user environment

- **C1 (recommended): Less Privileged AppContainer.** Spawn with
  `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT`.
  The tree then loses every grant made to `ALL APPLICATION PACKAGES`, `HKCU\Environment` included,
  and keeps only explicit grants (B1). This also tightens W1 in general. Risk: the runtime may need
  a system capability under LPAC, so it needs a probe first.
- **C2 (fallback): per-run deny ACE.** The supervisor adds a deny ACE for the per-tree SID on
  `HKCU\Environment` before resume and removes it at teardown. The user owns that key, so no
  elevation is needed. A crash leaves a deny entry for a SID that is never reused.
- **C3: accept and document.** Not recommended: secret exfiltration is a mode-independent hard
  denial.

## D. Inbound control route

- **D1 (recommended):**
  - The broker permits exactly one loopback port per run at the inbound layer
    (`ALE_AUTH_LISTEN`/`ALE_AUTH_RECV_ACCEPT`), for the per-tree SID only. The supervisor reserves
    that port and adds it to the broker frame.
  - OpenCode's existing per-run server password stays the authentication.
  - Every other inbound and outbound destination stays denied.
  - Verification item 2 settles whether the D18 exemption already lifts the receive side.

## Delivery order and exit evidence

1. **A1.** `test-windows-gateway-scm.ps1 -VerifyTransport` passes on Windows 11 with the dev pin.
   Implemented on 2026-11-06. The broker installs and reports ready for a standard user, and the
   first confined run starts and stops at B. The elevated transport proof has not run on Windows 11
   yet ([record](../qa/opencode-windows-qualification.md)).
2. **D1.** The host reaches OpenCode's server in the tree, and a foreign port stays refused.
3. **B1.**
   - The tree reads its worktree and writes its state.
   - Denied: another worktree, a user checkout, and the runtime root for writing.
4. **C1 or C2.** The `HKCU\Environment` probe in `runtime_boundary.test.c` is denied, and every
   positive control passes.
5. **First Workbench runs.**
   - The scripted gateway in all three modes covers W2, W8, W9 and W12.
   - Then the approved model (E) covers W6, W14 and W15.

## Unchanged

- No unconfined fallback, no container substitute, and no relaxation of D1–D10 (D13).
- Failures stay closed.
- A user's own checkout is never modified.
- Every new step logs body-free evidence through the existing Activity Log ports.
- Release qualification and its evidence classes are unaffected.

## Verification items

1. Under the mapped profile, does OpenCode write anything in its working directory, beyond reading
   instructions and detecting the project?
2. Does the D18 loopback exemption cover inbound connections to a listener in the tree?
3. Which capabilities does OpenCode 2.2.5, a Bun executable, need under LPAC?
