# Managed Rust language provider verification evidence

This is the deterministic release profile for Epic #2094 / child #2279. It is an evidence map, not
proof by assertion: the referenced implementation and failure-first tests substantiate every
product and security claim. The hermetic profile downloads nothing and must prove that merely
opening a hostile Rust workspace executes no workspace code.

## Supported and security profile

- Provider: operator-provisioned rust-analyzer `2026-07-06` with the approved Rust `1.97.0`
  toolchain. The exact server, Cargo, rustc, sysroot, standard-library source, target-component, and
  crate-source artifacts are verified against the trusted operator inventory before activation.
- Protocol: bounded stdio JSON-RPC under default-off, revision-guarded activation. Keiko advertises
  and executes only operations negotiated with the pinned server and proven by conformance tests.
- Provisioning: offline only. The profile never invokes rustup, downloads components or crates,
  contacts registries or VCS sources, or consumes workspace-controlled toolchain provisioning.
- Execution: `cargo.buildScripts.enable=false`, `procMacro.enable=false`, `checkOnSave=false`, and
  no runnable or command execution. Check, test, run, bench, debug, build-script, proc-macro,
  rustc-wrapper, and Cargo override-command surfaces remain unavailable.
- Metadata: closed offline/no-dependency behavior uses pre-provisioned inputs only. Missing crate
  sources, generated code, target data, or build-derived cfg values degrade fidelity without repair.
- Isolation: activation requires a current matching, automated `network:none` attestation covering
  filesystem, process, environment, toolchain, workspace, runtime-cache, and policy identities.
  Missing, stale, mismatched, or incomplete attestation denies activation before spawn.
- Configuration: only bounded feature names, target triple, cfg key/value pairs,
  `noDefaultFeatures`, contained linked `Cargo.toml` paths, approved-toolchain-or-disabled sysroot,
  closed metadata mode, and server-owned resource budgets are accepted. Commands, wrappers,
  arbitrary environment maps, host paths, registry URLs, credentials, and downloads are absent.
- State: approved toolchain state is immutable and workspace-external. Writable runtime/cache state
  is private, symlink-safe, quota-bounded, isolated per workspace and generation, and removed after
  disposal, reset, failed activation, or rollback. Evidence contains no paths or payload bodies.

This conservative profile trades execution-derived project fidelity for containment. Incomplete
procedural-macro expansion, generated sources, target discovery, dependency navigation, or
build-script cfg values are expected safe-mode limitations. Degradation never authorizes fallback
execution, network access, mutable shared Cargo/Rustup homes, or workspace configuration as an
authority source.

## Automated evidence

| Concern                      | Deterministic proof                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed safe posture           | `managed-lsp-runtime.test.ts` rejects unknown fields, unbounded features/cfgs/projects/budgets, invalid targets, escaping linked projects, host sysroots, downloads, build scripts, and procedural macros.                                                                                     |
| Exact safe projection        | `rustProvider.test.ts` proves the pinned profile and exact rust-analyzer initialization/settings projection, including disabled build scripts, proc macros, checks, runnables, command overrides, downloads, and closed offline/no-dependency metadata.                                        |
| Provisioning and environment | Provider tests prove verified external rust-analyzer/toolchain artifacts, immutable approved sysroot inputs, private writable state, and removal of ambient Cargo/Rustup homes, wrappers, credentials, registry/source configuration, and arbitrary environment values.                        |
| No workspace execution       | Hostile fixtures place sentinels behind `build.rs`, proc macros, check/test/run/bench targets, Cargo aliases, rustc wrappers, runners, credential processes, registry/source replacement, workspace config, and symlinks; tests prove zero invocation and byte-identical sentinels.            |
| Enforced network denial      | Isolation tests attempt registry, git, HTTP, DNS, and direct socket egress and prove zero traffic. Activation tests deny absent, stale, mismatched, partial, or incorrectly scoped attestations before spawn.                                                                                  |
| Typed Cargo behavior         | Provider tests map only bounded features, target, cfgs, `noDefaultFeatures`, contained linked projects, approved sysroot policy, and resource budgets; hostile argv, env, URL, credential, config-path, wrapper, runner, and host-path fields are rejected.                                    |
| Negotiated operations        | `rustProvider.conformance.test.ts` proves the live negotiated subset for navigation, formatting, review-only refactoring, implementation/call hierarchy, inlay hints, and semantic support. Unsupported and command-bearing surfaces are absent or stripped.                                   |
| Lifecycle and limits         | Shared manager and Rust tests prove bounded Cargo metadata, file/memory/disk/index budgets, deadlines, cancellation with zero pending requests, crash-loop control, fresh isolated restart state, targeted disposal, and complete cleanup.                                                     |
| Content-free evidence        | Shared evidence tests permit only closed states/reasons, opaque approved identities, revisions, counts, timestamps, latency buckets, resource measurements, hashes, cleanup outcomes, and pass/fail status; source, manifests, paths, stderr, argv, env, URLs, and protocol bodies are absent. |

Run the hermetic profile after the Rust provider implementation and tests are present:

```bash
npm exec vitest -- run packages/keiko-contracts/src/managed-lsp-runtime.test.ts packages/keiko-server/src/editor/lsp/providers/rustProvider.test.ts packages/keiko-server/src/editor/lsp/providers/rustProvider.security.test.ts packages/keiko-server/src/editor/lsp/providers/rustProvider.conformance.test.ts packages/keiko-server/src/editor/lsp/lspNodeAdapter.test.ts packages/keiko-server/src/editor/lsp/lspJsonRpcClient.test.ts packages/keiko-server/src/editor/lsp/lspProcessManager.test.ts packages/keiko-server/src/editor/lsp/lspSecurity.test.ts
```

Passing documentation checks alone does not establish this profile. Release acceptance requires
the implementation-backed suites above, every #2279 acceptance criterion, the security and
performance evidence, and all applicable root green-bar and coverage gates to pass. If an exact
test path is renamed during implementation, this evidence map must be updated to the final
version-controlled path before release.

## Security and performance evidence

The deterministic security matrix covers malicious build scripts and proc macros; Cargo aliases,
wrappers, runners, credential providers, registries and source replacements; `.cargo` configuration
at every visible level; hostile `RUSTC`, `RUSTC_WRAPPER`, `RUSTC_WORKSPACE_WRAPPER`, `RUSTFLAGS`,
`CARGO_ENCODED_RUSTFLAGS`, Cargo/Rustup homes, proxy variables, and symlinks; absolute-path process
attempts; and every attestation failure mode. Acceptance requires zero process sentinel changes,
zero writes outside approved runtime state, zero egress, zero downloads, no retained payloads, and
closed activation when any proof is unavailable.

Performance evidence uses deterministic small, multi-crate, large-file, and large-workspace
fixtures. It measures cold cargo-metadata/index startup, warm navigation and semantic operations,
cancellation latency, maximum child and descendant RSS, peak private-cache bytes/files, result
truncation, disposal latency, and cleanup. Every result is evaluated against the typed project-file,
metadata-byte, memory, disk, and index-deadline budgets; exceeding a budget terminates the provider
without an automatic crash loop or authority widening.

## Optional offline real-server smoke

The real smoke is optional in developer environments and mandatory before approving
rust-analyzer `2026-07-06`, Rust `1.97.0`, or a replacement profile for production. It runs only
when repository-defined Rust smoke inputs identify already provisioned, hash-verified artifacts;
otherwise it skips explicitly. It must use the same enforced `network:none` and state-containment
boundary and must never invoke rustup or install a component, target, crate, or dependency.

Use deterministic standalone, linked-project, no-default-feature, target/cfg, large-workspace,
navigation, hierarchy, inlay, semantic, cancellation, crash, and review-only refactoring fixtures.
Hostile build-script, proc-macro, wrapper, runner, Cargo-config, source-replacement, and network
sentinels remain armed throughout. Record only approved server/toolchain versions and hashes,
fixture hashes, negotiated-operation counts, latency histograms, maximum RSS, peak private-cache
bytes/files, cancellation/crash counts, attestation and cleanup outcomes, and pass/fail status.
Never record source, manifest bodies, diagnostics, paths, provider stderr, argv, environment values,
registry data, credentials, or protocol bodies.

Acceptance requires bounded cold and warm behavior, zero pending requests after cancellation, zero
network activity, byte-identical fixtures and sentinels, no writes outside approved state, resource
use within every configured budget, correct negotiated-operation reporting, crash-loop containment,
and complete cleanup. The smoke supports compatibility and performance claims only; it does not
replace hermetic hostile-workspace, no-execution, isolation, or authority tests.

Rollback is configuration-only: deactivate Rust or restore the previous governed revision, then
perform a targeted Rust restart. Purge only the owned isolated Rust runtime cache through the
governed cleanup path. Rollback never preserves suspect state, runs Cargo or rustup, changes project
files, enables build scripts/proc macros/checks/runnables, or permits downloads.
