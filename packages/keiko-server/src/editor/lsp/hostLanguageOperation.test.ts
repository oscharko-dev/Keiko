import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";
import { runHostLanguageOperation } from "./hostLanguageOperation.js";

let binDir = "";
let workspaceRoot = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-host-lsp-op-bin-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-host-lsp-op-ws-"));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function workspace(): WorkspaceInfo {
  return {
    root: workspaceRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function makeExecutable(name: string): void {
  const path = join(binDir, name);
  writeFileSync(path, "#!/bin/sh\n", "utf8");
  chmodSync(path, 0o755);
}

function baseDocument(languageId: string, path = "main.go"): LanguageServiceRequest["document"] {
  return {
    path,
    languageId,
    text: "package main\nfunc main() {}\n",
  };
}

function diagnosticsRequest(
  languageId: string,
): Extract<LanguageServiceRequest, { operation: "diagnostics" }> {
  return {
    operation: "diagnostics",
    root: workspaceRoot,
    document: baseDocument(languageId),
  };
}

function completionRequest(
  languageId: string,
): Extract<LanguageServiceRequest, { operation: "completion" }> {
  return {
    operation: "completion",
    root: workspaceRoot,
    document: baseDocument(languageId),
    position: { line: 0, character: 1 },
  };
}

function hoverRequest(languageId: string): Extract<LanguageServiceRequest, { operation: "hover" }> {
  return {
    operation: "hover",
    root: workspaceRoot,
    document: baseDocument(languageId),
    position: { line: 0, character: 1 },
  };
}

function symbolsRequest(
  languageId: string,
): Extract<LanguageServiceRequest, { operation: "symbols" }> {
  return {
    operation: "symbols",
    root: workspaceRoot,
    document: baseDocument(languageId),
  };
}

function formattingRequest(
  languageId: string,
): Extract<LanguageServiceRequest, { operation: "formatting" }> {
  return {
    operation: "formatting",
    root: workspaceRoot,
    document: baseDocument(languageId),
    options: { tabSize: 2, insertSpaces: true },
  };
}

function run(
  request: LanguageServiceRequest,
  rules: readonly CommandRule[],
  spawn: LspSpawnFn,
): ReturnType<typeof runHostLanguageOperation> {
  return runHostLanguageOperation(request, {
    workspace: workspace(),
    processEnv: {
      PATH: binDir,
      KEIKO_EDITOR_LSP_GO: "1",
      KEIKO_EDITOR_LSP_PYTHON: "1",
    },
    commandRules: rules,
    overlayAbsolutePath: join(workspaceRoot, request.document.path),
    signal: new AbortController().signal,
    spawn,
  });
}

function normalSpawn(results: Readonly<Record<string, unknown>>): LspSpawnFn {
  return () => createFakeLspProcess({ results }).handle;
}

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
} as const;

describe("runHostLanguageOperation", () => {
  it("maps a detected host provider through real LSP request methods", async () => {
    makeExecutable("gopls");
    const rules: readonly CommandRule[] = [{ executable: "gopls" }];
    const spawn = normalSpawn({
      "textDocument/diagnostic": {
        kind: "full",
        items: [{ range, severity: 1, message: "missing import", source: "gopls", code: "E1" }],
      },
      "textDocument/completion": {
        isIncomplete: false,
        items: [
          {
            label: "Println",
            kind: 3,
            detail: "func Println",
            documentation: { kind: "markdown", value: "writes output" },
            insertText: "fmt.Println()",
            sortText: "0001",
          },
        ],
      },
      "textDocument/hover": { contents: { kind: "markdown", value: "package main" }, range },
      "textDocument/documentSymbol": [{ name: "main", kind: 12, range, children: [] }],
      "textDocument/formatting": [{ range, newText: "package main\n" }],
    });

    await expect(run(diagnosticsRequest("go"), rules, spawn)).resolves.toMatchObject({
      kind: "diagnostics",
      result: { diagnostics: [{ severity: "error", message: "missing import", code: "E1" }] },
    });
    await expect(run(completionRequest("go"), rules, spawn)).resolves.toMatchObject({
      kind: "completion",
      result: { items: [{ label: "Println", kind: "function", insertText: "fmt.Println()" }] },
    });
    await expect(run(hoverRequest("go"), rules, spawn)).resolves.toMatchObject({
      kind: "hover",
      result: { contents: "package main" },
    });
    await expect(run(symbolsRequest("go"), rules, spawn)).resolves.toMatchObject({
      kind: "symbols",
      result: { symbols: [{ name: "main", kind: "function" }] },
    });
    await expect(run(formattingRequest("go"), rules, spawn)).resolves.toMatchObject({
      kind: "formatting",
      result: { edits: [{ newText: "package main\n" }] },
    });
  });

  it("returns undefined when the host tool is missing so the normal language service can handle fallback", async () => {
    const outcome = await run(completionRequest("go"), [{ executable: "gopls" }], normalSpawn({}));

    expect(outcome).toBeUndefined();
  });

  it("reports unsupported operations according to the provider's declared support", async () => {
    makeExecutable("pyright-langserver");
    const outcome = await run(
      {
        ...formattingRequest("python"),
        document: { path: "tool.py", languageId: "python", text: "x=1\n" },
      },
      [{ executable: "pyright-langserver" }],
      normalSpawn({}),
    );

    expect(outcome).toMatchObject({
      kind: "error",
      code: "UNSUPPORTED_OPERATION",
    });
  });
});
