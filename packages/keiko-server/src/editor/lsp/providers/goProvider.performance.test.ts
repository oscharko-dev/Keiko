// #2275 audit finding (low, epic-wide): the Go/gopls provider had no dedicated performance-evidence
// coverage for workspace load, warm-operation reuse, diagnostics delay, resource hygiene, large-file
// handling, and disposal — those dimensions were only exercised indirectly via shared LSP-infra tests
// (lspProcessManager.test.ts, managedLspControl.test.ts) that never spawn through the Go provider spec.
// This is a hermetic, in-process measurement (no real gopls, no network): it proves the mechanism —
// one warm pooled process reused across ops, bounded latency, no leaked in-flight requests, a large
// document served without hanging or respawning, and a graceful shutdown/exit sequence on disposal —
// rather than asserting tight wall-clock budgets, which would flake under CI load for no product
// reason. Browser-measured wall-clock budgets (cold start, memory growth) are the release-evidence
// harness's job (tests/e2e/editor-performance.spec.ts); that harness is generic across languages.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LspSpawnFn } from "../lspNodeAdapter.js";
import { createFakeLspProcess } from "../testing/fakeLspProcess.js";
import {
  providerConformanceCapabilities,
  providerConformanceResults,
} from "../testing/providerConformanceFixture.js";
import {
  listHostLspHealthSnapshotsForRoot,
  runHostLanguageOperation,
  shutdownHostLspPool,
} from "../hostLanguageOperation.js";

let binDir = "";
let root = "";
let mainGoPath = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-gopls-perf-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-gopls-perf-ws-"));
  mainGoPath = join(root, "main.go");
  writeFileSync(join(binDir, "gopls"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(binDir, "gopls"), 0o755);
  writeFileSync(mainGoPath, "package main\nfunc value() int { return 1 }\n", "utf8");
  writeFileSync(join(root, "go.mod"), "module example.test/main\ngo 1.26\n", "utf8");
});

afterEach(async () => {
  await shutdownHostLspPool();
  rmSync(binDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function workspaceInfo(): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: ["go"],
    ignoreLines: [],
  };
}

function diagnosticsRequest(text: string): LanguageServiceRequest {
  return {
    operation: "diagnostics",
    root,
    document: { path: "main.go", languageId: "go", text },
  };
}

function hoverRequest(text: string): LanguageServiceRequest {
  return {
    operation: "hover",
    root,
    document: { path: "main.go", languageId: "go", text },
    position: { line: 1, character: 5 },
  };
}

function countingSpawn(): {
  spawn: LspSpawnFn;
  spawnCount: () => number;
  controllers: () => readonly ReturnType<typeof createFakeLspProcess>[];
} {
  let count = 0;
  const controllers: ReturnType<typeof createFakeLspProcess>[] = [];
  const spawn: LspSpawnFn = () => {
    count += 1;
    const controller = createFakeLspProcess({
      initializeResult: providerConformanceCapabilities(true),
      results: providerConformanceResults(mainGoPath, true),
    });
    controllers.push(controller);
    return controller.handle;
  };
  return {
    spawn,
    spawnCount: (): number => count,
    controllers: (): readonly ReturnType<typeof createFakeLspProcess>[] => controllers,
  };
}

function runOp(
  request: LanguageServiceRequest,
  spawn: LspSpawnFn,
): ReturnType<typeof runHostLanguageOperation> {
  const rules: readonly CommandRule[] = [{ executable: "gopls" }];
  return runHostLanguageOperation(request, {
    workspace: workspaceInfo(),
    processEnv: { PATH: binDir },
    commandRules: rules,
    overlayAbsolutePath: mainGoPath,
    signal: new AbortController().signal,
    spawn,
    activationAuthorized: true,
  });
}

function largeGoSource(functionCount: number): string {
  const lines = ["package main", ""];
  for (let index = 0; index < functionCount; index += 1) {
    lines.push(`func generatedFn${String(index)}() int { return ${String(index)} }`);
  }
  return `${lines.join("\n")}\n`;
}

describe("gopls provider performance evidence (#2275)", () => {
  it("workspace load: the first Go operation spawns gopls exactly once and completes", async () => {
    const { spawn, spawnCount } = countingSpawn();
    const startedAtMs = performance.now();

    const outcome = await runOp(diagnosticsRequest("package main\n"), spawn);

    const elapsedMs = performance.now() - startedAtMs;
    expect(outcome).toMatchObject({ kind: "diagnostics" });
    expect(spawnCount()).toBe(1);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("warm operations: repeated ops reuse the pooled process without leaking in-flight requests", async () => {
    const { spawn, spawnCount } = countingSpawn();
    const text = "package main\nfunc value() int { return 1 }\n";

    await runOp(diagnosticsRequest(text), spawn);
    await runOp(hoverRequest(text), spawn);
    await runOp(diagnosticsRequest(text), spawn);

    expect(spawnCount()).toBe(1);
    const [snapshot] = listHostLspHealthSnapshotsForRoot(root);
    expect(snapshot?.requestCount).toBe(3);
    expect(snapshot?.successCount).toBe(3);
    expect(snapshot?.pendingRequestCount).toBe(0);
  });

  it("diagnostics delay: the health-snapshot latency histogram records bounded warm latency", async () => {
    const { spawn } = countingSpawn();
    const text = "package main\nfunc value() int { return 1 }\n";
    await runOp(diagnosticsRequest(text), spawn);

    await runOp(diagnosticsRequest(text), spawn);

    const [snapshot] = listHostLspHealthSnapshotsForRoot(root);
    expect(snapshot?.latency.count).toBe(2);
    expect(snapshot?.latency.maximumMs).toBeLessThan(5_000);
    expect(snapshot?.latency.greaterThan1Second).toBe(0);
  });

  it("large-file degradation: a large Go source document completes on the warm process without respawning", async () => {
    const { spawn, spawnCount } = countingSpawn();
    await runOp(diagnosticsRequest("package main\n"), spawn);
    const large = largeGoSource(20_000);
    expect(Buffer.byteLength(large, "utf8")).toBeGreaterThan(500_000);

    const outcome = await runOp(diagnosticsRequest(large), spawn);

    expect(outcome).toMatchObject({ kind: "diagnostics" });
    expect(outcome).not.toMatchObject({ kind: "error" });
    expect(spawnCount()).toBe(1);
  });

  it("disposal: shutdown gracefully sequences shutdown/exit and a later op spawns a fresh process", async () => {
    const { spawn, spawnCount, controllers } = countingSpawn();
    await runOp(diagnosticsRequest("package main\n"), spawn);
    const [firstController] = controllers();

    await shutdownHostLspPool();

    expect(firstController?.receivedMethods()).toContain("shutdown");
    expect(firstController?.receivedMethods()).toContain("exit");
    expect(firstController?.exitEmitted()).toBe(true);
    // A well-behaved gopls exits on the "exit" notification before the grace-period SIGKILL
    // escalation fires: dispose() unconditionally sends SIGTERM as belt-and-suspenders, but must
    // never need to escalate to SIGKILL here (that path is reserved for unresponsive servers).
    expect(firstController?.killed()).not.toContain("SIGKILL");
    expect(listHostLspHealthSnapshotsForRoot(root)).toHaveLength(0);

    await runOp(diagnosticsRequest("package main\n"), spawn);
    expect(spawnCount()).toBe(2);
  });
});
