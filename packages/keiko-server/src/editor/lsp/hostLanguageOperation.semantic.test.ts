import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

import type { LspSpawnFn } from "./lspNodeAdapter.js";
import {
  runHostLanguageSemanticTokens,
  shutdownHostLspPool,
  type HostLanguageOperationOptions,
} from "./hostLanguageOperation.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";

let bin = "";
let root = "";

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "keiko-semantic-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-semantic-root-"));
  for (const name of ["cargo", "rust-analyzer", "rustc", "rustfmt"]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  writeFileSync(join(root, "Cargo.toml"), "[package]\nname='safe'\nversion='0.1.0'\n");
  writeFileSync(join(root, "lib.rs"), "struct Value;\n");
});

afterEach(async () => {
  await shutdownHostLspPool();
  rmSync(bin, { recursive: true, force: true });
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
    languages: ["rust"],
    ignoreLines: [],
  };
}

function options(
  spawn: LspSpawnFn,
  signal = new AbortController().signal,
): HostLanguageOperationOptions {
  return {
    workspace: workspace(),
    processEnv: { PATH: bin },
    commandRules: ["cargo", "rust-analyzer", "rustc", "rustfmt"].map((executable) => ({
      executable,
    })),
    overlayAbsolutePath: join(root, "lib.rs"),
    signal,
    spawn,
    prepareSpawn: (input) => ({ ...input, executable: "/usr/bin/true" }),
    activationAuthorized: true,
    protocolConfiguration: { revision: 1, settings: {}, initializationOptions: {} },
  };
}

function fake(data: readonly number[]): ReturnType<typeof createFakeLspProcess> {
  return createFakeLspProcess({
    initializeResult: {
      capabilities: {
        textDocumentSync: 2,
        semanticTokensProvider: {
          full: true,
          legend: { tokenTypes: ["struct"], tokenModifiers: ["declaration"] },
        },
      },
    },
    results: { "textDocument/semanticTokens/full": { data } },
  });
}

describe("managed host semantic tokens", () => {
  it("returns bounded versioned Rust tokens only after live legend negotiation", async () => {
    const process = fake([0, 0, 6, 0, 1]);
    const result = await runHostLanguageSemanticTokens(
      { path: "lib.rs", languageId: "rust", text: "struct Value;\n", version: 11 },
      options(() => process.handle),
    );

    expect(result?.data).toMatchObject({ documentVersion: 11, returnedTokenCount: 1 });
    expect(result?.legend.tokenTypes).toContain("struct");
  });

  it("returns fallback for malformed token indices and cancellation", async () => {
    const malformed = fake([0, 0, 6, 8, 0]);
    const document = { path: "lib.rs", languageId: "rust", text: "struct Value;\n", version: 2 };
    expect(
      await runHostLanguageSemanticTokens(
        document,
        options(() => malformed.handle),
      ),
    ).toBeUndefined();
    await shutdownHostLspPool();
    const controller = new AbortController();
    controller.abort();
    expect(
      await runHostLanguageSemanticTokens(
        document,
        options(() => fake([]).handle, controller.signal),
      ),
    ).toBeUndefined();
  });
});
