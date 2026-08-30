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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";
import { writeExecutableFixture } from "./testing/executableFixture.js";
import {
  _resetHostLspPoolForTests,
  disposeHostLspPoolEntry,
  type HostLanguageOperationOptions,
  initializeHostLanguageProvider,
  notifyHostLspWorkspaceFileChanged,
  runHostLanguageOperation,
  shutdownHostLspPool,
} from "./hostLanguageOperation.js";
import {
  _resetLspLifecycleLedgerForTests,
  listAllLspLifecycleEvents,
  listLspLifecycleEvents,
} from "./lspLifecycleLedger.js";
import { managedLspWorkspaceFingerprint } from "./managedLspActivationStore.js";

let binDir = "";
let workspaceRoot = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-host-lsp-pool-bin-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-host-lsp-pool-ws-"));
});

afterEach(async () => {
  // Release warm processes so pooled state never leaks across tests.
  await shutdownHostLspPool();
  _resetHostLspPoolForTests();
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

function runAt(
  root: string,
  spawn: LspSpawnFn,
  lspProcessConfig?: HostLanguageOperationOptions["lspProcessConfig"],
): ReturnType<typeof runHostLanguageOperation> {
  const rules: readonly CommandRule[] = [{ executable: "gopls" }];
  return runHostLanguageOperation(diagnosticsRequest(root), {
    workspace: workspaceAt(root),
    processEnv: { PATH: binDir, KEIKO_EDITOR_LSP_GO: "1" },
    commandRules: rules,
    overlayAbsolutePath: join(root, "main.go"),
    signal: new AbortController().signal,
    spawn,
    ...(lspProcessConfig === undefined ? {} : { lspProcessConfig }),
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

async function settlePool(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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

function initializeAtRevision(
  root: string,
  spawn: LspSpawnFn,
  revision: number,
  lspProcessConfig?: HostLanguageOperationOptions["lspProcessConfig"],
): ReturnType<typeof initializeHostLanguageProvider> {
  return initializeHostLanguageProvider("go", {
    workspace: workspaceAt(root),
    processEnv: { PATH: binDir },
    commandRules: [{ executable: "gopls" }],
    overlayAbsolutePath: root,
    signal: new AbortController().signal,
    spawn,
    activationAuthorized: true,
    activationStillAuthorized: (): boolean => true,
    protocolConfiguration: { revision, settings: {} },
    ...(lspProcessConfig === undefined ? {} : { lspProcessConfig }),
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
    const counted = countingSpawn();
    let predecessorExitedBeforeReplacement = false;
    const spawn: LspSpawnFn = (executable, args, env, cwd) => {
      if (counted.spawnCount() === 1) {
        predecessorExitedBeforeReplacement = counted.controllers()[0]?.exitEmitted() === true;
      }
      return counted.spawn(executable, args, env, cwd);
    };

    await runAtRevision(workspaceRoot, spawn, 1);
    await runAtRevision(workspaceRoot, spawn, 2);

    expect(counted.spawnCount()).toBe(2);
    expect(predecessorExitedBeforeReplacement).toBe(true);
  });

  it("serializes conflicting revisions across the predecessor-exit disposal window", async () => {
    makeExecutable("gopls");
    const counted = countingSpawn();
    expect(await initializeAtRevision(workspaceRoot, counted.spawn, 1)).toMatchObject({
      status: "READY",
      configurationRevision: 1,
    });
    const first = counted.controllers()[0];
    if (first === undefined) throw new TypeError("first controller missing");
    const raced: { third?: ReturnType<typeof initializeHostLanguageProvider> } = {};
    first.handle.onExit(() => {
      raced.third = initializeAtRevision(workspaceRoot, counted.spawn, 3);
    });

    const second = await initializeAtRevision(workspaceRoot, counted.spawn, 2);
    const third = raced.third;
    if (third === undefined) throw new TypeError("third revision was not triggered");

    expect(second?.configurationRevision).toBe(2);
    await expect(third).resolves.toMatchObject({ configurationRevision: 3 });
    expect(counted.spawnCount()).toBe(3);
  });

  it("blocks a new acquisition that races global pool shutdown", async () => {
    makeExecutable("gopls");
    const counted = countingSpawn();
    await initializeAtRevision(workspaceRoot, counted.spawn, 1);
    const first = counted.controllers()[0];
    if (first === undefined) throw new TypeError("first controller missing");
    const raced: {
      blocked?: ReturnType<typeof initializeHostLanguageProvider>;
      shutdown?: Promise<void>;
    } = {};
    first.handle.onExit(() => {
      raced.shutdown = shutdownHostLspPool();
      raced.blocked = initializeAtRevision(workspaceRoot, counted.spawn, 3);
      void raced.blocked.catch(() => undefined);
    });

    const second = await initializeAtRevision(workspaceRoot, counted.spawn, 2);
    if (raced.shutdown === undefined || raced.blocked === undefined) {
      throw new TypeError("shutdown race was not triggered");
    }
    await raced.shutdown;

    expect(second?.configurationRevision).toBe(2);
    await expect(raced.blocked).rejects.toMatchObject({ code: "DISPOSED" });
    expect(counted.spawnCount()).toBe(2);
  });

  it("does not publish a config-revision replacement while tree disposal is unconfirmed", async () => {
    makeExecutable("gopls");
    const controllers: ReturnType<typeof createFakeLspProcess>[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({
        behavior: "unresponsive",
        killConfirmsExit: false,
        killResult: { treeContainment: "unconfirmed", windowsTreeKill: "failed" },
      });
      controllers.push(controller);
      return controller.handle;
    };
    const initializeAt = (revision: number): ReturnType<typeof initializeHostLanguageProvider> =>
      initializeAtRevision(workspaceRoot, spawn, revision, {
        initializeTimeoutMs: 100,
        shutdownTimeoutMs: 10,
      });

    expect(await initializeAt(1)).toMatchObject({ status: "READY", configurationRevision: 1 });
    expect(await initializeAt(2)).toMatchObject({ status: "DISPOSED", configurationRevision: 1 });
    await shutdownHostLspPool();
    expect(await initializeAt(3)).toMatchObject({ status: "DISPOSED", configurationRevision: 1 });
    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.killed()).toEqual(["SIGKILL"]);
  });

  it("opens the document on the replacement child after confirmed crash termination", async () => {
    makeExecutable("gopls");
    const { spawn, controllers } = countingSpawn();

    await runAt(workspaceRoot, spawn);
    controllers()[0]?.emitError();
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

  it("replaces a settled spawn-failed manager on the next acquisition", async () => {
    makeExecutable("gopls");
    let attempts = 0;
    const spawn: LspSpawnFn = () => {
      attempts += 1;
      if (attempts === 1) throw new Error("spawn fixture failure");
      return createFakeLspProcess({ results: DIAGNOSTIC_RESULTS }).handle;
    };

    const first = await runAt(workspaceRoot, spawn);
    const second = await runAt(workspaceRoot, spawn);

    expect(first).toMatchObject({ kind: "error", code: "TIMED_OUT" });
    expect(second).toMatchObject({ kind: "diagnostics" });
    expect(attempts).toBe(2);
  });

  it("quarantines an unsolicited exit across retry and explicit pool invalidation", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount, controllers } = countingSpawn();

    await runAtRevision(workspaceRoot, spawn, 1);
    const first = controllers()[0];
    if (first === undefined) throw new TypeError("first controller missing");
    first.crash();

    const retried = await runAtRevision(workspaceRoot, spawn, 1);
    await disposeHostLspPoolEntry(workspaceRoot, "go");
    const afterInvalidation = await runAtRevision(workspaceRoot, spawn, 2);

    expect(retried).toMatchObject({ kind: "error", code: "TIMED_OUT" });
    expect(afterInvalidation).toMatchObject({ kind: "error", code: "TIMED_OUT" });
    expect(spawnCount()).toBe(1);
    expect(first.killed()).toEqual([]);
  });

  it("keeps a restart-throttled manager down for the same configuration revision", async () => {
    makeExecutable("gopls");
    const { spawn, spawnCount, controllers } = countingSpawn();
    const noRestart = { maxRestartsInWindow: 0 } as const;

    await runAt(workspaceRoot, spawn, noRestart);
    controllers()[0]?.emitError();
    const retried = await runAt(workspaceRoot, spawn, noRestart);

    expect(retried).toMatchObject({ kind: "error", code: "TIMED_OUT" });
    expect(spawnCount()).toBe(1);
    expect(controllers()[0]?.killed()).toEqual(["SIGKILL"]);
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

// Round-3 review finding: createPooledEntry never supplied onLifecycleEvent, so the content-free
// lspLifecycleLedger (KEIKO-0556) never received a single production event -- only a test calling
// recordLspLifecycleEvent directly could populate it, and the read-only status route always
// reported an empty ledger for real workspaces. This proves a REAL pooled manager, driven through
// the same runHostLanguageOperation entry point every other test in this file uses, actually
// reaches the ledger under the same opaque per-workspace partition key
// managedLspActivationStore already uses for its own on-disk record.
describe("durable pooled LSP quarantine", () => {
  it("blocks a post-server-restart spawn after an uncontained root exit", async () => {
    makeExecutable("gopls");
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-host-lsp-runtime-state-"));
    const first = createFakeLspProcess({ results: DIAGNOSTIC_RESULTS });
    const firstOptions: HostLanguageOperationOptions = {
      workspace: workspaceAt(workspaceRoot),
      processEnv: { PATH: binDir, KEIKO_EDITOR_LSP_GO: "1" },
      commandRules: [{ executable: "gopls" }],
      overlayAbsolutePath: join(workspaceRoot, "main.go"),
      signal: new AbortController().signal,
      spawn: () => first.handle,
      privateRuntimeStateRoot: stateDir,
    };
    try {
      await runHostLanguageOperation(diagnosticsRequest(workspaceRoot), firstOptions);
      first.crash();
      await settlePool();

      // This module-memory reset complements lspDurableRestart.integration.test.ts's actual two-
      // process supervisor proof. The identity-safe file lease remains authoritative here too.
      _resetHostLspPoolForTests();
      const replacementSpawn = vi.fn<LspSpawnFn>();
      const outcome = await runHostLanguageOperation(diagnosticsRequest(workspaceRoot), {
        ...firstOptions,
        spawn: replacementSpawn,
      });

      expect(replacementSpawn).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ kind: "error", code: "TIMED_OUT" });
    } finally {
      _resetHostLspPoolForTests();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("pooled LSP manager lifecycle events reach the content-free ledger (round-3 KEIKO-0556-r3)", () => {
  beforeEach(() => {
    _resetLspLifecycleLedgerForTests();
  });
  afterEach(() => {
    _resetLspLifecycleLedgerForTests();
  });

  it("records a real READY transition on the workspace's partition, observable through the status-route projection", async () => {
    makeExecutable("gopls");
    const { spawn } = countingSpawn();
    const partitionKey = managedLspWorkspaceFingerprint(workspaceRoot);

    // Before any operation, the ledger has never heard from this (or any) workspace.
    expect(listLspLifecycleEvents(partitionKey)).toEqual([]);

    const result = await runAt(workspaceRoot, spawn);

    expect(result).toMatchObject({ kind: "diagnostics" });
    // The pooled manager's real spawn->initialize handshake must have recorded at least a READY
    // transition on the fingerprint-derived partition -- not the default/no-op partition.
    const partitioned = listLspLifecycleEvents(partitionKey);
    expect(partitioned.length).toBeGreaterThan(0);
    expect(partitioned.some((e) => e.status === "READY")).toBe(true);
    // Content-free: no raw workspace root ever appears in a stored event.
    expect(JSON.stringify(partitioned)).not.toContain(workspaceRoot);
    // The status route's union projection carries the same events, tagged with this partition.
    const merged = listAllLspLifecycleEvents();
    expect(
      merged.some((e) => e.workspacePartitionKey === partitionKey && e.status === "READY"),
    ).toBe(true);
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
