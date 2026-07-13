import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import { runHostLanguageOperation, shutdownHostLspPool } from "../hostLanguageOperation.js";

const SUPPORTED_PYRIGHT_VERSION = "1.1.410";
const provisionedBinDir = process.env.KEIKO_TEST_PYRIGHT_BIN_DIR;
const langserver =
  provisionedBinDir === undefined ? "" : join(provisionedBinDir, "pyright-langserver");
const cli = provisionedBinDir === undefined ? "" : join(provisionedBinDir, "pyright");
const provisioned = existsSync(langserver) && existsSync(cli);
const suiteName = provisioned
  ? `real Pyright ${SUPPORTED_PYRIGHT_VERSION} offline smoke`
  : "real Pyright offline smoke (skipped: KEIKO_TEST_PYRIGHT_BIN_DIR is not provisioned)";

describe.skipIf(!provisioned)(suiteName, () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-real-pyright-"));
    writeFileSync(join(root, "helper.py"), "def value() -> int:\n    return 1\n", "utf8");
    writeFileSync(
      join(root, "main.py"),
      "from helper import value\n\nresult: int = value()\n",
      "utf8",
    );
  });

  afterAll(async () => {
    await shutdownHostLspPool();
    rmSync(root, { recursive: true, force: true });
  });

  it("pins the operator-provisioned version and passes core cross-file navigation", async () => {
    const version = execFileSync(cli, ["--version"], {
      encoding: "utf8",
      env: { PATH: `${provisionedBinDir ?? ""}${delimiter}${dirname(process.execPath)}` },
    });
    expect(version).toContain(SUPPORTED_PYRIGHT_VERSION);
    for (const request of smokeRequests(root)) {
      const outcome = await runHostLanguageOperation(request, {
        workspace: {
          root,
          name: undefined,
          version: undefined,
          testFramework: "unknown",
          sourceDirs: [],
          testDirs: [],
          languages: ["python"],
          ignoreLines: [],
        },
        processEnv: {
          PATH: `${provisionedBinDir ?? ""}${delimiter}${dirname(process.execPath)}`,
        },
        commandRules: [{ executable: "pyright-langserver" }],
        overlayAbsolutePath: join(root, "main.py"),
        signal: new AbortController().signal,
        activationAuthorized: true,
        protocolConfiguration: { revision: 1, settings: {}, initializationOptions: {} },
      });
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }
  }, 30_000);
});

function smokeRequests(root: string): readonly LanguageServiceRequest[] {
  const document = {
    path: "main.py",
    languageId: "python",
    text: "from helper import value\n\nresult: int = value()\n",
  };
  const position = { line: 2, character: 15 };
  return [
    { operation: "diagnostics", root, document },
    { operation: "completion", root, document, position },
    { operation: "hover", root, document, position },
    { operation: "symbols", root, document },
    { operation: "definition", root, document, position },
    { operation: "references", root, document, position },
  ];
}
