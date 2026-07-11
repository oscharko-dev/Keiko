# Restore the managed Shell language provider

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Severity          | High                                                          |
| Surface           | Local UI / Workspace                                          |
| Stable identifier | `NOT_PROVISIONED`, `RUNTIME_UNHEALTHY`, or `RESTART_REQUIRED` |

**Symptom**

Settings > Languages reports Shell as **Not provisioned**, **Unhealthy**, or **Restart required**.
Shell diagnostics and read-only navigation are unavailable.

**Root Cause**

Keiko starts Bash Language Server only after workspace activation, deployment policy, operator
provisioning, configuration containment, executable containment, and command policy pass. It is
disabled by default. The validated profile requires Bash Language Server `5.6.0`, Node 22, and
ShellCheck `0.11.0` outside the workspace.

The child receives a private PATH containing only approved Node and ShellCheck links. A missing or
workspace-shadowed dependency fails closed. `shfmt`, package managers, startup profiles, external
ShellCheck sources, explainshell, and background workspace analysis are intentionally unavailable.
Keiko never executes shell documents to repair or improve analysis.

**Diagnostic Steps**

1. Inspect Shell in Settings > Languages. Confirm the approved runtime, dialect, ShellCheck mode,
   configuration source, negotiated capabilities, and content-free health counters.
2. Confirm all three approved binaries resolve outside the workspace.

   ```bash
   command -v bash-language-server node shellcheck
   bash-language-server --version
   node --version
   shellcheck --version
   ```

3. Confirm every configured ShellCheck include path exists and realpath-resolves inside the
   canonical workspace. Symlinks escaping the workspace are rejected.
4. Run the offline conformance tests.

   ```bash
   npm exec vitest -- run packages/keiko-server/src/editor/lsp/providers/shellProvider.test.ts packages/keiko-server/src/editor/lsp/providers/shellProvider.conformance.test.ts
   ```

**Resolution**

1. Provision the pinned binaries outside the workspace without modifying project files.
2. Remove workspace PATH shadows and correct missing or escaping include paths.
3. Select the governed dialect, severity, exclusions, and contained include paths.
4. Activate Shell, then use the targeted Shell restart when requested.
5. For rollback, restore the previous settings revision and restart only Shell, or deactivate it.

Do not enable external sources, explainshell, shfmt, startup profiles, arbitrary ShellCheck arguments,
or a broad PATH as a repair. See
[ADR-0131](../adr/ADR-0131-managed-multi-language-lsp-activation-and-configuration.md), the official
[Bash Language Server configuration](https://github.com/bash-lsp/bash-language-server/blob/main/server/src/config.ts),
and the official [ShellCheck documentation](https://www.shellcheck.net/).
