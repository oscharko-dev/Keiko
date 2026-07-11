# Restore the managed Rust language provider

| Field             | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Severity          | Critical                                                                       |
| Surface           | Local UI / Workspace                                                           |
| Stable identifier | `NOT_PROVISIONED`, `POLICY_DENIED`, `RUNTIME_UNHEALTHY`, or `RESTART_REQUIRED` |

**Symptom**

Settings > Languages reports Rust as **Not provisioned**, **Policy denied**, **Unhealthy**,
**Degraded**, or **Restart required**. Rust diagnostics, navigation, hierarchy, inlay hints,
semantic features, formatting, or review-only refactoring are unavailable or incomplete.

**Root Cause**

Keiko starts Rust only after workspace activation, deployment policy, operator provisioning,
configuration containment, executable containment, command policy, private runtime-state creation,
and a current matching enforced-isolation attestation all pass. Rust is disabled by default. The
supported profile targets operator-provisioned rust-analyzer `2026-07-06` with the approved Rust
`1.97.0` toolchain and its pre-provisioned sysroot, standard-library sources, targets, and crate
sources.

The safe profile executes no workspace code. Build scripts and procedural macros are disabled,
automatic checks are off, runnables and command-bearing actions are unavailable, dependency and
component downloads are forbidden, and network access is denied by enforcement rather than by
configuration alone. Ambient Cargo/Rustup homes, registry/source replacement, credentials,
wrappers, runners, Cargo/rustc arguments, and arbitrary environment values are not inherited.

Reduced fidelity is expected when a project relies on generated sources, procedural macros,
build-script cfg output, unavailable crate sources, or target components. Offline/no-dependency
analysis can remain degraded even when rust-analyzer is healthy. Keiko never enables execution,
network access, downloads, or mutable shared toolchain state to repair fidelity.

**Diagnostic Steps**

1. Inspect Rust in Settings > Languages. Confirm the approved runtime and toolchain identities,
   selected features/target/cfg values, `noDefaultFeatures`, linked-project count, sysroot policy,
   resource budgets, restart state, negotiated capabilities, isolation status, and content-free
   health/cache counters.
2. In the trusted operator provisioning environment, confirm the pre-provisioned artifacts match
   the approved rust-analyzer `2026-07-06` and Rust `1.97.0` inventory. Do not add workspace-local
   binaries to `PATH` or copy local paths into workspace settings or evidence.

   ```bash
   rust-analyzer --version
   rustc --version --verbose
   cargo --version --verbose
   ```

3. Confirm every linked project is a regular `Cargo.toml` that realpath-resolves inside the
   canonical workspace. Confirm the selected target and approved sysroot components were provisioned
   offline. Remove escaping symlinks; do not compensate with absolute host paths.
4. Treat missing macro expansion, generated code, dependency navigation, target data, and
   build-derived cfg values as safe-mode limitations. Do not run Cargo, rustup, a wrapper, a build
   script, a proc macro, a check, or a runnable as remediation.
5. Inspect only content-free isolation and lifecycle outcomes. A missing, stale, mismatched, or
   partial `network:none` attestation is a policy failure and must block spawn; do not edit an
   attestation or relax its identity matching by hand.
6. Run the hermetic Rust profile from the repository root after its implementation-backed tests are
   present.

   ```bash
   npm exec vitest -- run packages/keiko-contracts/src/managed-lsp-runtime.test.ts packages/keiko-server/src/editor/lsp/providers/rustProvider.test.ts packages/keiko-server/src/editor/lsp/providers/rustProvider.security.test.ts packages/keiko-server/src/editor/lsp/providers/rustProvider.conformance.test.ts
   ```

`NOT_PROVISIONED` means the approved server/toolchain profile or required offline artifacts are
absent or invalid. `POLICY_DENIED` includes absent or non-matching isolation enforcement.
`RUNTIME_UNHEALTHY` can indicate a failed handshake, budget breach, cancellation failure, crash
loop, state-containment failure, or cleanup failure. `RESTART_REQUIRED` means a valid pending
configuration change has not completed a targeted restart. **Degraded** indicates bounded analysis
without execution-derived project information.

**Resolution**

1. Provision and hash-verify rust-analyzer `2026-07-06`, Rust `1.97.0`, required target/sysroot
   components, standard-library sources, and permitted crate sources offline and outside the
   workspace. Update only the trusted operator inventory.
2. Correct invalid bounded features, target/cfg values, contained linked projects, sysroot policy,
   or resource budgets. Never add arbitrary Cargo/rustc arguments, environment maps, URLs,
   credentials, wrappers, runners, or host paths.
3. Restore the enforced `network:none` boundary and matching attestation through the governed
   deployment path. If enforcement cannot be established, leave Rust deactivated.
4. If cache cleanup failed, deactivate Rust and use the governed targeted cleanup/reset. Do not
   point Rust at an operator Cargo/Rustup home, another workspace's cache, or an unbounded directory.
5. Activate Rust, then perform the targeted Rust restart when requested. Unrelated providers remain
   warm.
6. For rollback, restore the previous governed settings revision and restart only Rust, or
   deactivate Rust. Remove owned isolated Rust runtime/cache state through the governed cleanup
   path; never delete shared operator toolchains.

Do not enable build scripts, procedural macros, checks, runnables, rustc wrappers, Cargo aliases,
registry/source replacement, credentials, arbitrary environment values, mutable shared Cargo/Rustup
homes, network access, or downloads as a repair. Any future execution-derived fidelity requires a
separate ADR-0043-compatible decision, explicit human-reviewed opt-in, and enforced matching
execution isolation. See
[ADR-0132](../adr/ADR-0132-managed-multi-language-lsp-activation-and-configuration.md) and the
official [rust-analyzer configuration manual](https://rust-analyzer.github.io/book/configuration).
