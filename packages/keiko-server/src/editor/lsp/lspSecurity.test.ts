// Issue #1381 AC3 (ADR-0069 D6/I3/I4) — the content-free proof. A 32+ character unique sentinel is
// injected into BOTH the fake server's response payloads AND its child stderr; we then drive a real
// manager through its full lifecycle and assert the sentinel never appears in any lifecycle event, in
// the status route body, or in any `onLifecycleEvent` payload. Separately we prove the stderr drain
// COUNTS bytes (the count advances) without storing them, and that a symlink whose real target lies
// inside the workspace is rejected at the spawn-containment boundary (I2: EXECUTABLE_NOT_FOUND).

import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LspLifecycleEvent, LspProcessConfig } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import { createLspProcessManager } from "./lspProcessManager.js";
import type { LspProcessManagerDeps } from "./lspProcessManager.js";
import { LspProcessError, resolveExecutableOutsideWorkspace } from "./lspNodeAdapter.js";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";
import type { FakeLspController } from "./testing/fakeLspProcess.js";
import {
  _resetLspLifecycleLedgerForTests,
  listLspLifecycleEvents,
  recordLspLifecycleEvent,
} from "./lspLifecycleLedger.js";
import { handleEditorLspStatus } from "./lspStatusRoute.js";

const SENTINEL = "SENTINEL-0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d";

let BIN_DIR = "";
let WORKSPACE_ROOT = "";

beforeAll(() => {
  BIN_DIR = mkdtempSync(join(tmpdir(), "keiko-sec-bin-"));
  WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "keiko-sec-ws-"));
  const exe = join(BIN_DIR, "fakelsp");
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
});

afterAll(() => {
  rmSync(BIN_DIR, { recursive: true, force: true });
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  _resetLspLifecycleLedgerForTests();
});
afterEach(() => {
  _resetLspLifecycleLedgerForTests();
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

const RULES: readonly CommandRule[] = [{ executable: "fakelsp" }];

function makeConfig(): LspProcessConfig {
  return {
    managerId: "mgr-sec",
    executableName: "fakelsp",
    executableArgs: ["--stdio"],
    initializeTimeoutMs: 200,
    requestTimeoutMs: 200,
    shutdownTimeoutMs: 50,
    maxFrameBytes: 1_048_576,
    restartWindowMs: 60_000,
    maxRestartsInWindow: 2,
    envAllowlist: ["PATH"],
    networkPolicy: "inherit",
  };
}

async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function sentinelSpawn(controllers: FakeLspController[]): LspSpawnFn {
  return () => {
    const controller = createFakeLspProcess({ behavior: "normal", sentinel: SENTINEL });
    controllers.push(controller);
    return controller.handle;
  };
}

function makeDeps(
  spawn: LspSpawnFn,
  onLifecycleEvent: (event: LspLifecycleEvent) => void,
): LspProcessManagerDeps {
  return {
    config: makeConfig(),
    workspace: workspace(),
    processEnv: { PATH: BIN_DIR },
    commandRules: RULES,
    spawn,
    now: () => 1_000,
    onLifecycleEvent,
  };
}

describe("LSP manager content-free invariant (AC3)", () => {
  it("never leaks a response/stderr sentinel into any lifecycle, ledger, or route sink", async () => {
    const controllers: FakeLspController[] = [];
    const emitted: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(sentinelSpawn(controllers), (event) => {
        emitted.push(event);
        recordLspLifecycleEvent(event);
      }),
    );
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    const result = await manager.sendRequest<{ note?: string }>(
      "textDocument/hover",
      {},
      AbortSignal.timeout(1_000),
    );
    // The fake echoes the sentinel back in its result body, proving content actually crossed the wire.
    expect(JSON.stringify(result)).toContain(SENTINEL);

    await manager.dispose();
    await settle();

    expect(JSON.stringify(emitted)).not.toContain(SENTINEL);
    expect(JSON.stringify(listLspLifecycleEvents())).not.toContain(SENTINEL);
    const routeBody = handleEditorLspStatus(undefined, {
      env: { KEIKO_EDITOR_LSP_STATUS: "1" },
    }).body;
    expect(JSON.stringify(routeBody)).not.toContain(SENTINEL);
  });

  it("counts stderr bytes without storing them (stderrBytesSeen advances)", async () => {
    const controllers: FakeLspController[] = [];
    const emitted: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(sentinelSpawn(controllers), (event) => emitted.push(event)),
    );
    await settle();
    const controller = controllers[0];
    if (controller === undefined) throw new Error("expected a spawned fake");
    controller.emitStderr(SENTINEL);
    await settle();

    await manager.dispose();
    await settle();

    const maxStderr = Math.max(...emitted.map((event) => event.stderrBytesSeen));
    expect(maxStderr).toBeGreaterThanOrEqual(Buffer.byteLength(SENTINEL, "utf8"));
    expect(JSON.stringify(emitted)).not.toContain(SENTINEL);
  });

  it("rejects an executable whose symlink resolves inside the workspace (I2)", () => {
    const realTarget = join(WORKSPACE_ROOT, "inside");
    writeFileSync(realTarget, "#!/bin/sh\n");
    chmodSync(realTarget, 0o755);
    const pathDir = mkdtempSync(join(tmpdir(), "keiko-sec-link-"));
    symlinkSync(realTarget, join(pathDir, "fakelsp"));

    try {
      expect(() =>
        resolveExecutableOutsideWorkspace("fakelsp", workspace(), { PATH: pathDir }),
      ).toThrow(LspProcessError);
      try {
        resolveExecutableOutsideWorkspace("fakelsp", workspace(), { PATH: pathDir });
      } catch (error) {
        expect((error as LspProcessError).code).toBe("EXECUTABLE_NOT_FOUND");
      }
    } finally {
      rmSync(pathDir, { recursive: true, force: true });
      rmSync(realTarget, { force: true });
    }
  });
});
