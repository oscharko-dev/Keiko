import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  LanguageServiceOperation,
  ManagedLspJavaConfiguration,
} from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";
import { currentPlatform, planIsolatedRun, probeBackends } from "@oscharko-dev/keiko-sandbox";

import type { HostLanguageProviderSpec } from "../hostLanguageProviders.js";
import { resolveExecutableOutsideWorkspace } from "../lspNodeAdapter.js";
import type { LspSpawnPreparation, LspSpawnPreparationInput } from "../lspProcessManager.js";

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

function createJavaRuntimeRoot(): {
  readonly root: string;
  readonly configuration: string;
  readonly data: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-jdtls-"));
  chmodSync(root, 0o700);
  const configuration = join(root, "configuration");
  const data = join(root, "data");
  mkdirSync(configuration, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  return { root, configuration, data };
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

function defaultJavaVersionValid(executable: string): boolean {
  const probe = spawnSync(executable, ["-version"], { encoding: "utf8" });
  if (probe.status !== 0) return false;
  return javaMajorVersion(`${probe.stdout}${probe.stderr}`) >= MINIMUM_JDK_MAJOR_VERSION;
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
  const runtime = createJavaRuntimeRoot();
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
