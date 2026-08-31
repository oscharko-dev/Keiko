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
import { performance } from "node:perf_hooks";

import type {
  LanguageServiceOperation,
  ManagedLspJavaConfiguration,
} from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";
import { currentPlatform, planIsolatedRun, probeBackends } from "@oscharko-dev/keiko-sandbox";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandResult,
  type ExecutableResolver,
  type HomeProvider,
  type RunCommandDeps,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";

import type { HostLanguageProviderSpec } from "../hostLanguageProviders.js";
import { resolveExecutableOutsideWorkspace } from "../lspNodeAdapter.js";
import type { LspSpawnPreparation, LspSpawnPreparationInput } from "../lspProcessManager.js";
import { UNKNOWN_CORRELATION_ID } from "../../../correlation.js";
import { errorKindOf, startLogTimer } from "../../../observability/index.js";
import { logCommandTermination, processServerLogSink } from "../../../process-log-sink.js";

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
const JAVA_VERSION_PROBE_TIMEOUT_MS = 5_000;
const JAVA_VERSION_PROBE_OUTPUT_BYTES = 16_384;
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

function nativeBackends(
  input: LspSpawnPreparationInput,
  platform: NodeJS.Platform,
): ReturnType<typeof probeBackends> {
  const probed = probeBackends(input.processEnv, platform);
  return { ...probed, docker: false, podman: false };
}

interface ProjectDirectoryScan {
  readonly forbidden: boolean;
  readonly subdirectories: readonly string[];
  readonly visitedCount: number;
}

function scanProjectDirectory(directory: string, remainingVisits: number): ProjectDirectoryScan {
  const subdirectories: string[] = [];
  let visitedCount = 0;
  for (const entry of readdirSync(directory)) {
    visitedCount += 1;
    if (visitedCount > remainingVisits) {
      return { forbidden: true, subdirectories, visitedCount };
    }
    if (FORBIDDEN_PROJECT_ENTRIES.has(entry) || entry === ".settings") {
      return { forbidden: true, subdirectories, visitedCount };
    }
    const path = join(directory, entry);
    const stat = lstatSync(path);
    // Workspace-controlled links are not traversed: following them would escape the bounded scan,
    // while ignoring them lets a linked project root hide build/import metadata.
    if (stat.isSymbolicLink()) {
      return { forbidden: true, subdirectories, visitedCount };
    }
    if (stat.isDirectory()) subdirectories.push(path);
  }
  return { forbidden: false, subdirectories, visitedCount };
}

function containsForbiddenProjectMetadata(root: string): boolean {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const scan = scanProjectDirectory(directory, MAX_RUNTIME_FILES - visited);
    visited += scan.visitedCount;
    if (scan.forbidden) return true;
    pending.push(...scan.subdirectories);
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
  readonly runProbe?: typeof runCommand | undefined;
  readonly probeSpawn?: SpawnFn | undefined;
  readonly probeHome?: HomeProvider | undefined;
  readonly probeNow?: (() => number) | undefined;
}

type JavaVersionValidationOutcome =
  | "supported"
  | "unsupported-version"
  | "malformed-output"
  | "nonzero-exit"
  | "output-cap"
  | "timeout"
  | "spawn-error"
  | "invocation-failed"
  | "cancelled";

class JavaVersionProbeError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "JavaVersionProbeError";
    this.code = code;
  }
}

function logJavaVersionValidation(
  platform: NodeJS.Platform,
  outcome: JavaVersionValidationOutcome,
  durationMs: number,
  error?: unknown,
  status?: number,
): void {
  processServerLogSink().write({
    category: "diagnostic",
    op: "lsp.java.version-probe.completed",
    correlationId: UNKNOWN_CORRELATION_ID,
    durationMs,
    ...(status === undefined ? {} : { status }),
    ...(error === undefined ? {} : { errorKind: errorKindOf(error) }),
    extra: {
      executionBoundary: "governed-pre-spawn",
      outcome,
      platform,
    },
  });
}

function failJavaVersionValidation(
  error: Error,
  platform: NodeJS.Platform,
  outcome: Exclude<JavaVersionValidationOutcome, "supported">,
  elapsed: () => number,
): never {
  logJavaVersionValidation(platform, outcome, elapsed(), error);
  throw error;
}

function javaMajorVersion(output: string): number | undefined {
  const match = /version\s+"(?<major>\d+)/u.exec(output);
  const major = Number(match?.groups?.major);
  return Number.isSafeInteger(major) ? major : undefined;
}

function classifyProbeResult(result: CommandResult): JavaVersionValidationOutcome {
  if (result.truncated) return "output-cap";
  if (result.exitCode !== 0) return "nonzero-exit";
  const major = javaMajorVersion(`${result.stdout}${result.stderr}`);
  if (major === undefined) return "malformed-output";
  return major >= 21 ? "supported" : "unsupported-version";
}

function probeFailureCode(outcome: Exclude<JavaVersionValidationOutcome, "supported">): string {
  if (outcome === "unsupported-version") return "JAVA_VERSION_UNSUPPORTED";
  if (outcome === "malformed-output") return "JAVA_VERSION_MALFORMED_OUTPUT";
  if (outcome === "nonzero-exit") return "JAVA_VERSION_NONZERO_EXIT";
  if (outcome === "output-cap") return "JAVA_VERSION_OUTPUT_CAP";
  return "JAVA_VERSION_PROBE_FAILED";
}

function rejectedProbeOutcome(error: unknown): JavaVersionValidationOutcome {
  if (error instanceof CommandCancelledError) return "cancelled";
  if (error instanceof CommandTimeoutError) return "timeout";
  if (error instanceof CommandDeniedError) return "invocation-failed";
  return "spawn-error";
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

function exactJavaProbeResolver(
  java: string,
  input: LspSpawnPreparationInput,
  platform: NodeJS.Platform,
  securityDeps: JavaSpawnSecurityDeps,
): ExecutableResolver {
  return (command): string => {
    if (command === "java") return java;
    return (securityDeps.resolveExecutable ?? resolveExecutableOutsideWorkspace)(
      command,
      input.workspace,
      input.processEnv,
      platform,
    );
  };
}

function javaProbeRunDeps(
  java: string,
  input: LspSpawnPreparationInput,
  platform: NodeJS.Platform,
  availability: BackendAvailability,
  securityDeps: JavaSpawnSecurityDeps,
): RunCommandDeps {
  return {
    workspace: input.workspace,
    policy: {
      ...DEFAULT_SANDBOX_POLICY,
      envAllowlist: JAVA_ENV_ALLOWLIST,
      pinnedEnv: { ...input.env },
      homeIsolation: "ephemeral",
      network: "none",
      maxOutputBytes: JAVA_VERSION_PROBE_OUTPUT_BYTES,
      defaultTimeoutMs: JAVA_VERSION_PROBE_TIMEOUT_MS,
    },
    commandRules: [{ executable: "java", requiredLeadingFlags: ["-version"] }],
    spawn: securityDeps.probeSpawn ?? nodeSpawnFn,
    resolveExecutable: exactJavaProbeResolver(java, input, platform, securityDeps),
    processEnv: { ...input.processEnv },
    now: securityDeps.probeNow ?? ((): number => performance.now()),
    sandboxAvailability: { ...availability },
    platform,
    ...(securityDeps.probeHome === undefined ? {} : { home: securityDeps.probeHome }),
  };
}

function completeJavaVersionProbe(
  result: CommandResult,
  platform: NodeJS.Platform,
  elapsed: () => number,
): void {
  if (result.attestation?.networkEnforced !== true) {
    failJavaVersionValidation(
      new JavaVersionProbeError("JAVA_VERSION_ISOLATION_UNAVAILABLE"),
      platform,
      "invocation-failed",
      elapsed,
    );
  }
  const outcome = classifyProbeResult(result);
  const status = result.exitCode ?? undefined;
  if (outcome === "supported") {
    logJavaVersionValidation(platform, outcome, elapsed(), undefined, status);
    return;
  }
  const error = new JavaVersionProbeError(probeFailureCode(outcome));
  logJavaVersionValidation(platform, outcome, elapsed(), error, status);
  throw error;
}

async function runJavaVersionProbe(
  java: string,
  input: LspSpawnPreparationInput,
  platform: NodeJS.Platform,
  availability: BackendAvailability,
  securityDeps: JavaSpawnSecurityDeps,
  signal: AbortSignal,
): Promise<void> {
  const elapsed = startLogTimer();
  let result: CommandResult;
  try {
    result = await (securityDeps.runProbe ?? runCommand)(
      {
        command: "java",
        args: ["-version"],
        cwd: undefined,
        timeoutMs: JAVA_VERSION_PROBE_TIMEOUT_MS,
        signal,
        onTerminated: (evidence) => {
          logCommandTermination(processServerLogSink(), UNKNOWN_CORRELATION_ID, evidence);
        },
      },
      javaProbeRunDeps(java, input, platform, availability, securityDeps),
    );
  } catch (error) {
    const outcome = rejectedProbeOutcome(error);
    logJavaVersionValidation(platform, outcome, elapsed(), error);
    throw error;
  }
  completeJavaVersionProbe(result, platform, elapsed);
}

function snapshotSpawnInput(input: LspSpawnPreparationInput): LspSpawnPreparationInput {
  return {
    ...input,
    args: [...input.args],
    env: { ...input.env },
    processEnv: { ...input.processEnv },
  };
}

function governedJavaCommand(
  input: LspSpawnPreparationInput,
  runtime: ReturnType<typeof createJavaRuntimeRoot>,
  securityDeps: JavaSpawnSecurityDeps,
  platform: NodeJS.Platform,
  java: string,
  availability: BackendAvailability,
): { readonly executable: string; readonly args: readonly string[] } {
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
    availability,
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

function assertJavaPlatformSupported(platform: NodeJS.Platform): void {
  if (platform !== "win32") return;
  failJavaVersionValidation(
    new Error("Java LSP egress isolation unavailable on Windows"),
    platform,
    "invocation-failed",
    startLogTimer(),
  );
}

function isolatedJavaCommand(
  input: LspSpawnPreparationInput,
  runtime: ReturnType<typeof createJavaRuntimeRoot>,
  securityDeps: JavaSpawnSecurityDeps,
  platform: NodeJS.Platform,
): LspSpawnPreparation {
  const elapsed = startLogTimer();
  try {
    const java = (securityDeps.resolveJava ?? resolveExecutableOutsideWorkspace)(
      "java",
      input.workspace,
      { PATH: input.env.PATH, PATHEXT: input.processEnv.PATHEXT },
    );
    const discovered = securityDeps.availability ?? nativeBackends(input, platform);
    const availability = { ...discovered, docker: false, podman: false };
    const command = governedJavaCommand(input, runtime, securityDeps, platform, java, availability);
    return {
      ...command,
      env: input.env,
      beforeSpawn: (signal) =>
        runJavaVersionProbe(java, input, platform, availability, securityDeps, signal),
    };
  } catch (error) {
    return failJavaVersionValidation(
      error instanceof Error ? error : new Error("Java LSP launcher preparation failed"),
      platform,
      "invocation-failed",
      elapsed,
    );
  }
}

export function prepareJavaSpawn(
  input: LspSpawnPreparationInput,
  securityDeps: JavaSpawnSecurityDeps = {},
): LspSpawnPreparation {
  const platform = securityDeps.platform ?? currentPlatform();
  // The generic container fallback is Linux and cannot execute a host java.exe/.cmd/.bat, read the
  // host JDT LS distribution, or preserve Windows document URIs. Refuse every Windows shape before
  // resolution, layout inspection, runtime-state creation, probe, or isolation planning.
  assertJavaPlatformSupported(platform);
  const runtime = createJavaRuntimeRoot(input);
  try {
    if (containsForbiddenProjectMetadata(input.workspace.root)) {
      throw new Error("Java standalone mode rejects project import metadata");
    }
    if (!(securityDeps.validateLayout ?? validJdtlsLayout)(input.executable, platform)) {
      throw new Error("Java LSP provisioning does not match the supported distribution");
    }
    const command = isolatedJavaCommand(snapshotSpawnInput(input), runtime, securityDeps, platform);
    return {
      ...command,
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
