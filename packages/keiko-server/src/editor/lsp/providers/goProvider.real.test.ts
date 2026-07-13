import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import { runHostLanguageOperation, shutdownHostLspPool } from "../hostLanguageOperation.js";

const SUPPORTED_GOPLS_VERSION = "v0.21.1";
const SUPPORTED_GO_VERSION = "go1.26.5";
const provisionedBinDir = process.env.KEIKO_TEST_GOPLS_BIN_DIR;
const gopls = provisionedBinDir === undefined ? "" : join(provisionedBinDir, "gopls");
const go = provisionedBinDir === undefined ? "" : join(provisionedBinDir, "go");
const provisioned = existsSync(gopls) && existsSync(go);
const suiteName = provisioned
  ? `real gopls ${SUPPORTED_GOPLS_VERSION} with ${SUPPORTED_GO_VERSION} offline smoke`
  : "real gopls offline smoke (skipped: KEIKO_TEST_GOPLS_BIN_DIR is not provisioned)";

describe.skipIf(!provisioned)(suiteName, () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-real-gopls-"));
    writeFileSync(join(root, "go.mod"), "module example.test/main\ngo 1.26\n", "utf8");
    writeFileSync(join(root, "helper.go"), "package main\nfunc value() int { return 1 }\n", "utf8");
    writeFileSync(join(root, "main.go"), "package main\nvar result = value()\n", "utf8");
  });

  afterAll(async () => {
    await shutdownHostLspPool();
    rmSync(root, { recursive: true, force: true });
  });

  it("pins both binaries and passes core cross-file navigation without downloads", async () => {
    const env = { PATH: `${provisionedBinDir ?? ""}${delimiter}${dirname(process.execPath)}` };
    expect(execFileSync(gopls, ["version"], { encoding: "utf8", env })).toContain(
      SUPPORTED_GOPLS_VERSION,
    );
    expect(execFileSync(go, ["version"], { encoding: "utf8", env })).toContain(
      SUPPORTED_GO_VERSION,
    );
    for (const request of smokeRequests(root)) {
      const outcome = await runHostLanguageOperation(request, {
        workspace: {
          root,
          name: undefined,
          version: undefined,
          testFramework: "unknown",
          sourceDirs: [],
          testDirs: [],
          languages: ["go"],
          ignoreLines: [],
        },
        processEnv: env,
        commandRules: [{ executable: "gopls" }],
        overlayAbsolutePath: join(root, "main.go"),
        signal: new AbortController().signal,
        activationAuthorized: true,
        protocolConfiguration: {
          revision: 1,
          settings: { gopls: { env: { GOPROXY: "off", GOTOOLCHAIN: "local" } } },
          initializationOptions: { pullDiagnostics: true },
        },
      });
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }
  }, 30_000);
});

function smokeRequests(root: string): readonly LanguageServiceRequest[] {
  const document = {
    path: "main.go",
    languageId: "go",
    text: "package main\nvar result = value()\n",
  };
  const position = { line: 1, character: 15 };
  return [
    { operation: "diagnostics", root, document },
    { operation: "completion", root, document, position },
    { operation: "hover", root, document, position },
    { operation: "symbols", root, document },
    { operation: "formatting", root, document },
    { operation: "definition", root, document, position },
    { operation: "references", root, document, position },
  ];
}
