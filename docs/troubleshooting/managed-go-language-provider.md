# Restore the managed Go language provider

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Severity          | Medium                                                        |
| Surface           | Local UI / Workspace                                          |
| Stable identifier | `NOT_PROVISIONED`, `RUNTIME_UNHEALTHY`, or `RESTART_REQUIRED` |

**Symptom**

Settings > Languages reports Go as **Not provisioned**, **Unhealthy**, or **Restart required**.
Go diagnostics, navigation, formatting, or review-only refactoring are unavailable.

**Root Cause**

Keiko starts gopls only after workspace activation, deployment policy, operator provisioning,
configuration containment, executable containment, and command policy all pass. It is disabled by
default. The validated profile is gopls `v0.21.1` with Go `1.26.5` (Go `1.25.12` is the supported
previous-major fallback). Binaries must be provisioned outside the workspace.

Every child starts with `GOENV=off`, `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, and
`GOVCS=off`. Ambient `GOFLAGS`, `GOPATH`, `GOMODCACHE`, and `GOCACHE` are not copied. Consequently a
missing vendored or pre-provisioned dependency, or a module requiring a newer toolchain, degrades
locally instead of downloading. Provider-side subdirectory watching, vulnerability resolution,
external documentation links, and unimported-package indexing are disabled.

**Diagnostic Steps**

1. Inspect Go in Settings > Languages. Confirm the approved runtime, target, build-tag count,
   configuration source, negotiated capabilities, and content-free health counters.
2. Confirm the approved binaries and versions outside the workspace.

   ```bash
   command -v gopls
   gopls version
   GOTOOLCHAIN=local go version
   ```

3. Confirm the workspace has a complete `vendor/` tree when module mode is `vendor`, or a fully
   provisioned local module cache when mode is `readonly`. Keiko will not repair dependencies.
4. Run the offline conformance tests.

   ```bash
   npm exec vitest -- run packages/keiko-server/src/editor/lsp/providers/goProvider.test.ts packages/keiko-server/src/editor/lsp/providers/goProvider.conformance.test.ts
   ```

**Resolution**

1. Provision the approved Go and gopls binaries and all dependencies offline.
2. Select the governed build tags, module mode, target, and optional contained `go.work` file.
3. Activate Go, then use the targeted Go restart when requested.
4. For rollback, restore the previous settings revision and restart only Go, or deactivate Go.

Do not enable a proxy, automatic toolchain selection, checksum network access, VCS access, or
provider downloads as a repair. See
[ADR-0132](../adr/ADR-0132-managed-multi-language-lsp-activation-and-configuration.md), the official
[gopls settings](https://go.dev/gopls/settings/), and the official
[Go toolchain selection rules](https://go.dev/doc/toolchain).
