import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import type { LspSpawnFn } from "../lspNodeAdapter.js";
import {
  disposeHostLspPoolEntry,
  runHostLanguageOperation,
  shutdownHostLspPool,
} from "../hostLanguageOperation.js";
import { createFakeLspProcess } from "../testing/fakeLspProcess.js";
import {
  providerConformanceCapabilities,
  providerConformanceRequests,
  providerConformanceResults,
} from "../testing/providerConformanceFixture.js";

let binDir = "";
let root = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-pyright-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-pyright-workspace-"));
  writeFileSync(join(binDir, "pyright-langserver"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(binDir, "pyright-langserver"), 0o755);
  writeFileSync(join(binDir, "gopls"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(binDir, "gopls"), 0o755);
  writeFileSync(join(root, "main.py"), "def value():\n    return 1\n", "utf8");
});

afterEach(async () => {
  await shutdownHostLspPool();
  rmSync(binDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function requests(): readonly LanguageServiceRequest[] {
  return providerConformanceRequests({
    root,
    path: "main.py",
    languageId: "python",
    text: readFileSync(join(root, "main.py"), "utf8"),
    includeFormatting: false,
  });
}

function fakeSpawn(): {
  readonly spawn: LspSpawnFn;
  readonly receivedMethods: () => readonly string[];
} {
  const controller = createFakeLspProcess({
    initializeResult: providerConformanceCapabilities(false),
    results: providerConformanceResults(join(root, "main.py"), false),
  });
  return {
    spawn: () => controller.handle,
    receivedMethods: (): readonly string[] => controller.receivedMethods(),
  };
}

describe("Pyright provider fake-protocol conformance", () => {
  it("serves every advertised operation and never writes review-only edits", async () => {
    const original = readFileSync(join(root, "main.py"), "utf8");
    const fake = fakeSpawn();
    for (const request of requests()) {
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
        processEnv: { PATH: binDir },
        commandRules: [{ executable: "pyright-langserver" }],
        overlayAbsolutePath: join(root, "main.py"),
        signal: new AbortController().signal,
        spawn: fake.spawn,
        activationAuthorized: true,
        protocolConfiguration: { revision: 1, settings: {}, initializationOptions: {} },
      });
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }
    expect(readFileSync(join(root, "main.py"), "utf8")).toBe(original);
    expect(fake.receivedMethods().filter((method) => method === "initialize")).toHaveLength(1);
    expect(
      fake.receivedMethods().filter((method) => method === "textDocument/didOpen"),
    ).toHaveLength(1);
    expect(
      fake.receivedMethods().filter((method) => method === "textDocument/didChange"),
    ).toHaveLength(requests().length - 1);
  });

  it("restarts only Python and preserves an unrelated warm provider", async () => {
    let spawnCount = 0;
    const spawn: LspSpawnFn = () => {
      spawnCount += 1;
      return createFakeLspProcess({
        initializeResult: {
          capabilities: { textDocumentSync: 2, diagnosticProvider: true },
        },
        results: { "textDocument/diagnostic": { kind: "full", items: [] } },
      }).handle;
    };
    const python = requests()[0];
    if (python === undefined) throw new Error("Python fixture is missing");
    const go: LanguageServiceRequest = {
      operation: "diagnostics",
      root,
      document: { path: "main.go", languageId: "go", text: "package main\n" },
    };
    const options = {
      workspace: {
        root,
        name: undefined,
        version: undefined,
        testFramework: "unknown" as const,
        sourceDirs: [],
        testDirs: [],
        languages: ["python", "go"] as const,
        ignoreLines: [],
      },
      processEnv: { PATH: binDir },
      commandRules: [{ executable: "pyright-langserver" }, { executable: "gopls" }],
      overlayAbsolutePath: join(root, "main.py"),
      signal: new AbortController().signal,
      spawn,
      activationAuthorized: true,
    };
    await runHostLanguageOperation(python, options);
    await runHostLanguageOperation(go, { ...options, overlayAbsolutePath: join(root, "main.go") });
    expect(spawnCount).toBe(2);
    await disposeHostLspPoolEntry(root, "python");
    await runHostLanguageOperation(go, { ...options, overlayAbsolutePath: join(root, "main.go") });
    expect(spawnCount).toBe(2);
    await runHostLanguageOperation(python, options);
    expect(spawnCount).toBe(3);
  });
});
