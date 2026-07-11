import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LanguageServiceRequest, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

import { runHostLanguageOperation, shutdownHostLspPool } from "../hostLanguageOperation.js";

const SUPPORTED_BASH_LSP_VERSION = "5.6.0";
const SUPPORTED_SHELLCHECK_VERSION = "0.11.0";
const provisionedBinDir = process.env.KEIKO_TEST_BASH_LSP_BIN_DIR;
const bashLanguageServer = join(provisionedBinDir ?? "", "bash-language-server");
const shellcheck = join(provisionedBinDir ?? "", "shellcheck");
const node = join(provisionedBinDir ?? "", "node");
const provisioned =
  provisionedBinDir !== undefined &&
  existsSync(bashLanguageServer) &&
  existsSync(shellcheck) &&
  existsSync(node);
const suiteName = provisioned
  ? `real Bash Language Server ${SUPPORTED_BASH_LSP_VERSION} and ShellCheck ${SUPPORTED_SHELLCHECK_VERSION} smoke`
  : "real Bash Language Server smoke (skipped: KEIKO_TEST_BASH_LSP_BIN_DIR is not provisioned)";

describe.skipIf(!provisioned)(suiteName, () => {
  let root = "";
  const sentinelName = "analysis-executed";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-real-bash-lsp-"));
    writeFileSync(join(root, "main.sh"), realHostileText(sentinelName), "utf8");
  });

  afterAll(async () => {
    await shutdownHostLspPool();
    rmSync(root, { recursive: true, force: true });
  });

  it("pins operator binaries and performs read-only analysis without executing the document", async () => {
    const env = { PATH: provisionedBinDir ?? "" };
    expect(execFileSync(bashLanguageServer, ["--version"], { encoding: "utf8", env })).toContain(
      SUPPORTED_BASH_LSP_VERSION,
    );
    expect(execFileSync(shellcheck, ["--version"], { encoding: "utf8", env })).toContain(
      `version: ${SUPPORTED_SHELLCHECK_VERSION}`,
    );
    expect(execFileSync(node, ["--version"], { encoding: "utf8", env })).toMatch(/^v22\./u);

    for (const request of smokeRequests(root)) {
      const outcome = await runHostLanguageOperation(request, {
        workspace: workspace(root),
        processEnv: env,
        commandRules: [
          { executable: "bash-language-server" },
          { executable: "node" },
          { executable: "shellcheck" },
        ],
        overlayAbsolutePath: join(root, "main.sh"),
        signal: new AbortController().signal,
        activationAuthorized: true,
        protocolConfiguration: {
          revision: 1,
          settings: {
            bashIde: {
              backgroundAnalysisMaxFiles: 0,
              explainshellEndpoint: "",
              shellcheckArguments: ["--severity=warning"],
              shellcheckExternalSources: false,
              shellcheckPath: "shellcheck",
              shfmt: { path: "" },
            },
          },
          initializationOptions: {},
        },
      });
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }
    expect(existsSync(join(root, sentinelName))).toBe(false);
  }, 30_000);
});

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function realHostileText(sentinelName: string): string {
  return [
    "#!/usr/bin/env bash",
    `trap 'touch ${sentinelName}' EXIT`,
    `value="$(touch ${sentinelName})"`,
    "helper() { printf '%s\\n' \"$1\"; }",
    'helper "$value"',
  ].join("\n");
}

function smokeRequests(root: string): readonly LanguageServiceRequest[] {
  const document = {
    path: "main.sh",
    languageId: "shell",
    text: realHostileText("analysis-executed"),
  };
  const position = { line: 4, character: 3 };
  return [
    { operation: "diagnostics", root, document },
    { operation: "completion", root, document, position },
    { operation: "hover", root, document, position },
    { operation: "symbols", root, document },
    { operation: "definition", root, document, position },
    { operation: "references", root, document, position },
  ];
}
