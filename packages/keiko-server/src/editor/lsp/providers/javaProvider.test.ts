import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ManagedLspJavaConfiguration, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  type CommandResult,
  type HomeProvider,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";

import type { LspSpawnPreparationInput } from "../lspProcessManager.js";
import { JAVA_PROVIDER_SPEC, javaProtocolConfiguration, prepareJavaSpawn } from "./javaProvider.js";
import { UNKNOWN_CORRELATION_ID } from "../../../correlation.js";
import { redactLogFields } from "../../../observability/log-redaction.js";
import type { ServerLogEvent } from "../../../observability/server-log.js";
import {
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../../../observability/server-logger.js";

const NATIVE: BackendAvailability = {
  bubblewrap: true,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};
let root = "";
let runtimeStateRoot = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-java-provider-")));
  runtimeStateRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-java-runtime-state-")));
  writeFileSync(join(root, "Main.java"), "final class Main {}\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeStateRoot, { recursive: true, force: true });
  resetServerLogger();
});

function configuration(): ManagedLspJavaConfiguration {
  return {
    schemaVersion: "1",
    language: "java",
    revision: 4,
    etag: '"lspcfg-4-abcdefghijklmnop"',
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "jdtls-1.60.0" },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "workspace",
    },
    restartRequired: false,
    restartFields: [],
    settings: {
      jdk: { kind: "operatorApproved", runtimeId: "jdk-21" },
      sourceLevel: "21",
      targetLevel: "21",
      classpath: [{ kind: "workspaceRelative", path: "lib/reviewed.jar" }],
      projectRoots: [{ kind: "workspaceRelative", path: "src" }],
      projectImport: "safeOffline",
      buildToolExecution: false,
      annotationProcessing: false,
      dependencyDownloads: false,
      configurationFile: { kind: "workspaceRelative", path: "formatter.xml" },
    },
  };
}

function workspace(): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: ["java"],
    ignoreLines: [],
  };
}

function spawnInput(overrides: Partial<LspSpawnPreparationInput> = {}): LspSpawnPreparationInput {
  return {
    executable: "/opt/jdtls/bin/jdtls",
    args: [],
    env: { PATH: root },
    workspace: workspace(),
    processEnv: {},
    privateRuntimeStateRoot: runtimeStateRoot,
    ...overrides,
  };
}

function captureLog(): ServerLogEvent[] {
  const events: ServerLogEvent[] = [];
  setServerLogger(
    createServerLogger({ sink: { write: (event) => events.push(event) }, level: "debug" }),
  );
  return events;
}

function probeResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "java",
    args: ["-version"],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: 'openjdk version "21.0.1" 2024-01-16',
    durationMs: 1,
    timedOut: false,
    truncated: false,
    attestation: {
      backend: "bubblewrap",
      networkEnforced: true,
      filesystemEnforced: false,
      platform: "linux",
    },
    ...overrides,
  };
}

function probeSecurity(overrides: JavaProbeOverrides = {}): JavaProbeOverrides {
  return {
    availability: NATIVE,
    platform: "linux",
    resolveExecutable: () => "/usr/bin/bwrap",
    resolveJava: () => "/opt/jdk/bin/java",
    validateLayout: () => true,
    ...overrides,
  };
}

type JavaProbeOverrides = NonNullable<Parameters<typeof prepareJavaSpawn>[1]>;

async function executeProbe(
  security: JavaProbeOverrides,
  input: LspSpawnPreparationInput = spawnInput(),
): Promise<void> {
  const prepared = prepareJavaSpawn(input, security);
  try {
    const beforeSpawn = prepared.beforeSpawn;
    if (beforeSpawn === undefined) throw new TypeError("Java beforeSpawn probe missing");
    await beforeSpawn(new AbortController().signal);
  } finally {
    prepared.cleanup?.();
  }
}

interface GovernedProbeExpectation {
  readonly spawned:
    | {
        readonly command: string;
        readonly args: readonly string[];
        readonly env: Record<string, string>;
      }
    | undefined;
  readonly privatePath: string;
  readonly javaPath: string;
  readonly madeHomes: readonly string[];
  readonly cleanedHomes: readonly string[];
  readonly events: readonly ServerLogEvent[];
}

function expectGovernedProbeEvidence(input: GovernedProbeExpectation): void {
  const { spawned, privatePath, javaPath, madeHomes, cleanedHomes, events } = input;
  if (spawned === undefined) throw new Error("Expected the governed Java probe to spawn");
  expect(spawned.command).toBe("/usr/bin/bwrap");
  expect(spawned.args).toContain(javaPath);
  expect(spawned.env).toMatchObject({
    PATH: privatePath,
    HOME: madeHomes[0],
    USERPROFILE: madeHomes[0],
  });
  expect(spawned.env).not.toHaveProperty("HOSTILE_JAVA_PROBE_SECRET");
  expect(cleanedHomes).toEqual(madeHomes);

  const validation = events.find((event) => event.op === "lsp.java.version-probe.completed");
  if (validation === undefined) throw new Error("Expected Java probe activity evidence");
  expect(validation).toMatchObject({
    category: "diagnostic",
    correlationId: UNKNOWN_CORRELATION_ID,
    status: 0,
    extra: {
      executionBoundary: "governed-pre-spawn",
      outcome: "supported",
      platform: "linux",
    },
  });
  expect(validation.errorKind).toBeUndefined();
  expect(redactLogFields(validation.extra ?? {})).toEqual(validation.extra);
  expect(JSON.stringify(validation)).not.toContain(javaPath);
  expect(JSON.stringify(validation)).not.toContain("must-not-reach-probe");
}

describe("managed Eclipse JDT LS provider", () => {
  it("advertises the negotiated analysis surface under enforced no-egress policy", () => {
    expect(JAVA_PROVIDER_SPEC).toMatchObject({
      executableName: "jdtls",
      requiredExecutables: ["java", "jdtls", "python3"],
      approvedDescendantExecutables: ["java", "python3"],
      networkPolicy: "none",
    });
    expect(JAVA_PROVIDER_SPEC.envAllowlist).not.toContain("JAVA_HOME");
    expect(JAVA_PROVIDER_SPEC.envAllowlist).not.toContain("PATH");
    expect(JAVA_PROVIDER_SPEC.operations).toHaveLength(15);
  });

  it("keeps JDK validation inside the governed no-egress launcher boundary", () => {
    const source = readFileSync(new URL("./javaProvider.ts", import.meta.url), "utf8");
    expect(source).not.toContain("spawnSync");
    expect(source).toContain('"--validate-java-version"');
    expect(JAVA_PROVIDER_SPEC.requiredExecutables).toContain("python3");
  });

  it("documents the in-boundary launcher probe and honest Windows posture", () => {
    const docUrl = new URL(
      "../../../../../../docs/troubleshooting/managed-java-language-provider.md",
      import.meta.url,
    );
    const doc = readFileSync(docUrl, "utf8");
    expect(doc).toMatch(/validate-java-version/is);
    expect(doc).toMatch(/Windows.+unavailable/is);
  });

  it("projects every active JDT import and command default into a closed safe profile", () => {
    const result = javaProtocolConfiguration(configuration());

    expect(result.settings).toMatchObject({
      "java.autobuild.enabled": false,
      "java.executeCommand.enabled": false,
      "java.import.maven.enabled": false,
      "java.import.maven.offline.enabled": true,
      "java.import.gradle.enabled": false,
      "java.import.gradle.offline.enabled": true,
      "java.import.gradle.wrapper.enabled": false,
      "java.import.gradle.annotationProcessing.enabled": false,
      "java.import.gradle.arguments": [],
      "java.import.gradle.jvmArguments": [],
      "java.maven.downloadSources": false,
      "java.eclipse.downloadSources": false,
      "java.maven.updateSnapshots": false,
      "java.configuration.updateBuildConfiguration": "disabled",
    });
    expect(result.initializationOptions).toMatchObject({
      bundles: [],
      settings: { java: { import: { maven: { enabled: false }, gradle: { enabled: false } } } },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("formatter.xml");
    expect(serialized).not.toContain("JAVA_HOME");
    expect(serialized).not.toContain("sourceLevel");
    expect(serialized).not.toContain("buildToolExecution");
  });

  it("creates unique private state and wraps JDT LS with an enforcing native backend", () => {
    const javaPath = "/opt/jdk-21/bin/java";
    const prepared = prepareJavaSpawn(spawnInput({ processEnv: { PATH: "/usr/bin" } }), {
      availability: NATIVE,
      platform: "linux",
      resolveExecutable: () => "/usr/bin/bwrap",
      resolveJava: () => javaPath,
      validateLayout: () => true,
    });
    const configurationIndex = prepared.args.indexOf("-configuration");
    const dataIndex = prepared.args.indexOf("-data");
    const configurationPath = prepared.args[configurationIndex + 1] ?? "";
    const dataPath = prepared.args[dataIndex + 1] ?? "";
    const generationPath = dirname(configurationPath);

    expect(prepared.executable).toBe("/usr/bin/bwrap");
    expect(prepared.args).toContain("--unshare-net");
    expect(prepared.args).toContain("--validate-java-version");
    expect(prepared.args).toContain(`--java-executable=${javaPath}`);
    expect(generationPath.startsWith(`${runtimeStateRoot}/`)).toBe(true);
    expect(dirname(dataPath)).toBe(generationPath);
    expect(statSync(generationPath).mode & 0o777).toBe(0o700);
    expect(statSync(configurationPath).mode & 0o777).toBe(0o700);
    expect(statSync(dataPath).mode & 0o777).toBe(0o700);
    expect(prepared.resourceBudgetSatisfied?.()).toBe(true);
    expect(prepared.beforeSpawn).toBeTypeOf("function");
    writeFileSync(join(configurationPath, "config-state"), "state", "utf8");
    writeFileSync(join(dataPath, "workspace-state"), "state", "utf8");
    prepared.cleanup?.();
    expect(existsSync(configurationPath)).toBe(false);
    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(generationPath)).toBe(false);
    expect(readdirSync(runtimeStateRoot)).toEqual([]);
  });

  it("creates runtime state only beneath the explicitly injected private root", () => {
    const hostileHome = join(root, "hostile-home");
    const hostileTmp = join(root, "hostile-tmp");
    mkdirSync(hostileHome);
    mkdirSync(hostileTmp);
    const prepared = prepareJavaSpawn(
      spawnInput({
        env: { HOME: hostileHome, PATH: root, TMPDIR: hostileTmp },
        processEnv: {
          HOME: hostileHome,
          TMPDIR: hostileTmp,
          TEMP: hostileTmp,
          TMP: hostileTmp,
        },
      }),
      {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => true,
      },
    );
    try {
      const configurationIndex = prepared.args.indexOf("-configuration");
      const configurationPath = prepared.args[configurationIndex + 1] ?? "";

      expect(configurationPath.startsWith(`${runtimeStateRoot}/`)).toBe(true);
      expect(configurationPath.startsWith(`${root}/`)).toBe(false);
    } finally {
      prepared.cleanup?.();
    }
    expect(readdirSync(runtimeStateRoot)).toEqual([]);
  });

  it("creates a fresh generation for every spawn preparation", () => {
    const first = prepareJavaSpawn(spawnInput(), {
      availability: NATIVE,
      platform: "linux",
      resolveExecutable: () => "/usr/bin/bwrap",
      resolveJava: () => "/opt/jdk-21/bin/java",
      validateLayout: () => true,
    });
    const second = prepareJavaSpawn(spawnInput(), {
      availability: NATIVE,
      platform: "linux",
      resolveExecutable: () => "/usr/bin/bwrap",
      resolveJava: () => "/opt/jdk-21/bin/java",
      validateLayout: () => true,
    });
    try {
      const firstPath = first.args[first.args.indexOf("-configuration") + 1] ?? "";
      const secondPath = second.args[second.args.indexOf("-configuration") + 1] ?? "";
      expect(dirname(firstPath)).not.toBe(dirname(secondPath));
      expect(readdirSync(runtimeStateRoot)).toHaveLength(2);
    } finally {
      first.cleanup?.();
      second.cleanup?.();
    }
    expect(readdirSync(runtimeStateRoot)).toEqual([]);
  });

  it("fails closed without an explicitly injected private runtime-state root", () => {
    expect(() =>
      prepareJavaSpawn(spawnInput({ privateRuntimeStateRoot: undefined }), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => true,
      }),
    ).toThrow("private runtime-state root is unavailable");
  });

  it("rejects private runtime-state roots that overlap the workspace", () => {
    const workspaceState = join(root, "runtime-state");
    mkdirSync(workspaceState, { mode: 0o700 });
    expect(() =>
      prepareJavaSpawn(spawnInput({ privateRuntimeStateRoot: workspaceState }), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => true,
      }),
    ).toThrow("overlaps the workspace");
    expect(readdirSync(workspaceState)).toEqual([]);
  });

  it("resolves private-root aliases before enforcing workspace disjointness", () => {
    const workspaceAlias = join(runtimeStateRoot, "workspace-link");
    symlinkSync(root, workspaceAlias, "dir");
    expect(() =>
      prepareJavaSpawn(spawnInput({ privateRuntimeStateRoot: workspaceAlias }), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => true,
      }),
    ).toThrow("overlaps the workspace");
  });

  it.each(["pom.xml", "build.gradle.kts", ".project", ".factorypath", "gradlew", "mvnw"])(
    "fails before spawn when %s exposes an execution-requiring project importer",
    (entry) => {
      const path = join(root, entry);
      writeFileSync(path, "hostile", "utf8");
      expect(() =>
        prepareJavaSpawn(spawnInput(), {
          availability: NATIVE,
          platform: "linux",
          resolveExecutable: () => "/usr/bin/bwrap",
          resolveJava: () => "/opt/jdk-21/bin/java",
          validateLayout: () => true,
        }),
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe("hostile");
    },
  );

  it("rejects Eclipse settings directories without treating them as files", () => {
    const settings = join(root, ".settings");
    mkdirSync(settings);
    expect(() =>
      prepareJavaSpawn(spawnInput(), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => true,
      }),
    ).toThrow();
    expect(statSync(settings).isDirectory()).toBe(true);
  });

  it("fails closed when a workspace symlink could hide project-import metadata", () => {
    const linkedProject = realpathSync(mkdtempSync(join(tmpdir(), "keiko-java-linked-project-")));
    try {
      writeFileSync(join(linkedProject, "pom.xml"), "<project />", "utf8");
      symlinkSync(linkedProject, join(root, "linked-project"), "dir");

      expect(() =>
        prepareJavaSpawn(spawnInput(), {
          availability: NATIVE,
          platform: "linux",
          resolveExecutable: () => "/usr/bin/bwrap",
          resolveJava: () => "/opt/jdk-21/bin/java",
          validateLayout: () => true,
        }),
      ).toThrow("project import metadata");
    } finally {
      rmSync(linkedProject, { recursive: true, force: true });
    }
  });

  it("fails closed when no native egress boundary is available", () => {
    const events = captureLog();
    expect(() =>
      prepareJavaSpawn(spawnInput(), {
        availability: { ...NATIVE, bubblewrap: false },
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => true,
      }),
    ).toThrow();
    expect(events.find((event) => event.op === "lsp.java.version-probe.completed")).toMatchObject({
      errorKind: "Error",
      extra: {
        executionBoundary: "governed-pre-spawn",
        outcome: "invocation-failed",
        platform: "linux",
      },
    });
  });

  it("fails closed when the provisioned JDT LS layout is not the pinned release", () => {
    expect(() =>
      prepareJavaSpawn(spawnInput({ executable: "/opt/unreviewed/bin/jdtls" }), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => false,
      }),
    ).toThrow("supported distribution");
    expect(readdirSync(runtimeStateRoot)).toEqual([]);
  });

  it("does not execute the resolved Java runtime before the isolated launcher starts", () => {
    const resolvedJava = join(root, "java");
    const hostExecutionMarker = join(root, "host-java-executed");
    writeFileSync(
      resolvedJava,
      `#!/bin/sh\n/usr/bin/touch "${hostExecutionMarker}"\necho 'openjdk version "21.0.1" 2024-01-16' 1>&2\nexit 0\n`,
      "utf8",
    );
    chmodSync(resolvedJava, 0o755);

    const prepared = prepareJavaSpawn(spawnInput(), {
      availability: NATIVE,
      platform: "linux",
      resolveExecutable: () => "/usr/bin/bwrap",
      resolveJava: () => resolvedJava,
      validateLayout: () => true,
    });

    expect(existsSync(hostExecutionMarker)).toBe(false);
    expect(prepared.args).toContain(`--java-executable=${resolvedJava}`);
    expect(prepared.args.indexOf("--validate-java-version")).toBeGreaterThan(
      prepared.args.indexOf("--unshare-net"),
    );
    prepared.cleanup?.();
  });

  it("runs the real governed probe with exact resolution, copy-only env, and ephemeral HOME", async () => {
    const events = captureLog();
    const madeHomes: string[] = [];
    const cleanedHomes: string[] = [];
    const home: HomeProvider = {
      make: () => {
        const path = mkdtempSync(join(tmpdir(), "keiko-java-probe-home-"));
        madeHomes.push(path);
        return path;
      },
      cleanup: (path) => {
        cleanedHomes.push(path);
        rmSync(path, { recursive: true, force: true });
      },
    };
    let spawned:
      | {
          readonly command: string;
          readonly args: readonly string[];
          readonly env: Record<string, string>;
        }
      | undefined;
    const probeSpawn: SpawnFn = (command, args, options) => {
      spawned = { command, args, env: options.env };
      return nodeSpawnFn(
        process.execPath,
        ["-e", "process.stderr.write('openjdk version \"21.0.1\" 2024-01-16')"],
        options,
      );
    };
    const privatePath = "/operator-approved/private-path";
    const javaPath = "/opt/jdk-21/bin/java";
    await executeProbe(
      probeSecurity({ probeSpawn, probeHome: home, resolveJava: () => javaPath }),
      spawnInput({
        env: { LANG: "C", PATH: privatePath },
        processEnv: {
          PATH: "/host/path",
          HOSTILE_JAVA_PROBE_SECRET: "must-not-reach-probe",
        },
      }),
    );

    expectGovernedProbeEvidence({
      spawned,
      privatePath,
      javaPath,
      madeHomes,
      cleanedHomes,
      events,
    });
  });

  it.each([
    [
      "JDK 17",
      probeResult({ stderr: 'openjdk version "17.0.12"', stdout: "" }),
      "unsupported-version",
      "JAVA_VERSION_UNSUPPORTED",
    ],
    [
      "malformed output",
      probeResult({ stderr: "not a java version", stdout: "" }),
      "malformed-output",
      "JAVA_VERSION_MALFORMED_OUTPUT",
    ],
    [
      "nonzero exit",
      probeResult({ exitCode: 2, stderr: "failure", stdout: "" }),
      "nonzero-exit",
      "JAVA_VERSION_NONZERO_EXIT",
    ],
    [
      "output cap",
      probeResult({ exitCode: null, truncated: true, stderr: "[output truncated]" }),
      "output-cap",
      "JAVA_VERSION_OUTPUT_CAP",
    ],
  ] as const)(
    "fails closed and logs the distinct %s probe outcome",
    async (_name, result, outcome, errorKind) => {
      const events = captureLog();
      await expect(
        executeProbe(probeSecurity({ runProbe: () => Promise.resolve(result) })),
      ).rejects.toMatchObject({ code: errorKind });

      const validation = events.find((event) => event.op === "lsp.java.version-probe.completed");
      expect(validation).toMatchObject({
        errorKind,
        extra: { executionBoundary: "governed-pre-spawn", outcome, platform: "linux" },
      });
      expect(typeof validation?.durationMs).toBe("number");
      expect(JSON.stringify(validation)).not.toContain(result.stderr);
    },
  );

  it.each([
    ["timeout", new CommandTimeoutError("timed out", 5_000), "TOOL_COMMAND_TIMEOUT"],
    ["spawn-error", Object.assign(new Error("missing"), { code: "ENOENT" }), "ENOENT"],
    [
      "invocation-failed",
      new CommandDeniedError("isolation unavailable", "java"),
      "TOOL_COMMAND_DENIED",
    ],
    ["cancelled", new CommandCancelledError("cancelled"), "TOOL_COMMAND_CANCELLED"],
  ] as const)(
    "logs the distinct %s rejection with errorKind",
    async (outcome, error, errorKind) => {
      const events = captureLog();
      await expect(
        executeProbe(
          probeSecurity({
            runProbe: () => Promise.reject(error),
          }),
        ),
      ).rejects.toBe(error);

      expect(events.find((event) => event.op === "lsp.java.version-probe.completed")).toMatchObject(
        {
          errorKind,
          extra: { executionBoundary: "governed-pre-spawn", outcome, platform: "linux" },
        },
      );
    },
  );

  it("pins the exact bounded runCommand probe contract and enforced attestation", async () => {
    const runProbe = vi.fn<NonNullable<JavaProbeOverrides["runProbe"]>>((input, deps) => {
      expect(input).toMatchObject({
        command: "java",
        args: ["-version"],
        timeoutMs: 5_000,
      });
      expect(deps.policy).toMatchObject({
        network: "none",
        homeIsolation: "ephemeral",
        maxOutputBytes: 16_384,
      });
      expect(deps.policy.envAllowlist).not.toContain("PATH");
      expect(deps.commandRules).toEqual([
        { executable: "java", requiredLeadingFlags: ["-version"] },
      ]);
      expect(deps.sandboxAvailability).toMatchObject({ docker: false, podman: false });
      return Promise.resolve(probeResult());
    });

    await executeProbe(probeSecurity({ runProbe }));
    expect(runProbe).toHaveBeenCalledOnce();

    await expect(
      executeProbe(
        probeSecurity({
          runProbe: () =>
            Promise.resolve(
              probeResult({
                attestation: {
                  backend: "none",
                  networkEnforced: false,
                  filesystemEnforced: false,
                  platform: "linux",
                },
              }),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: "JAVA_VERSION_ISOLATION_UNAVAILABLE" });
  });

  it.each(["java.exe", "java.cmd", "java.bat"])(
    "uniformly refuses Windows Java runtime %s when no compatible no-egress backend exists",
    (name) => {
      const events = captureLog();
      const resolveJava = vi.fn(() => `${String.raw`C:\ProgramData\jdk\bin`}\\${name}`);
      const resolveExecutable = vi.fn(() => String.raw`C:\Program Files\Docker\docker.exe`);
      const validateLayout = vi.fn(() => true);
      const runProbe = vi.fn<NonNullable<JavaProbeOverrides["runProbe"]>>();

      expect(() =>
        prepareJavaSpawn(spawnInput(), {
          availability: { ...NATIVE, bubblewrap: false, docker: true },
          platform: "win32",
          resolveExecutable,
          resolveJava,
          validateLayout,
          runProbe,
        }),
      ).toThrow("egress isolation unavailable on Windows");
      expect(resolveJava).not.toHaveBeenCalled();
      expect(resolveExecutable).not.toHaveBeenCalled();
      expect(validateLayout).not.toHaveBeenCalled();
      expect(runProbe).not.toHaveBeenCalled();
      expect(readdirSync(runtimeStateRoot)).toEqual([]);
      expect(events.find((event) => event.op === "lsp.java.version-probe.completed")).toMatchObject(
        {
          errorKind: "Error",
          extra: {
            executionBoundary: "governed-pre-spawn",
            outcome: "invocation-failed",
            platform: "win32",
          },
        },
      );
    },
  );
});
