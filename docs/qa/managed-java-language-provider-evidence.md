# Managed Java language provider verification evidence

This is the deterministic release profile for Epic #2094 / child #2278. It is an evidence map, not
proof by assertion: the referenced implementation and tests substantiate every product and security
claim. The hermetic profile downloads nothing, executes no workspace build logic, and requires no
real JDT LS installation.

## Supported and security profile

- Provider: operator-provisioned Eclipse JDT LS `1.60.0`, launched with an operator-approved JDK 21
  or newer. The JDT LS runtime JDK is distinct from the governed Java source/target level.
- Protocol: LSP 3.18 over bounded stdio JSON-RPC; default-off, revision-guarded workspace
  activation; only the negotiated and conformance-proven operation subset is advertised.
- Launch: the approved platform layout and launcher are validated outside the workspace. Keiko
  constructs the fixed launch contract; workspace configuration cannot provide arbitrary JVM
  arguments, Java agents, system properties, classpath strings, executables, or environment values.
- State: every process generation receives unique, private, quota-bounded `-configuration` and
  `-data` directories under Keiko runtime state. They never reuse operator-home, distribution, or
  another workspace's state and are cleaned on disposal/reset.
- Import: standalone `safeOffline` mode only. Maven and Gradle import, wrappers, plugins, init
  scripts, annotation processing, build execution, automatic build-configuration updates, artifact
  or source downloads, and network repair are disabled.
- Authority: server-initiated `workspace/executeCommand` and `workspace/applyEdit` are denied.
  Rename and code actions, when negotiated, produce bounded review artifacts and do not write.

The conservative profile intentionally trades project-model fidelity for containment. Missing
dependencies, generated sources, or build metadata can produce incomplete diagnostics and
navigation. Such limitations must remain visible and local; they never authorize an unsafe import
fallback.

## Automated evidence

| Concern                   | Deterministic proof                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed safe posture        | `managed-lsp-runtime.test.ts` rejects arbitrary fields, unsafe paths, newer source than target, non-`safeOffline` import, build-tool execution, annotation processing, and dependency downloads.                                                     |
| Launch and provenance     | `javaProvider.test.ts` proves the pinned runtime/layout checks, JDK 21 minimum, fixed launch shape, absence of arbitrary JVM/environment input, and fail-closed provisioning behavior.                                                               |
| Runtime-state isolation   | Java provider and process-lifecycle tests prove unique contained `-configuration`/`-data` directories, restrictive permissions, quotas, fresh restart state, cross-workspace separation, and cleanup after disposal, reset, failed start, and crash. |
| No build execution        | Hostile Maven and Gradle fixtures place wrappers, plugins, init scripts, and annotation processors behind sentinels; Java tests prove the sentinels and fixture tree remain byte-identical.                                                          |
| Offline behavior          | Provider tests deny Maven/Gradle import and downloads, remove provider egress, and prove missing project metadata degrades without network access or automatic repair.                                                                               |
| Negotiation and authority | `javaProvider.conformance.test.ts` executes only the live negotiated subset and proves `workspace/executeCommand` and `workspace/applyEdit` remain denied even when the fake server requests them.                                                   |
| Lifecycle and limits      | Shared manager, JSON-RPC, and Java conformance tests prove deadlines, cancellation with zero pending requests, bounded frames/results, crash-loop control, targeted restart, cache accounting, and process-group disposal.                           |
| Content-free evidence     | Shared evidence projection tests permit only closed states, reasons, revisions, counts, timestamps, latency buckets, opaque runtime identities, and pass/fail outcomes; source, paths, stderr, commands, and payload bodies are absent.              |

Run the hermetic profile after the Java provider implementation and tests are present:

```bash
npm exec vitest -- run packages/keiko-contracts/src/managed-lsp-runtime.test.ts packages/keiko-server/src/editor/lsp/providers/javaProvider.test.ts packages/keiko-server/src/editor/lsp/providers/javaProvider.conformance.test.ts packages/keiko-server/src/editor/lsp/lspNodeAdapter.test.ts packages/keiko-server/src/editor/lsp/lspJsonRpcClient.test.ts packages/keiko-server/src/editor/lsp/lspProcessManager.test.ts packages/keiko-server/src/editor/lsp/lspSecurity.test.ts
```

Passing documentation checks alone does not establish this profile. Release acceptance requires the
implementation-backed hermetic tests above, all child #2278 acceptance criteria, and the applicable
root green-bar gates to pass.

## Optional offline real-server smoke

The real smoke is optional in developer environments and mandatory before approving JDT LS
`1.60.0` or a replacement version for production. It runs only when the repository-defined Java
smoke variable names a pre-provisioned JDT LS distribution and approved JDK; otherwise it skips
explicitly. The smoke must run with network denial and must never install a JDK, JDT LS, Maven,
Gradle, wrappers, plugins, processors, or dependencies.

Use deterministic standalone, cross-file, large-file, navigation, cancellation, and review-only
refactoring fixtures. Record only the JDT LS and JDK versions, fixture hash, negotiated operation
counts, latency histogram, maximum child RSS, peak configuration/data-directory bytes, cancellation
count, cleanup result, and pass/fail status. Never record source, diagnostics, file paths, provider
stderr, command lines, environment values, or protocol bodies.

Acceptance requires one cold initialization and warm reuse within approved deadlines, zero pending
requests after cancellation, bounded results, byte-identical fixtures, zero network activity, no
sentinel side effects, resource use within the deployment budget, unique runtime-state directories,
and complete cleanup. The optional smoke supports compatibility and performance claims only; it does
not replace the hermetic malicious-fixture, containment, or protocol-authority tests.

Rollback is configuration-only: deactivate Java or restore the previous governed revision, then
perform a targeted Java restart. Rollback never preserves suspect runtime state, executes a build,
changes project files, or enables downloads.
