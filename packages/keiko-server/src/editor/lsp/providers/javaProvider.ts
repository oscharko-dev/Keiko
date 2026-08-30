import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type {
  LanguageServiceOperation,
  ManagedLspJavaConfiguration,
} from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";
import { currentPlatform, planIsolatedRun, probeBackends } from "@oscharko-dev/keiko-sandbox";
import {
  buildSandboxEnv,
  buildWindowsShellInvocation,
  nodeWindowsTreeKill,
  type WindowsShellInvocation,
  type WindowsShellInvocationOptions,
  type WindowsTreeKillDisposition,
} from "@oscharko-dev/keiko-tools";

import type { HostLanguageProviderSpec } from "../hostLanguageProviders.js";
import { resolveExecutableOutsideWorkspace } from "../lspNodeAdapter.js";
import type { LspSpawnPreparation, LspSpawnPreparationInput } from "../lspProcessManager.js";
import { UNKNOWN_CORRELATION_ID } from "../../../correlation.js";
import { processServerLogSink } from "../../../process-log-sink.js";
import { errorKindOf, startLogTimer } from "../../../observability/index.js";

const JAVA_OPERATIONS: readonly LanguageServiceOperation[] = Object.freeze([
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
  "definition",
  "references",
  "typeDefinition",
  "implementation",
  "callHierarchy",
  "inlayHints",
  "renamePrepare",
  "renameApply",
  "codeActions",
  "signatureHelp",
] as const satisfies readonly LanguageServiceOperation[]);

const JAVA_ENV_ALLOWLIST = Object.freeze(["LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"]);
const MAX_RUNTIME_FILES = 50_000;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const SUPPORTED_JDT_LS_VERSION = "1.60.0";
const MINIMUM_JDK_MAJOR_VERSION = 21;
const FORBIDDEN_PROJECT_ENTRIES = new Set([
  ".classpath",
  ".factorypath",
  ".project",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "gradlew",
  "gradlew.bat",
  "mvnw",
  "mvnw.cmd",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
]);

// `python3` is required and approved solely because the operator-provisioned `jdtls` launcher
// command is commonly shipped as a Python interpreter-shebang script that resolves the
// platform-specific JDT LS classpath/args before it execs `java` — it never runs arbitrary
// operator or workspace scripts. That interpreter step happens under the same enforced
// no-network, no-arbitrary-argument isolation boundary as `java`; it is not a general-purpose
// script-execution grant and must not be widened to cover other interpreters or scripts.
export const JAVA_PROVIDER_SPEC: HostLanguageProviderSpec = Object.freeze({
  id: "java-lsp",
  label: "Eclipse JDT LS",
  languages: Object.freeze(["java"]),
  operations: JAVA_OPERATIONS,
  executableName: "jdtls",
  executableArgs: Object.freeze([]),
  requiredExecutables: Object.freeze(["java", "jdtls", "python3"]),
  envAllowlist: JAVA_ENV_ALLOWLIST,
  approvedDescendantExecutables: Object.freeze(["java", "python3"]),
  envFlag: "KEIKO_EDITOR_LSP_JAVA",
  semanticTokensCandidate: true,
  networkPolicy: "none",
  prepareSpawn: prepareJavaSpawn,
});

export interface JavaProtocolConfiguration {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly initializationOptions: Readonly<Record<string, unknown>>;
}

export function javaProtocolConfiguration(
  configuration: ManagedLspJavaConfiguration,
): JavaProtocolConfiguration {
  const settings = configuration.settings;
  return {
    settings: {
      "java.autobuild.enabled": false,
      "java.configuration.updateBuildConfiguration": "disabled",
      "java.eclipse.downloadSources": false,
      "java.executeCommand.enabled": false,
      "java.import.gradle.annotationProcessing.enabled": false,
      "java.import.gradle.arguments": [],
      "java.import.gradle.enabled": false,
      "java.import.gradle.offline.enabled": true,
      "java.import.gradle.wrapper.enabled": false,
      "java.import.gradle.jvmArguments": [],
      "java.import.maven.enabled": false,
      "java.import.maven.offline.enabled": true,
      "java.maven.downloadSources": false,
      "java.maven.updateSnapshots": false,
      "java.configuration.maven.defaultMojoExecutionAction": "ignore",
      "java.configuration.maven.notCoveredPluginExecutionSeverity": "error",
      "java.project.importOnFirstTimeStartup": "disabled",
      "java.project.referencedLibraries": settings.classpath.map((path) => path.path),
      "java.project.sourcePaths": settings.projectRoots.map((path) => path.path),
    },
    initializationOptions: {
      bundles: [],
      settings: nestedJavaSafeSettings(
        settings.classpath.map((path) => path.path),
        settings.projectRoots.map((path) => path.path),
      ),
      extendedClientCapabilities: {
        classFileContentsSupport: false,
        generateToStringPromptSupport: false,
        moveRefactoringSupport: false,
        progressReportProvider: false,
      },
    },
  };
}

function nestedJavaSafeSettings(
  classpath: readonly string[],
  sourcePaths: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    java: {
      autobuild: { enabled: false },
      configuration: {
        updateBuildConfiguration: "disabled",
        maven: {
          defaultMojoExecutionAction: "ignore",
          notCoveredPluginExecutionSeverity: "error",
        },
      },
      eclipse: { downloadSources: false },
      executeCommand: { enabled: false },
      import: {
        gradle: {
          annotationProcessing: { enabled: false },
          arguments: [],
          enabled: false,
          jvmArguments: [],
          offline: { enabled: true },
          wrapper: { enabled: false },
        },
        maven: { enabled: false, offline: { enabled: true } },
      },
      maven: { downloadSources: false, updateSnapshots: false },
      project: { referencedLibraries: classpath, sourcePaths },
    },
  };
}

interface RuntimeUsage {
  readonly files: number;
  readonly bytes: number;
}

function runtimeUsage(root: string): RuntimeUsage {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory)) {
      const stat = lstatSync(join(directory, entry));
      if (stat.isSymbolicLink()) return { files: MAX_RUNTIME_FILES + 1, bytes };
      files += 1;
      if (stat.isDirectory()) pending.push(join(directory, entry));
      else if (stat.isFile()) {
        bytes += stat.size;
      }
      if (files > MAX_RUNTIME_FILES || bytes > MAX_RUNTIME_BYTES) return { files, bytes };
    }
  }
  return { files, bytes };
}

function pathContained(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function privateRuntimeStateRoot(input: LspSpawnPreparationInput): string {
  if (input.privateRuntimeStateRoot === undefined) {
    throw new Error("Java LSP private runtime-state root is unavailable");
  }
  const privateRoot = realpathSync(input.privateRuntimeStateRoot);
  const workspaceRoot = realpathSync(input.workspace.root);
  if (pathContained(workspaceRoot, privateRoot) || pathContained(privateRoot, workspaceRoot)) {
    throw new Error("Java LSP private runtime-state root overlaps the workspace");
  }
  return privateRoot;
}

function createJavaRuntimeRoot(input: LspSpawnPreparationInput): {
  readonly root: string;
  readonly configuration: string;
  readonly data: string;
} {
  const privateRoot = privateRuntimeStateRoot(input);
  const root = mkdtempSync(join(privateRoot, "jdtls-"));
  try {
    chmodSync(root, 0o700);
    const canonicalRoot = realpathSync(root);
    if (!pathContained(privateRoot, canonicalRoot)) {
      throw new Error("Java LSP runtime-state generation escaped the private root");
    }
    const configuration = join(canonicalRoot, "configuration");
    const data = join(canonicalRoot, "data");
    mkdirSync(configuration, { mode: 0o700 });
    chmodSync(configuration, 0o700);
    mkdirSync(data, { mode: 0o700 });
    chmodSync(data, 0o700);
    return { root: canonicalRoot, configuration, data };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function nativeBackends(input: LspSpawnPreparationInput): ReturnType<typeof probeBackends> {
  const probed = probeBackends(input.processEnv, currentPlatform());
  return { ...probed, docker: false, podman: false };
}

function containsForbiddenProjectMetadata(root: string): boolean {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory)) {
      visited += 1;
      if (visited > MAX_RUNTIME_FILES) return true;
      if (FORBIDDEN_PROJECT_ENTRIES.has(entry) || entry === ".settings") return true;
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) pending.push(path);
    }
  }
  return false;
}

export interface JavaSpawnSecurityDeps {
  readonly availability?: BackendAvailability | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly resolveExecutable?: typeof resolveExecutableOutsideWorkspace | undefined;
  readonly resolveJava?: typeof resolveExecutableOutsideWorkspace | undefined;
  readonly validateLayout?:
    ((executable: string, platform: NodeJS.Platform) => boolean) | undefined;
  readonly validateJavaVersion?: ((executable: string) => boolean) | undefined;
}

function jdtPlatformConfiguration(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return "config_mac";
  if (platform === "linux") return "config_linux";
  if (platform === "win32") return "config_win";
  return undefined;
}

function validJdtlsLayout(executable: string, platform: NodeJS.Platform): boolean {
  const configuration = jdtPlatformConfiguration(platform);
  if (configuration === undefined) return false;
  const root = dirname(dirname(executable));
  const plugins = join(root, "plugins");
  if (!existsSync(join(root, configuration)) || !existsSync(plugins)) return false;
  return readdirSync(plugins).some((name) =>
    name.startsWith(`org.eclipse.jdt.ls.core_${SUPPORTED_JDT_LS_VERSION}.`),
  );
}

function javaMajorVersion(output: string): number {
  const match = /version "(?<major>\d+)/u.exec(output);
  return Number(match?.groups?.major ?? 0);
}

const JAVA_VERSION_PROBE_TIMEOUT_MS = 5_000;

// Wraps the `java -version` probe below through the hardened cmd.exe seam (issue #3350 / Node
// CVE-2024-27980): since that fix, spawning a `.cmd`/`.bat` target with `shell: false` raises EINVAL
// on Windows, and a Windows JDK managed through a version-manager shim (jenv/jabba/scoop-style
// wrappers commonly install `java.cmd` rather than a native `java.exe`) resolves to exactly that
// shape. A pure function, exported so the win32 branch is reachable from a test on any host — the
// same seam lspNodeAdapter.ts's `buildLspSpawnPlan` establishes for the LSP server's own spawn.
// Production use (`defaultJavaVersionValid`, below) omits `opts` and gets the real
// `process.platform`/`process.env`; every other resolved path (`.exe`, no extension) and every
// non-Windows platform pass through unchanged.
export function buildJavaVersionProbeInvocation(
  executable: string,
  opts?: WindowsShellInvocationOptions,
): WindowsShellInvocation {
  return buildWindowsShellInvocation(executable, ["-version"], opts);
}

// The closed set of outcomes the probe can reach (PR #3355 review IDX63): `validVersion: false`
// alone made an unsupported JDK indistinguishable from a timeout, a missing/unreadable executable,
// a nonzero exit, or output that never parsed as a version string — four different facts about the
// machine collapsed into one boolean, none of them visible to a support bundle. Each member below
// is a distinct, content-free fact; `spawn-error` carries its specific `errorKind` (ETIMEDOUT,
// ENOENT, EACCES, …) read straight off `SpawnSyncReturns.error.code`, so the SAME outcome value
// still lets an operator tell a timeout from a missing binary via the paired field.
type JavaVersionProbeOutcome =
  | "supported"
  | "unsupported-version"
  | "malformed-output"
  | "nonzero-exit"
  | "spawn-error"
  | "invocation-failed";

interface JavaVersionProbeEvidence {
  readonly windowsWrapperEngaged: boolean;
  readonly outcome: JavaVersionProbeOutcome;
  readonly durationMs: number;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly windowsTreeKill?: WindowsTreeKillDisposition | undefined;
}

// Body-free evidence for the branch above (AGENTS.md §8 Rule 1): a support bundle must be able to
// tell whether a hung or failed Windows java probe took the hardened cmd.exe wrapper path — and,
// now, exactly WHICH way it failed and whether a cmd.exe-spawned descendant had to be reaped —
// without ever recording the resolved executable path or the probe's stdout/stderr. Mirrors
// lspNodeAdapter.ts's `logLspSpawnCompleted` for the LSP server's own spawn; this probe is a
// separate, directly-issued `spawnSync` call that issue #3350's fix never covered because it never
// runs through that adapter. No request-scoped correlation id is available this deep in spawn
// preparation, so the line carries UNKNOWN_CORRELATION_ID, exactly like its sibling. Called on
// EVERY exit from the probe, including a pre-spawn invocation-build failure (IDX63): a hostile or
// malformed SystemRoot/WINDIR makes `buildWindowsShellInvocation` throw before `spawnSync` ever
// runs, and that used to leave no evidence at all.
function logJavaVersionProbeCompleted(evidence: JavaVersionProbeEvidence): void {
  processServerLogSink().write({
    category: "diagnostic",
    op: "lsp.java.version-probe.completed",
    correlationId: UNKNOWN_CORRELATION_ID,
    durationMs: evidence.durationMs,
    ...(evidence.status === undefined ? {} : { status: evidence.status }),
    ...(evidence.errorKind === undefined ? {} : { errorKind: evidence.errorKind }),
    extra: {
      windowsWrapperEngaged: evidence.windowsWrapperEngaged,
      outcome: evidence.outcome,
      platform: process.platform,
      ...(evidence.windowsTreeKill === undefined
        ? {}
        : { windowsTreeKill: evidence.windowsTreeKill }),
    },
  });
}

// Never signal this process or its own parent (PR #3355 review T20/IDX64): a probe child that has
// already fully exited can leave its pid free for an unrelated process to reuse before this runs,
// and `taskkill /PID <pid> /T /F` takes the WHOLE tree rooted at it — on a reused pid that tree can
// be this server or its launcher. Same guard, same reasoning, as keiko-tools exec.ts's
// `isSelfOrParentPid` (not exported — that module owns the async runCommand termination path, this
// is a separate, directly-issued spawnSync probe with no shared state to synchronise). Exported so
// the platform-gating and self/parent-pid refusal are pinned by a test on any host, mirroring
// `buildJavaVersionProbeInvocation`'s existing testable-pure-function shape in this same file.
export function shouldAttemptWindowsProbeTreeKill(
  windowsWrapperEngaged: boolean,
  platform: NodeJS.Platform,
  pid: number | undefined,
): boolean {
  if (!windowsWrapperEngaged || platform !== "win32" || pid === undefined) return false;
  return pid !== process.pid && pid !== process.ppid;
}

// The probe runs an executable resolved from the WORKSPACE's environment, so it is untrusted input
// however ordinary `java -version` looks. It inherited this process's FULL environment — every API
// key, token and provider credential the server holds — for a call whose entire output is a version
// string. A planted or shimmed `java` on PATH could read all of it.
//
// Narrowed to the variables a JVM genuinely needs to start: the loader path, the Windows system
// root (DLL resolution), and the temp/home locations a JVM writes to. `buildSandboxEnv` is the same
// allowlist primitive the governed spawn boundary uses, so this is not a second mechanism.
export const JAVA_PROBE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "SystemRoot",
  "windir",
  "SystemDrive",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
];

// Isolates the ONE throwing step (IDX63): a hostile or malformed SystemRoot/WINDIR makes
// `buildWindowsShellInvocation` throw before any process is spawned. Logging here, right at the
// throw, is what makes that failure visible at all — `prepareJavaSpawn`'s own catch (below) does
// cleanup and rethrows without logging, by design shared with every other precondition it guards.
function buildInvocationOrLog(executable: string, elapsed: () => number): WindowsShellInvocation {
  try {
    return buildJavaVersionProbeInvocation(executable);
  } catch (error) {
    logJavaVersionProbeCompleted({
      windowsWrapperEngaged: false,
      outcome: "invocation-failed",
      durationMs: elapsed(),
      errorKind: errorKindOf(error),
    });
    throw error;
  }
}

// Best-effort win32 defense in depth (T20/IDX64) — see the caller for what this does and does not
// close. `pid` narrows to `number` from the guard alone so callers never need their own check.
function reapWindowsProbeDescendant(
  windowsWrapperEngaged: boolean,
  pid: number | undefined,
  processEnv: NodeJS.ProcessEnv,
): WindowsTreeKillDisposition | undefined {
  if (pid === undefined) return undefined;
  if (!shouldAttemptWindowsProbeTreeKill(windowsWrapperEngaged, process.platform, pid)) {
    return undefined;
  }
  return nodeWindowsTreeKill(pid, processEnv);
}

// The closed classification (IDX63): an unsupported JDK, a nonzero exit, and output that never
// parsed as a version string are now three distinct, distinguishable facts instead of one boolean.
function classifyJavaVersionProbeOutcome(
  probe: SpawnSyncReturns<string>,
  majorVersion: number,
): { readonly outcome: JavaVersionProbeOutcome; readonly status?: number | undefined } {
  if (probe.error !== undefined) return { outcome: "spawn-error" };
  const status = probe.status ?? undefined;
  if (status !== 0) return { outcome: "nonzero-exit", status };
  if (majorVersion === 0) return { outcome: "malformed-output", status };
  if (majorVersion < MINIMUM_JDK_MAJOR_VERSION) return { outcome: "unsupported-version", status };
  return { outcome: "supported", status };
}

function defaultJavaVersionValid(executable: string): boolean {
  const elapsed = startLogTimer();
  const invocation = buildInvocationOrLog(executable, elapsed);
  const windowsWrapperEngaged = invocation.windowsVerbatimArguments;
  const childEnv = buildSandboxEnv(process.env, JAVA_PROBE_ENV_ALLOWLIST);
  const probe = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout: JAVA_VERSION_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    // No shell, ever: the executable path comes from workspace-influenced resolution.
    shell: false,
    // Without this a console window flashes on every Windows probe — the only spawn in this file
    // that lacked it.
    windowsHide: true,
    env: childEnv,
    ...(windowsWrapperEngaged ? { windowsVerbatimArguments: true } : {}),
  });
  // See `reapWindowsProbeDescendant` and `shouldAttemptWindowsProbeTreeKill` above: bounds the
  // TREE a cmd.exe-wrapped shim may have left running, but cannot bound how long the `spawnSync`
  // call above itself blocked — that half needs the async spawn+timer shape `runCommand` uses,
  // which is out of this provider's reach (see the file-level note near those two functions).
  const windowsTreeKill = reapWindowsProbeDescendant(windowsWrapperEngaged, probe.pid, childEnv);
  const majorVersion = javaMajorVersion(`${probe.stdout}${probe.stderr}`);
  const classified = classifyJavaVersionProbeOutcome(probe, majorVersion);
  logJavaVersionProbeCompleted({
    windowsWrapperEngaged,
    outcome: classified.outcome,
    durationMs: elapsed(),
    status: classified.status,
    ...(probe.error === undefined ? {} : { errorKind: errorKindOf(probe.error) }),
    ...(windowsTreeKill === undefined ? {} : { windowsTreeKill }),
  });
  return classified.outcome === "supported";
}

function isolatedJavaCommand(
  input: LspSpawnPreparationInput,
  runtime: ReturnType<typeof createJavaRuntimeRoot>,
  securityDeps: JavaSpawnSecurityDeps,
): { readonly executable: string; readonly args: readonly string[] } {
  const platform = securityDeps.platform ?? currentPlatform();
  const java = (securityDeps.resolveJava ?? resolveExecutableOutsideWorkspace)(
    "java",
    input.workspace,
    { PATH: input.env.PATH, PATHEXT: input.processEnv.PATHEXT },
  );
  if (!(securityDeps.validateJavaVersion ?? defaultJavaVersionValid)(java)) {
    throw new Error("Java runtime does not meet the minimum supported JDK version");
  }
  const args = [
    ...input.args,
    "--validate-java-version",
    `--java-executable=${java}`,
    "-configuration",
    runtime.configuration,
    "-data",
    runtime.data,
  ];
  const decision = planIsolatedRun(
    { command: input.executable, args, cwd: input.workspace.root, network: "none" },
    securityDeps.availability ?? nativeBackends(input),
    platform,
  );
  if (decision.kind !== "wrapped" || !decision.attestation.networkEnforced) {
    throw new Error("Java LSP egress isolation unavailable");
  }
  return {
    executable: (securityDeps.resolveExecutable ?? resolveExecutableOutsideWorkspace)(
      decision.command,
      input.workspace,
      input.processEnv,
    ),
    args: decision.args,
  };
}

export function prepareJavaSpawn(
  input: LspSpawnPreparationInput,
  securityDeps: JavaSpawnSecurityDeps = {},
): LspSpawnPreparation {
  const runtime = createJavaRuntimeRoot(input);
  try {
    if (containsForbiddenProjectMetadata(input.workspace.root)) {
      throw new Error("Java standalone mode rejects project import metadata");
    }
    const platform = securityDeps.platform ?? currentPlatform();
    if (!(securityDeps.validateLayout ?? validJdtlsLayout)(input.executable, platform)) {
      throw new Error("Java LSP provisioning does not match the supported distribution");
    }
    const command = isolatedJavaCommand(input, runtime, securityDeps);
    return {
      ...command,
      env: input.env,
      cleanup: (): void => {
        rmSync(runtime.root, { recursive: true, force: true });
      },
      resourceBudgetSatisfied: (): boolean => {
        const usage = runtimeUsage(runtime.root);
        return usage.files <= MAX_RUNTIME_FILES && usage.bytes <= MAX_RUNTIME_BYTES;
      },
    };
  } catch (error) {
    rmSync(runtime.root, { recursive: true, force: true });
    throw error;
  }
}
