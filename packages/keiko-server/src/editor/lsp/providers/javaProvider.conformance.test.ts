import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LanguageServiceRequest, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

import type { LspSpawnFn } from "../lspNodeAdapter.js";
import {
  runHostLanguageOperation,
  shutdownHostLspPool,
  type HostLanguageOperationOptions,
} from "../hostLanguageOperation.js";
import { createFakeLspProcess } from "../testing/fakeLspProcess.js";
import {
  providerConformanceCapabilities,
  providerConformanceRequests,
  providerConformanceResults,
} from "../testing/providerConformanceFixture.js";
import { JAVA_PROVIDER_SPEC } from "./javaProvider.js";

const SENTINEL = "KEIKO_JAVA_IMPORT_MUST_NOT_EXECUTE";
let binDir = "";
let root = "";

function executable(name: string): void {
  const path = join(binDir, name);
  writeFileSync(path, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-java-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-java-workspace-"));
  for (const name of ["java", "jdtls", "python3", "mvn", "gradle", "gradlew"]) executable(name);
  writeFileSync(join(root, "Main.java"), "final class Main { static int value() { return 1; } }\n");
});

afterEach(async () => {
  await shutdownHostLspPool();
  rmSync(binDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

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

function requests(): readonly LanguageServiceRequest[] {
  return providerConformanceRequests({
    root,
    path: "Main.java",
    languageId: "java",
    text: readFileSync(join(root, "Main.java"), "utf8"),
    includeFormatting: true,
  }).filter((request) => JAVA_PROVIDER_SPEC.operations.includes(request.operation));
}

function options(spawn: LspSpawnFn): HostLanguageOperationOptions {
  return {
    workspace: workspace(),
    processEnv: { PATH: binDir, HOME: root, JAVA_HOME: root, MAVEN_OPTS: SENTINEL },
    commandRules: [{ executable: "jdtls" }, { executable: "java" }, { executable: "python3" }],
    overlayAbsolutePath: join(root, "Main.java"),
    signal: new AbortController().signal,
    spawn,
    prepareSpawn: (input) => ({ ...input, executable: "/usr/bin/true" }),
    activationAuthorized: true,
    protocolConfiguration: { revision: 1, settings: {}, initializationOptions: {} },
  };
}

describe("Eclipse JDT LS fake-protocol security conformance", () => {
  it("serves every negotiated operation without granting execution or applying edits", async () => {
    const original = readFileSync(join(root, "Main.java"), "utf8");
    const fake = createFakeLspProcess({
      initializeResult: providerConformanceCapabilities(true),
      results: providerConformanceResults(join(root, "Main.java"), true),
    });
    let childEnv: Readonly<Record<string, string>> = {};
    const spawn: LspSpawnFn = (_executable, _args, env) => {
      childEnv = env;
      return fake.handle;
    };

    for (const request of requests()) {
      const outcome = await runHostLanguageOperation(request, options(spawn));
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }

    expect(readFileSync(join(root, "Main.java"), "utf8")).toBe(original);
    expect(existsSync(join(root, SENTINEL))).toBe(false);
    expect(childEnv).not.toHaveProperty("HOME");
    expect(childEnv).not.toHaveProperty("JAVA_HOME");
    expect(childEnv).not.toHaveProperty("MAVEN_OPTS");
    expect(childEnv.PATH === undefined ? [] : readFileNames(childEnv.PATH)).toEqual([
      "java",
      "python3",
    ]);
    expect(fake.receivedMethods()).not.toContain("workspace/executeCommand");
  });
});

function readFileNames(path: string): readonly string[] {
  return ["java", "python3"].filter((name) => existsSync(join(path, name)));
}
