// GEN-PERF-EDITOR-007 regression: the host LSP path must pool ONE warm process per
// (root, languageId) and serialize concurrent ops onto it, instead of spawning a fresh
// process per request and rejecting a concurrent second op with TIMED_OUT "busy".
//
// Proofs (mechanism, via the injected spawn seam):
//   1. Two SEQUENTIAL ops over the same root+language spawn the child exactly ONCE (pooled).
//   2. A CONCURRENT second op resolves (it queues on the warm process) rather than being
//      rejected as busy.
//   3. Distinct roots get distinct pooled processes (spawn twice).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";
import { writeExecutableFixture } from "./testing/executableFixture.js";
import {
  disposeHostLspPoolEntry,
  initializeHostLanguageProvider,
  notifyHostLspWorkspaceFileChanged,
  runHostLanguageOperation,
  shutdownHostLspPool,
} from "./hostLanguageOperation.js";

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
  writeExecutableFixture(binDir, name);
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

function countingSpawn(): {
  spawn: LspSpawnFn;
  spawnCount: () => number;
  receivedMethods: () => readonly string[];
  controllers: () => readonly ReturnType<typeof createFakeLspProcess>[];
} {
  let count = 0;
  const controllers: ReturnType<typeof createFakeLspProcess>[] = [];
  const spawn: LspSpawnFn = () => {
    count += 1;
    const controller = createFakeLspProcess({ results: DIAGNOSTIC_RESULTS });
    controllers.push(controller);
    return controller.handle;
  };
  return {
    spawn,
    spawnCount: (): number => count,
    receivedMethods: (): readonly string[] =>
      controllers.flatMap((controller) => controller.receivedMethods()),
    controllers: (): readonly ReturnType<typeof createFakeLspProcess>[] => controllers,
  };
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

function runAuthorizedAt(
  root: string,
  spawn: LspSpawnFn,
): ReturnType<typeof runHostLanguageOperation> {
  return runHostLanguageOperation(diagnosticsRequest(root), {
    workspace: workspaceAt(root),
    processEnv: { PATH: binDir },
    commandRules: [{ executable: "gopls" }],
    overlayAbsolutePath: join(root, "main.go"),
    signal: new AbortController().signal,
    spawn,
    activationAuthorized: true,
    activationStillAuthorized: (): boolean => true,
  });
}

function runAtRevision(
  root: string,
  spawn: LspSpawnFn,
  revision: number,
): ReturnType<typeof runHostLanguageOperation> {
  return runHostLanguageOperation(diagnosticsRequest(root), {
    workspace: workspaceAt(root),
    processEnv: { PATH: binDir, KEIKO_EDITOR_LSP_GO: "1" },
    commandRules: [{ executable: "gopls" }],
    overlayAbsolutePath: join(root, "main.go"),
    signal: new AbortController().signal,
    spawn,
    protocolConfiguration: { revision, settings: {} },
  });
}

describe("runHostLanguageOperation pooling (GEN-PERF-EDITOR-007)", () => {
  it("initializes negotiated capabilities without opening a document or executing an operation", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount, receivedMethods } = countingSpawn();

    const health = await initializeHostLanguageProvider("go", {
      workspace: workspaceAt(workspaceRoot),
      processEnv: { PATH: binDir },
      commandRules: [{ executable: "gopls" }],
      overlayAbsolutePath: workspaceRoot,
      signal: new AbortController().signal,
      spawn,
      activationAuthorized: true,
      activationStillAuthorized: (): boolean => true,
      protocolConfiguration: { revision: 7, settings: {} },
    });

    expect(spawnCount()).toBe(1);
    expect(health).toMatchObject({ status: "READY", configurationRevision: 7 });
    expect(health?.negotiatedOperations).toContain("diagnostics");
    expect(receivedMethods()).not.toContain("textDocument/didOpen");
    expect(receivedMethods()).not.toContain("textDocument/diagnostic");
  });

  it("spawns the LSP process ONCE across two sequential ops on the same root+language", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount, receivedMethods } = countingSpawn();

    const first = await runAt(workspaceRoot, spawn);
    const second = await runAt(workspaceRoot, spawn);

    expect(first).toMatchObject({ kind: "diagnostics" });
    expect(second).toMatchObject({ kind: "diagnostics" });
    // Pooled: the warm process from the first op served the second op — no re-spawn.
    expect(spawnCount()).toBe(1);
    await shutdownHostLspPool();
    expect(receivedMethods().filter((method) => method === "initialized")).toHaveLength(1);
    expect(receivedMethods().filter((method) => method === "textDocument/didOpen")).toHaveLength(1);
    expect(receivedMethods().filter((method) => method === "textDocument/didChange")).toHaveLength(
      1,
    );
    expect(receivedMethods().filter((method) => method === "textDocument/didClose")).toHaveLength(
      1,
    );
  });

  it("uses canonical activation without requiring the legacy environment flag", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount } = countingSpawn();

    const result = await runAuthorizedAt(workspaceRoot, spawn);

    expect(result).toMatchObject({ kind: "diagnostics" });
    expect(spawnCount()).toBe(1);
  });

  it("restarts exactly the affected pooled process when configuration revision changes", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount } = countingSpawn();

    await runAtRevision(workspaceRoot, spawn, 1);
    await runAtRevision(workspaceRoot, spawn, 2);

    expect(spawnCount()).toBe(2);
  });

  it("opens the document on the replacement child before an operation after a crash", async () => {
    makeExecutable("gopls");
    const { spawn, controllers } = countingSpawn();

    await runAt(workspaceRoot, spawn);
    controllers()[0]?.crash();
    const result = await runAt(workspaceRoot, spawn);

    expect(result).toMatchObject({ kind: "diagnostics" });
    const replacementMethods = controllers()[1]?.receivedMethods() ?? [];
    expect(replacementMethods.filter((method) => method === "textDocument/didOpen")).toHaveLength(
      1,
    );
    expect(replacementMethods).not.toContain("textDocument/didChange");
    expect(replacementMethods.indexOf("textDocument/didOpen")).toBeLessThan(
      replacementMethods.indexOf("textDocument/diagnostic"),
    );
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

  it("disposes only the selected root and language while unrelated entries remain warm", async () => {
    makeExecutable("gopls");
    const otherRoot = mkdtempSync(join(tmpdir(), "keiko-host-lsp-pool-targeted-ws2-"));
    try {
      const { spawn, spawnCount } = countingSpawn();
      await runAt(workspaceRoot, spawn);
      await runAt(otherRoot, spawn);
      expect(spawnCount()).toBe(2);

      await disposeHostLspPoolEntry(workspaceRoot, "go");
      await runAt(otherRoot, spawn);
      expect(spawnCount()).toBe(2);

      await runAt(workspaceRoot, spawn);
      expect(spawnCount()).toBe(3);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

// r7-lsp-didclose regression: a Deleted watched-file event must close and forget the affected
// overlay(s) in the pool BEFORE the watched-file notification goes out. Otherwise the next op for
// that URI reaches syncDocument with the entry still present and sends didChange instead of
// didOpen, so diagnostics/symbols keep serving the deleted (or a renamed-away) path's stale
// content until the pooled process is next idle-evicted.
describe("notifyHostLspWorkspaceFileChanged Deleted closes stale overlays (r7-lsp-didclose)", () => {
  function pathRequest(root: string, relPath: string): LanguageServiceRequest {
    return {
      operation: "diagnostics",
      root,
      document: { path: relPath, languageId: "go", text: "package main\nfunc main() {}\n" },
    };
  }

  function runPathAt(
    root: string,
    relPath: string,
    spawn: LspSpawnFn,
  ): ReturnType<typeof runHostLanguageOperation> {
    return runHostLanguageOperation(pathRequest(root, relPath), {
      workspace: workspaceAt(root),
      processEnv: { PATH: binDir, KEIKO_EDITOR_LSP_GO: "1" },
      commandRules: [{ executable: "gopls" }],
      overlayAbsolutePath: join(root, relPath),
      signal: new AbortController().signal,
      spawn,
    });
  }

  function trackingSpawn(): {
    spawn: LspSpawnFn;
    notifications: () => readonly { method: string; params: unknown }[];
  } {
    const notifications: { method: string; params: unknown }[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({
        results: DIAGNOSTIC_RESULTS,
        onMessage: (method, params): void => {
          notifications.push({ method, params });
        },
      });
      return controller.handle;
    };
    return {
      spawn,
      notifications: (): readonly { method: string; params: unknown }[] => notifications,
    };
  }

  function urisFor(
    notifications: readonly { method: string; params: unknown }[],
    method: string,
  ): readonly string[] {
    return notifications
      .filter((entry) => entry.method === method)
      .map((entry) => {
        const params = entry.params as { textDocument?: { uri?: unknown } };
        return typeof params.textDocument?.uri === "string" ? params.textDocument.uri : "";
      });
  }

  it("closes the deleted file's overlay so the next op re-opens it instead of resuming with didChange", async () => {
    makeExecutable("gopls");
    const { spawn, notifications } = trackingSpawn();
    const mainUri = pathToFileURL(join(workspaceRoot, "main.go")).href;

    await runPathAt(workspaceRoot, "main.go", spawn);
    expect(urisFor(notifications(), "textDocument/didOpen")).toEqual([mainUri]);

    notifyHostLspWorkspaceFileChanged(workspaceRoot, join(workspaceRoot, "main.go"), 3);
    // sendNotification only buffers a write on the fake process's stdin PassThrough; the fake's
    // own async read loop drains it on a later tick. The next op's awaited request/response round
    // trip travels the SAME stream, so by the time it resolves every frame written earlier —
    // including this didClose — is guaranteed to have already been read (FIFO single stream).
    await runPathAt(workspaceRoot, "main.go", spawn);

    expect(urisFor(notifications(), "textDocument/didOpen")).toEqual([mainUri, mainUri]);
    expect(urisFor(notifications(), "textDocument/didClose")).toEqual([mainUri]);
    expect(urisFor(notifications(), "textDocument/didChange")).toEqual([]);
    expect(
      notifications().some((entry) => entry.method === "workspace/didChangeWatchedFiles"),
    ).toBe(true);
  });

  it("closes every overlay nested under a deleted directory using a path-segment-safe prefix match", async () => {
    makeExecutable("gopls");
    const { spawn, notifications } = trackingSpawn();
    const nestedUri = pathToFileURL(join(workspaceRoot, "pkg/nested.go")).href;
    const siblingUri = pathToFileURL(join(workspaceRoot, "pkg-sibling/other.go")).href;

    await runPathAt(workspaceRoot, "pkg/nested.go", spawn);
    await runPathAt(workspaceRoot, "pkg-sibling/other.go", spawn);
    expect(urisFor(notifications(), "textDocument/didOpen")).toEqual([nestedUri, siblingUri]);

    // Deleting directory "pkg" must not treat "pkg-sibling" as nested under it — a raw string
    // prefix match would wrongly close/reopen the sibling too.
    notifyHostLspWorkspaceFileChanged(workspaceRoot, join(workspaceRoot, "pkg"), 3);
    // See the sibling test above for why these ops must be awaited before the notification
    // arrays are asserted: the fake process drains its stdin asynchronously, and only an awaited
    // request/response round trip over the same stream proves everything written earlier landed.
    await runPathAt(workspaceRoot, "pkg/nested.go", spawn);
    await runPathAt(workspaceRoot, "pkg-sibling/other.go", spawn);

    expect(urisFor(notifications(), "textDocument/didOpen")).toEqual([
      nestedUri,
      siblingUri,
      nestedUri,
    ]);
    expect(urisFor(notifications(), "textDocument/didClose")).toEqual([nestedUri]);
    // The sibling stayed open the whole time, so its second op is a didChange, not a re-didOpen.
    expect(urisFor(notifications(), "textDocument/didChange")).toEqual([siblingUri]);
  });
});
