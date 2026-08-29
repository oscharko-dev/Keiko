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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ManagedLspJavaConfiguration, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";

import type { LspSpawnPreparationInput } from "../lspProcessManager.js";
import {
  JAVA_PROVIDER_SPEC,
  buildJavaVersionProbeInvocation,
  javaProtocolConfiguration,
  prepareJavaSpawn,
} from "./javaProvider.js";
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
  // The activity-log evidence tests below install a capturing ServerLogger via the process-wide
  // test seam (setServerLogger); resetting unconditionally is a harmless no-op for every other
  // test in this file and prevents leaking a captured sink into an unrelated later suite.
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

  it("documents why python3 is an approved descendant of the java/jdtls launcher", () => {
    const source = readFileSync(new URL("./javaProvider.ts", import.meta.url), "utf8");
    const specSource = source.slice(0, source.indexOf("export const JAVA_PROVIDER_SPEC"));
    expect(specSource).toMatch(/python3.+jdtls`? launcher/is);
    expect(specSource).toMatch(/general-purpose[\s\S]*?script-execution grant/i);
  });

  it("surfaces the python3 descendant-executable rationale in the operator troubleshooting doc", () => {
    const docUrl = new URL(
      "../../../../../../docs/troubleshooting/managed-java-language-provider.md",
      import.meta.url,
    );
    const doc = readFileSync(docUrl, "utf8");
    expect(doc).toMatch(/python3.+jdtls`? launcher/is);
    expect(doc).toMatch(/general-purpose[\s\S]*?script-execution grant/i);
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
      validateJavaVersion: () => true,
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
        validateJavaVersion: () => true,
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
      validateJavaVersion: () => true,
    });
    const second = prepareJavaSpawn(spawnInput(), {
      availability: NATIVE,
      platform: "linux",
      resolveExecutable: () => "/usr/bin/bwrap",
      resolveJava: () => "/opt/jdk-21/bin/java",
      validateLayout: () => true,
      validateJavaVersion: () => true,
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
        validateJavaVersion: () => true,
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
        validateJavaVersion: () => true,
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
        validateJavaVersion: () => true,
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
          validateJavaVersion: () => true,
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
        validateJavaVersion: () => true,
      }),
    ).toThrow();
    expect(statSync(settings).isDirectory()).toBe(true);
  });

  it("fails closed when no native egress boundary is available", () => {
    expect(() =>
      prepareJavaSpawn(spawnInput(), {
        availability: { ...NATIVE, bubblewrap: false },
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-21/bin/java",
        validateLayout: () => true,
        validateJavaVersion: () => true,
      }),
    ).toThrow();
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

  it("fails closed when the resolved JDK does not meet the minimum supported version", () => {
    expect(() =>
      prepareJavaSpawn(spawnInput(), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => "/opt/jdk-17/bin/java",
        validateLayout: () => true,
        validateJavaVersion: () => false,
      }),
    ).toThrow("minimum supported JDK version");
  });

  it("bounds the real java -version probe with a timeout instead of stalling indefinitely", () => {
    const hungJava = join(root, "java");
    writeFileSync(hungJava, "#!/bin/sh\nsleep 30\n", "utf8");
    chmodSync(hungJava, 0o755);
    const startedAt = Date.now();

    expect(() =>
      prepareJavaSpawn(spawnInput(), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => hungJava,
        validateLayout: () => true,
        // validateJavaVersion intentionally not overridden: exercises the real
        // defaultJavaVersionValid probe (and its bounded timeout) against a hung executable.
      }),
    ).toThrow("minimum supported JDK version");

    // The probe's own timeout is 5s; a generous 10s upper bound proves the process was killed
    // rather than left to run for the fixture's full 30s sleep.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("accepts a real java executable whose reported version meets the minimum", () => {
    const realJava = join(root, "java");
    writeFileSync(
      realJava,
      "#!/bin/sh\necho 'openjdk version \"21.0.1\" 2024-01-16' 1>&2\nexit 0\n",
      "utf8",
    );
    chmodSync(realJava, 0o755);

    expect(() =>
      prepareJavaSpawn(spawnInput(), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => realJava,
        validateLayout: () => true,
        // validateJavaVersion intentionally not overridden: exercises the real
        // defaultJavaVersionValid probe's success path parsing a real -version reply.
      }),
    ).not.toThrow();
  });
});

// Issue #3350 hardened the LSP server's OWN spawn (lspNodeAdapter.ts's buildLspSpawnPlan) but never
// covered this provider's separate, directly-issued `java -version` probe (defaultJavaVersionValid,
// via plain `spawnSync`): a Windows JDK managed through a version-manager shim (jenv/jabba/scoop-
// style wrappers commonly install `java.cmd` rather than a native `java.exe`) resolves to exactly
// the `.cmd`/`.bat` shape that raises EINVAL under `shell: false` (Node CVE-2024-27980). Tested
// against the pure builder directly — never against defaultJavaVersionValid, which always uses the
// real process.platform — so the win32 branch is reachable from a test on any host, mirroring
// lspNodeAdapter.test.ts's `buildLspSpawnPlan` coverage for the identical class of defect. Without
// this seam the cmd.exe wrapper call inside defaultJavaVersionValid could be deleted and every other
// Java provider test would stay green (they all inject `validateJavaVersion` or run on POSIX),
// silently reintroducing EINVAL for a shimmed Windows `java.cmd`.
describe("buildJavaVersionProbeInvocation", () => {
  it("routes a resolved java.cmd through the hardened cmd.exe wrapper on win32", () => {
    const invocation = buildJavaVersionProbeInvocation(String.raw`C:\jdk\bin\java.cmd`, {
      platform: "win32",
      env: { SystemRoot: String.raw`C:\Windows` },
    });

    expect(
      invocation.command.toLowerCase().endsWith(String.raw`\system32\cmd.exe`.toLowerCase()),
    ).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("java.cmd");
    expect(invocation.args[3]).toContain("-version");
    // The spread must survive at the call site: without it Node re-quotes the pre-escaped line and
    // the escaping cross-spawn built is lost.
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("passes a resolved java.exe through unchanged on win32", () => {
    const invocation = buildJavaVersionProbeInvocation(String.raw`C:\jdk\bin\java.exe`, {
      platform: "win32",
      env: { SystemRoot: String.raw`C:\Windows` },
    });

    expect(invocation.command).toBe(String.raw`C:\jdk\bin\java.exe`);
    expect(invocation.args).toEqual(["-version"]);
    expect(invocation.windowsVerbatimArguments).toBe(false);
  });

  it("leaves a POSIX java executable unwrapped", () => {
    const invocation = buildJavaVersionProbeInvocation("/opt/jdk-21/bin/java", {
      platform: "linux",
    });

    expect(invocation.command).toBe("/opt/jdk-21/bin/java");
    expect(invocation.args).toEqual(["-version"]);
    expect(invocation.windowsVerbatimArguments).toBe(false);
  });
});

// A PR reviewer finding shape (AGENTS.md §8 Rule 1): the win32 wrapper-engagement decision above
// must leave activity-log evidence, exactly like lspNodeAdapter.ts's own `lsp.spawn.completed`.
// defaultJavaVersionValid has no injected log port — it reaches processServerLogSink() directly —
// so this test installs a capturing ServerLogger via the process-wide test seam
// (setServerLogger/resetServerLogger) rather than a constructor-injected fake.
describe("defaultJavaVersionValid — activity-log evidence (AGENTS.md §8 Rule 1)", () => {
  function captureLog(): ServerLogEvent[] {
    const events: ServerLogEvent[] = [];
    setServerLogger(
      createServerLogger({ sink: { write: (event) => events.push(event) }, level: "debug" }),
    );
    return events;
  }

  it("logs lsp.java.version-probe.completed with the wrapper-engagement decision and outcome", () => {
    const events = captureLog();
    const realJava = join(root, "java");
    writeFileSync(
      realJava,
      "#!/bin/sh\necho 'openjdk version \"21.0.1\" 2024-01-16' 1>&2\nexit 0\n",
      "utf8",
    );
    chmodSync(realJava, 0o755);

    expect(() =>
      prepareJavaSpawn(spawnInput(), {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => realJava,
        validateLayout: () => true,
        // validateJavaVersion intentionally not overridden: exercises the real
        // defaultJavaVersionValid probe and its logging end to end.
      }),
    ).not.toThrow();

    const probed = events.find((event) => event.op === "lsp.java.version-probe.completed");
    expect(probed).toBeDefined();
    expect(probed?.category).toBe("diagnostic");
    expect(probed?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    const extra = probed?.extra ?? {};
    // This test host is never win32: the hardened cmd.exe wrapper never engages.
    expect(extra.windowsWrapperEngaged).toBe(false);
    expect(extra.validVersion).toBe(true);
    expect(extra.platform).toBe(process.platform);
    // Body-free: never the resolved java path or the probe's stdout/stderr on the evidence line.
    expect(Object.keys(extra).sort()).toEqual([
      "platform",
      "validVersion",
      "windowsWrapperEngaged",
    ]);
    // Through the REAL redactor: every evidence field here must survive redaction unchanged.
    const redacted = redactLogFields(extra) ?? {};
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(extra).sort());
  });
});
