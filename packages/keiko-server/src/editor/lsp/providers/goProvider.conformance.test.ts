import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LspSpawnFn } from "../lspNodeAdapter.js";
import {
  notifyHostLspWorkspaceFileChanged,
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
  binDir = mkdtempSync(join(tmpdir(), "keiko-gopls-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-gopls-workspace-"));
  writeFileSync(join(binDir, "gopls"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(binDir, "gopls"), 0o755);
  writeFileSync(join(root, "main.go"), "package main\nfunc value() int { return 1 }\n", "utf8");
  writeFileSync(join(root, "go.mod"), "module example.test/main\ngo 1.26\n", "utf8");
  writeFileSync(join(root, "go.work"), "go 1.26\nuse .\n", "utf8");
});

afterEach(async () => {
  await shutdownHostLspPool();
  rmSync(binDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("gopls provider fake-protocol conformance", () => {
  it("serves every negotiated operation under forced offline environment", async () => {
    const original = readFileSync(join(root, "main.go"), "utf8");
    const configurationMessages: unknown[] = [];
    const controller = createFakeLspProcess({
      initializeResult: providerConformanceCapabilities(true),
      results: providerConformanceResults(join(root, "main.go"), true),
      onMessage: (method, params): void => {
        if (method === "workspace/didChangeConfiguration") configurationMessages.push(params);
      },
    });
    let childEnvironment: Readonly<Record<string, string>> | undefined;
    const spawn: LspSpawnFn = (_executable, _args, env) => {
      childEnvironment = env;
      return controller.handle;
    };
    const requests = providerConformanceRequests({
      root,
      path: "main.go",
      languageId: "go",
      text: original,
      includeFormatting: true,
    });
    for (const request of requests) {
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
        processEnv: {
          PATH: binDir,
          GOPROXY: "https://network.invalid",
          GOTOOLCHAIN: "auto",
          GOPATH: "/ambient/secret",
          GOMODCACHE: "/ambient/cache",
        },
        commandRules: [{ executable: "gopls" }],
        overlayAbsolutePath: join(root, "main.go"),
        signal: new AbortController().signal,
        spawn,
        activationAuthorized: true,
        protocolConfiguration: {
          revision: 4,
          initializationOptions: { pullDiagnostics: true },
          settings: { gopls: { staticcheck: true } },
        },
      });
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }
    expect(childEnvironment).toMatchObject({
      GOPROXY: "off",
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
      GOVCS: "off",
      GOENV: "off",
    });
    expect(childEnvironment).not.toHaveProperty("GOPATH");
    expect(childEnvironment).not.toHaveProperty("GOMODCACHE");
    expect(readFileSync(join(root, "main.go"), "utf8")).toBe(original);
    notifyHostLspWorkspaceFileChanged(root, join(root, "main.go"));
    expect(
      controller
        .receivedMethods()
        .filter((method) => method === "workspace/didChangeConfiguration"),
    ).toHaveLength(1);
    expect(controller.receivedMethods().filter((method) => method === "initialize")).toHaveLength(
      1,
    );
    expect(configurationMessages).toEqual([{ settings: { gopls: { staticcheck: true } } }]);
    await expect
      .poll(
        () =>
          controller
            .receivedMethods()
            .filter((method) => method === "workspace/didChangeWatchedFiles").length,
      )
      .toBe(1);
  });
});
