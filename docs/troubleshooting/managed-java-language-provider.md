# Restore the managed Java language provider

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Severity          | High                                                          |
| Surface           | Local UI / Workspace                                          |
| Stable identifier | `NOT_PROVISIONED`, `RUNTIME_UNHEALTHY`, or `RESTART_REQUIRED` |

**Symptom**

Settings > Languages reports Java as **Not provisioned**, **Unhealthy**, **Degraded**, or **Restart
required**. Java diagnostics, navigation, semantic features, or review-only refactoring are
unavailable or incomplete.

**Root Cause**

Keiko starts Java only after workspace activation, deployment policy, operator provisioning,
configuration containment, executable containment, JDK validation, command policy, and private
runtime-state creation all pass. It is disabled by default. The supported profile targets
operator-provisioned Eclipse JDT LS `1.60.0`; the JDK that runs JDT LS must be version 21 or newer,
even when the project source/target level is older.

Every process generation uses unique, private `-configuration` and `-data` directories. Keiko never
reuses the operator home, the JDT LS distribution configuration, or another workspace's data.
Failure to create, restrict, account for, or clean these directories fails closed.

Java currently runs in standalone `safeOffline` mode. Maven and Gradle import, wrappers, plugins,
init scripts, annotation processing, automatic build-configuration updates, artifact/source
downloads, external commands, and server-initiated edits are intentionally unavailable. Therefore,
a project that depends on generated sources or build-derived classpaths can remain degraded even
when JDT LS is healthy. Keiko does not silently enable unsafe import to improve fidelity.

**Diagnostic Steps**

1. Inspect Java in Settings > Languages. Confirm the approved runtime and JDK identities,
   source/target levels, standalone import mode, configuration source, restart state, negotiated
   capabilities, and content-free health/cache counters.
2. Confirm the operator-provisioned JDK and JDT LS distribution are outside the workspace and match
   the approved versions. Use only operator diagnostics; do not paste local paths into workspace
   settings or evidence.

   ```bash
   java -version
   jdtls --version
   ```

   If the approved distribution has no `jdtls --version` surface, verify its release provenance in
   the operator provisioning inventory instead of constructing an ad hoc launch command.

3. Confirm every configured project root, classpath entry, and optional configuration file exists,
   is a regular expected object, and realpath-resolves inside the canonical workspace. Remove
   escaping symlinks; do not replace them with absolute paths.
4. Treat incomplete Maven/Gradle models, generated sources, annotation-processor output, and missing
   dependencies as expected safe-mode limitations. Provision reviewed classpath artifacts offline
   when policy permits; do not invoke a wrapper or build as remediation.
5. Run the hermetic Java profile from the repository root. The implementation and tests—not this
   runbook—substantiate the security and lifecycle claims.

   ```bash
   npm exec vitest -- run packages/keiko-contracts/src/managed-lsp-runtime.test.ts packages/keiko-server/src/editor/lsp/providers/javaProvider.test.ts packages/keiko-server/src/editor/lsp/providers/javaProvider.conformance.test.ts
   ```

`NOT_PROVISIONED` means the approved JDT LS/JDK pair or validated platform layout is unavailable.
`RUNTIME_UNHEALTHY` can indicate a failed handshake, invalid JDK, rejected layout, state-directory
failure, crash loop, or cleanup failure. `RESTART_REQUIRED` means a valid pending configuration
change has not yet been acknowledged by a successful targeted restart. A degraded state can reflect
safe standalone analysis without a complete build-derived project model.

**Resolution**

1. Provision JDT LS `1.60.0`, an approved JDK 21+, and all required standalone classpath artifacts
   offline and outside the workspace. Update only the trusted operator runtime mapping.
2. Correct missing or escaping contained project roots, classpath entries, or configuration files.
   Keep the typed source/target levels and `safeOffline` import posture.
3. If cleanup failed, deactivate Java and let the governed lifecycle remove the private runtime
   state. Do not manually point Java at another workspace's `-configuration` or `-data` directory.
4. Activate Java, then use the targeted Java restart when requested. Unrelated providers remain
   warm.
5. For rollback, restore the previous governed settings revision and restart only Java, or
   deactivate Java. A restart creates fresh private runtime-state directories.

Do not add arbitrary JVM arguments, Java agents, system properties, environment values, absolute
classpath strings, Maven/Gradle import, wrappers, plugins, init scripts, annotation processing,
downloads, `workspace/executeCommand`, or `workspace/applyEdit` authority as a repair. Better project
fidelity that requires execution needs a separately approved, enforced, and attested isolation
boundary. See
[ADR-0131](../adr/ADR-0131-managed-multi-language-lsp-activation-and-configuration.md) and the
official [Eclipse JDT LS documentation](https://github.com/eclipse-jdtls/eclipse.jdt.ls).
