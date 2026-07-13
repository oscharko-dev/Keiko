// #2277 audit finding (medium): the Shell/Bash Language Server provider had no dedicated
// performance-evidence coverage for workspace load, warm-operation reuse, diagnostics delay,
// large-file handling, and disposal, despite the issue's Expected Verification explicitly
// requiring it. Mirrors goProvider.performance.test.ts (added for #2275). This is a hermetic,
// in-process measurement (no real bash-language-server, no network): it proves the mechanism —
// one warm pooled process reused across ops, bounded latency, a large document served without
// hanging or respawning, and a graceful shutdown/exit sequence on disposal — rather than
// asserting tight wall-clock budgets, which would flake under CI load for no product reason.
// Browser-measured wall-clock budgets (cold start, memory growth) are the release-evidence
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
let scriptPath = "";

function writeExecutable(directory: string, name: string): void {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-shell-perf-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-shell-perf-ws-"));
  scriptPath = join(root, "script.sh");
  for (const name of ["bash-language-server", "node", "shellcheck"]) {
    writeExecutable(binDir, name);
  }
  writeFileSync(scriptPath, "#!/usr/bin/env bash\nvalue() { echo 1; }\n", "utf8");
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
    languages: [],
    ignoreLines: [],
  };
}

function diagnosticsRequest(text: string): LanguageServiceRequest {
  return {
    operation: "diagnostics",
    root,
    document: { path: "script.sh", languageId: "shell", text },
  };
}

function hoverRequest(text: string): LanguageServiceRequest {
  return {
    operation: "hover",
    root,
    document: { path: "script.sh", languageId: "shell", text },
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
      initializeResult: providerConformanceCapabilities(false),
      results: providerConformanceResults(scriptPath, false),
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
  const rules: readonly CommandRule[] = [
    { executable: "bash-language-server" },
    { executable: "node" },
    { executable: "shellcheck" },
  ];
  return runHostLanguageOperation(request, {
    workspace: workspaceInfo(),
    processEnv: { PATH: binDir },
    commandRules: rules,
    overlayAbsolutePath: scriptPath,
    signal: new AbortController().signal,
    spawn,
    activationAuthorized: true,
  });
}

function largeShellSource(functionCount: number): string {
  const lines = ["#!/usr/bin/env bash", ""];
  for (let index = 0; index < functionCount; index += 1) {
    lines.push(`generated_fn_${String(index)}() { echo ${String(index)}; }`);
  }
  return `${lines.join("\n")}\n`;
}

describe("Bash Language Server provider performance evidence (#2277)", () => {
  it("workspace load: the first Shell operation spawns bash-language-server exactly once and completes", async () => {
    const { spawn, spawnCount } = countingSpawn();
    const startedAtMs = performance.now();

    const outcome = await runOp(diagnosticsRequest("#!/usr/bin/env bash\n"), spawn);

    const elapsedMs = performance.now() - startedAtMs;
    expect(outcome).toMatchObject({ kind: "diagnostics" });
    expect(spawnCount()).toBe(1);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("warm operations: repeated ops reuse the pooled process without leaking in-flight requests", async () => {
    const { spawn, spawnCount } = countingSpawn();
    const text = "#!/usr/bin/env bash\nvalue() { echo 1; }\n";

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
    const text = "#!/usr/bin/env bash\nvalue() { echo 1; }\n";
    await runOp(diagnosticsRequest(text), spawn);

    await runOp(diagnosticsRequest(text), spawn);

    const [snapshot] = listHostLspHealthSnapshotsForRoot(root);
    expect(snapshot?.latency.count).toBe(2);
    expect(snapshot?.latency.maximumMs).toBeLessThan(5_000);
    expect(snapshot?.latency.greaterThan1Second).toBe(0);
  });

  it("large-file degradation: a large shell script completes on the warm process without respawning", async () => {
    const { spawn, spawnCount } = countingSpawn();
    await runOp(diagnosticsRequest("#!/usr/bin/env bash\n"), spawn);
    const large = largeShellSource(20_000);
    expect(Buffer.byteLength(large, "utf8")).toBeGreaterThan(500_000);

    const outcome = await runOp(diagnosticsRequest(large), spawn);

    expect(outcome).toMatchObject({ kind: "diagnostics" });
    expect(outcome).not.toMatchObject({ kind: "error" });
    expect(spawnCount()).toBe(1);
  });

  it("disposal: shutdown gracefully sequences shutdown/exit and a later op spawns a fresh process", async () => {
    const { spawn, spawnCount, controllers } = countingSpawn();
    await runOp(diagnosticsRequest("#!/usr/bin/env bash\n"), spawn);
    const [firstController] = controllers();

    await shutdownHostLspPool();

    expect(firstController?.receivedMethods()).toContain("shutdown");
    expect(firstController?.receivedMethods()).toContain("exit");
    expect(firstController?.exitEmitted()).toBe(true);
    // A well-behaved bash-language-server exits on the "exit" notification before the
    // grace-period SIGKILL escalation fires: dispose() unconditionally sends SIGTERM as
    // belt-and-suspenders, but must never need to escalate to SIGKILL here (that path is
    // reserved for unresponsive servers).
    expect(firstController?.killed()).not.toContain("SIGKILL");
    expect(listHostLspHealthSnapshotsForRoot(root)).toHaveLength(0);

    await runOp(diagnosticsRequest("#!/usr/bin/env bash\n"), spawn);
    expect(spawnCount()).toBe(2);
  });
});
