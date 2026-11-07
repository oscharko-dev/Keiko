# Proposal: a runnable Coding Workbench on Windows

Issue [#4068](https://github.com/oscharko-dev/Keiko/issues/4068). Status: **A, B, D and E decided**
on 2026-11-07 by the #4068 Windows owner under the owner's scope transfer of 2026-10-24. A1, B1 and
D1 are implemented; C is not implemented, and its variant is still to be chosen (see C). The first
confined Workbench run on Windows succeeded on 2026-11-06, with the run's state on the system volume
([record](../qa/opencode-windows-qualification.md)).

## Goal

Make a governed coding run start and finish on Windows, first from a checkout and later from a
release, without relaxing ADR-0043. Today every Windows start is refused before spawn, and readiness
reports `gateway-service-unqualified`.

## Decisions

| #   | Question                                                    | Decision (2026-11-07)                                             |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| A   | May a checkout install and use the D18 broker?              | Yes: a dev-lane pin on the same broker (A1)                       |
| B   | How does the confined tree reach its workspace?             | Grant on Keiko-managed worktrees and support roots only (B1)      |
| C   | How is `HKCU\Environment` closed to the confined tree?      | Open: only the key's access list works; C1, C2 and a label failed |
| D   | How does the host reach OpenCode's server in the tree?      | One brokered inbound loopback port per run (D1)                   |
| E   | Which model and gateway may the first model-backed run use? | The Windows owner selects them per run, recorded body-free        |

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
- **As implemented (2026-11-06, ADR-0043 D18).** It differs from the plan above in four points:
  - The runtime root and the state directory are granted to the per-tree SID at launch and revoked
    at reap. The plan named a per-installation capability for the runtime root.
  - The worktree capability is derived from the worktree's canonical path.
  - Its ACE is set at the worktree's first run and then kept.
  - The startup sweep is not implemented yet.
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
- **Probed on 2026-11-06 (Windows 11, standard user).** A plain AppContainer root reads the user's
  real key: the same 13 values and the same `Path` size as an unconfined read. None of the three
  per-run mechanisms closed it:
  - **C1 (LPAC).** The root could not even start Winsock. Making sockets work under LPAC needs the
    `registryRead` capability, and `HKCU\Environment` grants exactly that capability read access.
  - **C2 (deny ACE).** A deny entry for the per-tree package SID was in place during the probe, and
    the read still succeeded. `REVOKE_ACCESS` also does not remove deny entries, so the planned
    teardown was wrong as well.
  - **Integrity label.** A medium no-read-up mandatory label was verified on the key, and the
    low-integrity root still read it.

  The remaining lever is the key's own access list: removing the read entries for
  `ALL APPLICATION PACKAGES` and `registryRead`, either while a tree lives or permanently. Both
  change what every AppContainer app of this user may read, so the variant is a decision for the
  Windows owner, still to be made. Nothing of C is implemented.

## D. Inbound control route

- **D1 (recommended):**
  - The broker permits exactly one loopback port per run at the inbound layer
    (`ALE_AUTH_LISTEN`/`ALE_AUTH_RECV_ACCEPT`), for the per-tree SID only. The supervisor reserves
    that port and adds it to the broker frame.
  - OpenCode's existing per-run server password stays the authentication.
  - Every other inbound and outbound destination stays denied.
  - Verification item 2 settles whether the D18 exemption already lifts the receive side.
- **As implemented (2026-11-06, ADR-0043 D18).** It differs from the plan above in three points:
  - The port is not pinned. OpenCode chooses it inside the tree; the permit matches the package,
    TCP, the loopback flag and `127.0.0.1`.
  - The permit is a soft permit at the maximum weight inside Windows' application-isolation
    sublayer, so a block in another sublayer still wins.
  - Windows Firewall also needs a per-tree rule, and the tree needs the `privateNetworkClientServer`
    capability. The broker removes the rule at teardown and every leftover Keiko rule at start.

## Delivery order and exit evidence

1. **A1.** `test-windows-gateway-scm.ps1 -VerifyTransport` passes on Windows 11 with the dev pin.
   Implemented on 2026-11-06. The broker installs and reports ready for a standard user, and the
   first confined run starts and stops at B. The elevated transport proof has not run on Windows 11
   yet ([record](../qa/opencode-windows-qualification.md)).
2. **D1.** The host reaches OpenCode's server in the tree, and a foreign port stays refused.
   Implemented on 2026-11-06. The host reached the server, and the first confined run succeeded.
   The foreign-port and transport proofs have not run on Windows 11 yet.
3. **B1.**
   - The tree reads its worktree and writes its state.
   - Denied: another worktree, a user checkout, and the runtime root for writing.
   - Implemented on 2026-11-06, ahead of D1, because without it the runtime could not start. The
     runtime now starts confined and announces its server. The denial probes passed on Windows 11
     on 2026-11-07 through the production grant code, without WFP
     ([record](../qa/opencode-windows-qualification.md)).
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
   instructions and detecting the project? A read-only task needed only read access (2026-11-06);
   a write task has not run yet.
2. Does the D18 loopback exemption cover inbound connections to a listener in the tree? No. The
   host's connection timed out until the broker admitted it (2026-11-06).
3. Which capabilities does OpenCode 2.2.5, a Bun executable, need under LPAC?
4. New (2026-11-06): may a confined run's workspace and state lie on a non-system volume? Not on the
   observed host: the runtime's `realpath` is denied there. Should Keiko refuse such a run before
   spawn with a closed reason, or relocate its worktrees?
