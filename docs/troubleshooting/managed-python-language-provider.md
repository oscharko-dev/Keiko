# Restore the managed Python language provider

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Severity          | Medium                                                        |
| Surface           | Local UI / Workspace                                          |
| Stable identifier | `NOT_PROVISIONED`, `RUNTIME_UNHEALTHY`, or `RESTART_REQUIRED` |

**Symptom**

Settings > Languages reports Python as **Not provisioned**, **Unhealthy**, or **Restart
required**. Python navigation, diagnostics, or review-only refactor previews are unavailable.

**Root Cause**

Keiko starts Pyright only after all independent gates pass: workspace activation, deployment
policy, operator-approved runtime identity, executable containment, and command policy. The
provider is disabled by default. It never accepts an executable path from workspace settings and
never inherits `PYTHONPATH` or `VIRTUAL_ENV` from the host process. A settings change that affects
analysis requires a targeted Python restart; unrelated language providers remain warm.

Keiko's validated provider profile is Pyright `1.1.410` using `pyright-langserver --stdio`. Later
versions require the same fake-protocol conformance suite and an operator-run real-server smoke
before deployment approval. Project configuration follows Pyright's documented order:
`pyrightconfig.json`, then `[tool.pyright]` in `pyproject.toml`, then governed workspace settings.
The detected source is visible in Settings without exposing file contents.

**Diagnostic Steps**

1. Open Settings > Languages and inspect the Python state, settings source, approved interpreter
   and virtual-environment identities, detected project source, negotiated capabilities, and
   content-free health counters.
2. Confirm that an operator-provisioned `pyright-langserver` resolves outside the workspace and
   reports the approved version. Do not add a workspace-local executable to `PATH`.

   ```bash
   command -v pyright-langserver
   pyright --version
   ```

3. Run the hermetic provider conformance tests from the repository root.

   ```bash
   npm exec vitest -- run packages/keiko-server/src/editor/lsp/providers/pythonProvider.test.ts packages/keiko-server/src/editor/lsp/providers/pythonProvider.conformance.test.ts
   ```

`NOT_PROVISIONED` confirms missing or unapproved provisioning. `RUNTIME_UNHEALTHY` confirms a
failed handshake or runtime. `RESTART_REQUIRED` confirms a valid pending configuration change.

**Resolution**

1. Provision the approved Pyright package outside the workspace and map its opaque operator
   runtime identity to `python-lsp` in the deployment's trusted provisioning layer.
2. Keep command-policy permission limited to `pyright-langserver --stdio`; do not permit arbitrary
   workspace arguments or environment passthrough.
3. Select the approved interpreter and optional venv identities in governed workspace settings.
4. Activate Python. If Settings reports **Restart required**, use the targeted Python restart.
5. To roll back, restore the previous governed settings revision and restart Python. If the runtime
   remains unhealthy, deactivate Python; Keiko then fails closed to its in-process fallback where
   one exists and does not spawn Pyright.

Never weaken executable containment, command policy, or environment filtering to recover service.
The governing boundaries are documented in
[ADR-0131](../adr/ADR-0131-managed-multi-language-lsp-activation-and-configuration.md).
