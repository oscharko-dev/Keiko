import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";

import { runHostLanguageOperation, shutdownHostLspPool } from "../hostLanguageOperation.js";

const JDT_LS_VERSION = "1.60.0";
const provisionedDir = process.env.KEIKO_TEST_JDTLS_BIN_DIR;
const jdtls = provisionedDir === undefined ? "" : join(provisionedDir, "jdtls");
const java = provisionedDir === undefined ? "" : join(provisionedDir, "java");
const python = provisionedDir === undefined ? "" : join(provisionedDir, "python3");
const provisioned = existsSync(jdtls) && existsSync(java) && existsSync(python);
const suite = provisioned
  ? `real Eclipse JDT LS ${JDT_LS_VERSION} offline smoke`
  : "real Eclipse JDT LS offline smoke (skipped: KEIKO_TEST_JDTLS_BIN_DIR is not provisioned)";

describe.skipIf(!provisioned)(suite, () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-real-jdtls-"));
    writeFileSync(
      join(root, "Main.java"),
      "final class Main { static int value() { return 1; } }\n",
    );
  });

  afterAll(async () => {
    await shutdownHostLspPool();
    rmSync(root, { recursive: true, force: true });
  });

  it("uses JDK 21 or newer and serves standalone analysis without project import", async () => {
    const probe = spawnSync(java, ["-version"], { encoding: "utf8" });
    expect(probe.status).toBe(0);
    const version = `${probe.stdout}${probe.stderr}`;
    expect(javaMajorVersion(version)).toBeGreaterThanOrEqual(21);
    const env = { PATH: `${provisionedDir ?? ""}${delimiter}${process.env.PATH ?? ""}` };
    for (const request of smokeRequests(root)) {
      const outcome = await runHostLanguageOperation(request, {
        workspace: {
          root,
          name: undefined,
          version: undefined,
          testFramework: "unknown",
          sourceDirs: [],
          testDirs: [],
          languages: ["java"],
          ignoreLines: [],
        },
        processEnv: env,
        commandRules: [{ executable: "jdtls" }, { executable: "java" }, { executable: "python3" }],
        overlayAbsolutePath: join(root, "Main.java"),
        signal: new AbortController().signal,
        activationAuthorized: true,
        protocolConfiguration: { revision: 1, settings: {}, initializationOptions: {} },
      });
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }
  }, 45_000);
});

function javaMajorVersion(output: string): number {
  const match = /version "(?<major>\d+)/u.exec(output);
  return Number(match?.groups?.major ?? 0);
}

function smokeRequests(root: string): readonly LanguageServiceRequest[] {
  const document = {
    path: "Main.java",
    languageId: "java",
    text: "final class Main { static int value() { return 1; } }\n",
  };
  const position = { line: 0, character: 31 };
  return [
    { operation: "diagnostics", root, document },
    { operation: "completion", root, document, position },
    { operation: "hover", root, document, position },
    { operation: "symbols", root, document },
  ];
}
