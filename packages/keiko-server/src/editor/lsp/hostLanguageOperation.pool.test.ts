// GEN-PERF-EDITOR-007 regression: the host LSP path must pool ONE warm process per
// (root, languageId) and serialize concurrent ops onto it, instead of spawning a fresh
// process per request and rejecting a concurrent second op with TIMED_OUT "busy".
//
// Proofs (mechanism, via the injected spawn seam):
//   1. Two SEQUENTIAL ops over the same root+language spawn the child exactly ONCE (pooled).
//   2. A CONCURRENT second op resolves (it queues on the warm process) rather than being
//      rejected as busy.
//   3. Distinct roots get distinct pooled processes (spawn twice).

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";
import { runHostLanguageOperation, shutdownHostLspPool } from "./hostLanguageOperation.js";

let binDir = "";
let workspaceRoot = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-host-lsp-pool-bin-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-host-lsp-pool-ws-"));
});

afterEach(async () => {
  // Release warm processes so pooled state never leaks across tests.
  await shutdownHostLspPool();
  rmSync(binDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function workspaceAt(root: string): WorkspaceInfo {
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

function makeExecutable(name: string): void {
  const path = join(binDir, name);
  writeFileSync(path, "#!/bin/sh\n", "utf8");
  chmodSync(path, 0o755);
}

function diagnosticsRequest(root: string): LanguageServiceRequest {
  return {
    operation: "diagnostics",
    root,
    document: { path: "main.go", languageId: "go", text: "package main\nfunc main() {}\n" },
  };
}

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
} as const;

const DIAGNOSTIC_RESULTS = {
  "textDocument/diagnostic": {
    kind: "full",
    items: [{ range, severity: 1, message: "missing import", source: "gopls", code: "E1" }],
  },
} as const;

function countingSpawn(): { spawn: LspSpawnFn; spawnCount: () => number } {
  let count = 0;
  const spawn: LspSpawnFn = () => {
    count += 1;
    return createFakeLspProcess({ results: DIAGNOSTIC_RESULTS }).handle;
  };
  return { spawn, spawnCount: (): number => count };
}

function runAt(root: string, spawn: LspSpawnFn): ReturnType<typeof runHostLanguageOperation> {
  const rules: readonly CommandRule[] = [{ executable: "gopls" }];
  return runHostLanguageOperation(diagnosticsRequest(root), {
    workspace: workspaceAt(root),
    processEnv: { PATH: binDir, KEIKO_EDITOR_LSP_GO: "1" },
    commandRules: rules,
    overlayAbsolutePath: join(root, "main.go"),
    signal: new AbortController().signal,
    spawn,
  });
}

describe("runHostLanguageOperation pooling (GEN-PERF-EDITOR-007)", () => {
  it("spawns the LSP process ONCE across two sequential ops on the same root+language", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount } = countingSpawn();

    const first = await runAt(workspaceRoot, spawn);
    const second = await runAt(workspaceRoot, spawn);

    expect(first).toMatchObject({ kind: "diagnostics" });
    expect(second).toMatchObject({ kind: "diagnostics" });
    // Pooled: the warm process from the first op served the second op — no re-spawn.
    expect(spawnCount()).toBe(1);
  });

  it("queues a concurrent second op onto the warm process instead of rejecting it busy", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount } = countingSpawn();

    // Launch both WITHOUT awaiting the first — the second must queue behind it on the shared
    // warm process. Pre-fix the global 1-slot gate returned TIMED_OUT "busy" for the second.
    const [first, second] = await Promise.all([
      runAt(workspaceRoot, spawn),
      runAt(workspaceRoot, spawn),
    ]);

    expect(first).toMatchObject({ kind: "diagnostics" });
    expect(second).toMatchObject({ kind: "diagnostics" });
    expect(first).not.toMatchObject({ kind: "error", code: "TIMED_OUT" });
    expect(second).not.toMatchObject({ kind: "error", code: "TIMED_OUT" });
    // Both ops shared a single pooled process.
    expect(spawnCount()).toBe(1);
  });

  it("pools independently per root (distinct roots spawn distinct processes)", async () => {
    makeExecutable("gopls");
    const otherRoot = mkdtempSync(join(tmpdir(), "keiko-host-lsp-pool-ws2-"));
    try {
      const { spawn, spawnCount } = countingSpawn();

      const a = await runAt(workspaceRoot, spawn);
      const b = await runAt(otherRoot, spawn);

      expect(a).toMatchObject({ kind: "diagnostics" });
      expect(b).toMatchObject({ kind: "diagnostics" });
      expect(spawnCount()).toBe(2);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
