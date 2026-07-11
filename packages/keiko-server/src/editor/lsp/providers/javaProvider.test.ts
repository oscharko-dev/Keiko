import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ManagedLspJavaConfiguration, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";

import { JAVA_PROVIDER_SPEC, javaProtocolConfiguration, prepareJavaSpawn } from "./javaProvider.js";

const NATIVE: BackendAvailability = {
  bubblewrap: true,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-java-provider-"));
  writeFileSync(join(root, "Main.java"), "final class Main {}\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
    const prepared = prepareJavaSpawn(
      {
        executable: "/opt/jdtls/bin/jdtls",
        args: [],
        env: { PATH: root },
        workspace: workspace(),
        processEnv: { PATH: "/usr/bin" },
      },
      {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
        resolveJava: () => javaPath,
        validateLayout: () => true,
      },
    );
    const configurationIndex = prepared.args.indexOf("-configuration");
    const dataIndex = prepared.args.indexOf("-data");
    const configurationPath = prepared.args[configurationIndex + 1] ?? "";
    const dataPath = prepared.args[dataIndex + 1] ?? "";

    expect(prepared.executable).toBe("/usr/bin/bwrap");
    expect(prepared.args).toContain("--unshare-net");
    expect(prepared.args).toContain("--validate-java-version");
    expect(prepared.args).toContain(`--java-executable=${javaPath}`);
    expect(statSync(configurationPath).mode & 0o777).toBe(0o700);
    expect(statSync(dataPath).mode & 0o777).toBe(0o700);
    expect(prepared.resourceBudgetSatisfied?.()).toBe(true);
    prepared.cleanup?.();
    expect(existsSync(configurationPath)).toBe(false);
  });

  it.each(["pom.xml", "build.gradle.kts", ".project", ".factorypath"])(
    "fails before spawn when %s exposes an execution-requiring project importer",
    (entry) => {
      const path = join(root, entry);
      writeFileSync(path, "hostile", "utf8");
      expect(() =>
        prepareJavaSpawn(
          {
            executable: "/opt/jdtls/bin/jdtls",
            args: [],
            env: { PATH: root },
            workspace: workspace(),
            processEnv: {},
          },
          {
            availability: NATIVE,
            platform: "linux",
            resolveExecutable: () => "/usr/bin/bwrap",
            resolveJava: () => "/opt/jdk-21/bin/java",
            validateLayout: () => true,
          },
        ),
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe("hostile");
    },
  );

  it("rejects Eclipse settings directories without treating them as files", () => {
    const settings = join(root, ".settings");
    mkdirSync(settings);
    expect(() =>
      prepareJavaSpawn(
        {
          executable: "/opt/jdtls/bin/jdtls",
          args: [],
          env: { PATH: root },
          workspace: workspace(),
          processEnv: {},
        },
        {
          availability: NATIVE,
          platform: "linux",
          resolveExecutable: () => "/usr/bin/bwrap",
          resolveJava: () => "/opt/jdk-21/bin/java",
          validateLayout: () => true,
        },
      ),
    ).toThrow();
    expect(statSync(settings).isDirectory()).toBe(true);
  });

  it("fails closed when no native egress boundary is available", () => {
    expect(() =>
      prepareJavaSpawn(
        {
          executable: "/opt/jdtls/bin/jdtls",
          args: [],
          env: { PATH: root },
          workspace: workspace(),
          processEnv: {},
        },
        {
          availability: { ...NATIVE, bubblewrap: false },
          platform: "linux",
          resolveExecutable: () => "/usr/bin/bwrap",
          resolveJava: () => "/opt/jdk-21/bin/java",
          validateLayout: () => true,
        },
      ),
    ).toThrow();
  });

  it("fails closed when the provisioned JDT LS layout is not the pinned release", () => {
    expect(() =>
      prepareJavaSpawn(
        {
          executable: "/opt/unreviewed/bin/jdtls",
          args: [],
          env: { PATH: root },
          workspace: workspace(),
          processEnv: {},
        },
        {
          availability: NATIVE,
          platform: "linux",
          resolveExecutable: () => "/usr/bin/bwrap",
          resolveJava: () => "/opt/jdk-21/bin/java",
          validateLayout: () => false,
        },
      ),
    ).toThrow("supported distribution");
  });
});
