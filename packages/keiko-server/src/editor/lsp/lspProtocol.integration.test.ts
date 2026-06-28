// Issue #1381 (ADR-0069 D7) — optional real-subprocess protocol-fidelity test. Unlike the in-memory
// fake harness (the coverage backbone), this spawns an ACTUAL Node child running fake-lsp-server.mjs
// and drives a real `initialize` → request → `shutdown` cycle plus a crash, proving the in-house frame
// codec and JSON-RPC client interoperate with a genuine stdio LSP server. It uses the default node
// spawn adapter, so `node` must resolve on PATH outside the workspace (it does in CI and locally).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LspProcessConfig } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import { createLspProcessManager } from "./lspProcessManager.js";
import type { LspProcessManagerDeps } from "./lspProcessManager.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-lsp-server.mjs");
const RULES: readonly CommandRule[] = [{ executable: "node" }];

let WORKSPACE_ROOT = "";

beforeAll(() => {
  WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "keiko-proto-ws-"));
});
afterAll(() => {
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

function workspace(): WorkspaceInfo {
  return {
    root: WORKSPACE_ROOT,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function makeConfig(args: readonly string[]): LspProcessConfig {
  return {
    managerId: "mgr-proto",
    executableName: "node",
    executableArgs: args,
    initializeTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    maxFrameBytes: 1_048_576,
    restartWindowMs: 60_000,
    maxRestartsInWindow: 0,
    envAllowlist: ["PATH", "HOME", "USERPROFILE"],
    networkPolicy: "inherit",
  };
}

function makeDeps(args: readonly string[]): LspProcessManagerDeps {
  return {
    config: makeConfig(args),
    workspace: workspace(),
    processEnv: process.env,
    commandRules: RULES,
  };
}

async function waitForStatus(
  manager: { getLspProcessStatus(): string },
  target: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.getLspProcessStatus() === target) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

describe("LSP protocol fidelity against a real subprocess", () => {
  it("initializes, answers a request, and shuts down over real stdio", async () => {
    const manager = createLspProcessManager(makeDeps([FIXTURE, "--stdio"]));
    await waitForStatus(manager, "READY");
    expect(manager.getLspProcessStatus()).toBe("READY");

    const result = await manager.sendRequest<{ method?: string }>(
      "textDocument/hover",
      {},
      AbortSignal.timeout(5_000),
    );
    expect(result.method).toBe("textDocument/hover");

    await manager.dispose();
    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
  });

  it("detects a real child crash after initialize", async () => {
    const manager = createLspProcessManager(makeDeps([FIXTURE, "--stdio", "--crash"]));
    await waitForStatus(manager, "RESTART_THROTTLED");

    expect(["CRASHED", "RESTART_THROTTLED"]).toContain(manager.getLspProcessStatus());
    await manager.dispose();
  });
});
