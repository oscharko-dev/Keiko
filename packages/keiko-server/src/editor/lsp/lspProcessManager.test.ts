import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LspLifecycleEvent, LspProcessConfig } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import { createLspProcessManager } from "./lspProcessManager.js";
import type { LspProcessManagerDeps } from "./lspProcessManager.js";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import type {
  LspRuntimeStateLoadResult,
  LspRuntimeStatePort,
  LspRuntimeStateSnapshot,
} from "./lspRuntimeStateStore.js";
import { createLspFrameReader, writeLspFrame } from "./lspFrameCodec.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";
import type { FakeLspBehavior, FakeLspController } from "./testing/fakeLspProcess.js";
import { writeExecutableFixture } from "./testing/executableFixture.js";
import type { ServerLogEvent } from "../../observability/server-log.js";
import {
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../../observability/server-logger.js";
import { UNKNOWN_CORRELATION_ID } from "../../correlation.js";
import { redactLogFields } from "../../observability/log-redaction.js";

// `resolveExecutableOutsideWorkspace` runs against the real filesystem even when the spawn function is
// faked, so the manager only proceeds to spawn if `fakelsp` actually resolves on PATH outside the
// workspace. A throwaway bin dir holding an executable `fakelsp` satisfies that preflight while the
// injected fake stands in for the real process behaviour.
let BIN_DIR = "";
let WORKSPACE_ROOT = "";

beforeAll(() => {
  BIN_DIR = mkdtempSync(join(tmpdir(), "keiko-lsp-bin-"));
  WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "keiko-lsp-ws-"));
  writeExecutableFixture(BIN_DIR, "fakelsp");
  writeExecutableFixture(BIN_DIR, "approvedtool");
});

afterAll(() => {
  rmSync(BIN_DIR, { recursive: true, force: true });
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  resetServerLogger();
});

function workspace(): WorkspaceInfo {
  return {
    root: WORKSPACE_ROOT,
    selectedRoot: WORKSPACE_ROOT,
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

// Short, real timers keep the lifecycle deterministic: the JSON-RPC client's deadline uses the real
// scheduler, so a 20 ms initialize timeout fires within a few `settle()` turns without wall-clock waits.
function makeConfig(overrides: Partial<LspProcessConfig> = {}): LspProcessConfig {
  return {
    managerId: "mgr-1381",
    executableName: "fakelsp",
    executableArgs: ["--stdio"],
    initializeTimeoutMs: 30,
    requestTimeoutMs: 30,
    shutdownTimeoutMs: 30,
    maxFrameBytes: 1_048_576,
    restartWindowMs: 60_000,
    maxRestartsInWindow: 2,
    envAllowlist: ["PATH"],
    networkPolicy: "inherit",
    ...overrides,
  };
}

async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function settleMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  await settle();
}

function captureServerLog(): ServerLogEvent[] {
  const events: ServerLogEvent[] = [];
  setServerLogger(
    createServerLogger({ sink: { write: (event) => events.push(event) }, level: "debug" }),
  );
  return events;
}

function findOwnershipLog(
  events: readonly ServerLogEvent[],
  action: "retained-unconfirmed" | "released-after-exit",
  expected: { readonly reason?: string; readonly childPid?: number } = {},
): ServerLogEvent | undefined {
  return events.find(
    (event) =>
      event.op === "lsp.process.ownership.changed" &&
      event.extra?.action === action &&
      (expected.reason === undefined || event.extra.reason === expected.reason) &&
      (expected.childPid === undefined || event.extra.childPid === expected.childPid),
  );
}

interface Harness {
  spawn: LspSpawnFn;
  controllers: FakeLspController[];
  spawnCount(): number;
}

function fakeSpawnHarness(behaviors: readonly FakeLspBehavior[], oversized?: number): Harness {
  const controllers: FakeLspController[] = [];
  let index = 0;
  const spawn: LspSpawnFn = () => {
    const behavior = behaviors[Math.min(index, behaviors.length - 1)] ?? "normal";
    const controller = createFakeLspProcess({
      behavior,
      ...(oversized !== undefined ? { oversizedContentLength: oversized } : {}),
    });
    controllers.push(controller);
    index += 1;
    return controller.handle;
  };
  return { spawn, controllers, spawnCount: () => index };
}

interface SilentHandle {
  spawn: LspSpawnFn;
  controller: { exitEmitted(): boolean };
}

// A spawn handle that answers `initialize` (so the manager reaches READY) but ignores every later
// request, forcing the per-request deadline to fire while the process stays alive. Built directly on
// the codec rather than the fake, which always replies to every request.
function silentAfterInitSpawn(): SilentHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exited = false;
  void (async (): Promise<void> => {
    const reader = createLspFrameReader(stdin, 1_048_576);
    try {
      for await (const body of reader) {
        const message = JSON.parse(body.toString("utf8")) as { id?: number; method?: string };
        if (message.method === "initialize" && message.id !== undefined) {
          writeLspFrame(stdout, JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        }
      }
    } catch {
      // Stream closed on dispose.
    }
  })();
  const spawn: LspSpawnFn = () => ({
    stdin: {
      write: (chunk: Buffer): void => {
        stdin.write(chunk);
      },
    },
    stdout,
    stderr,
    pid: 7777,
    kill: (signal): void => {
      if (signal === "SIGKILL") {
        exited = true;
        stdout.end();
      }
    },
    onExit: (): void => undefined,
    onError: (): void => undefined,
  });
  return { spawn, controller: { exitEmitted: (): boolean => exited } };
}

function makeDeps(
  spawn: LspSpawnFn,
  config: LspProcessConfig,
  onLifecycleEvent?: (event: LspLifecycleEvent) => void,
): LspProcessManagerDeps {
  return {
    config,
    workspace: workspace(),
    processEnv: { PATH: BIN_DIR },
    commandRules: RULES,
    spawn,
    now: () => 1_000,
    ...(onLifecycleEvent !== undefined ? { onLifecycleEvent } : {}),
  };
}

function memoryRuntimeStatePort(
  initial: LspRuntimeStateLoadResult = { state: "absent" },
): LspRuntimeStatePort & { snapshot(): LspRuntimeStateSnapshot | undefined } {
  let loaded = initial;
  let snapshot: LspRuntimeStateSnapshot | undefined =
    initial.state === "ready" ? initial.snapshot : undefined;
  return {
    load: (): LspRuntimeStateLoadResult => loaded,
    save: (next): void => {
      snapshot = next;
      loaded = { state: "ready", snapshot: next };
    },
    snapshot: (): LspRuntimeStateSnapshot | undefined => snapshot,
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

describe("createLspProcessManager", () => {
  it("uses the prepared executable and arguments and cleans generation resources on dispose", async () => {
    const controller = createFakeLspProcess();
    const cleanup = vi.fn();
    let received: { executable: string; args: readonly string[] } | undefined;
    const spawn: LspSpawnFn = (executable, args) => {
      received = { executable, args };
      return controller.handle;
    };
    const manager = createLspProcessManager({
      ...makeDeps(spawn, makeConfig()),
      prepareSpawn: (input) => ({
        executable: "/usr/bin/sandbox-wrapper",
        args: ["--deny-egress", input.executable, ...input.args],
        env: input.env,
        cleanup,
      }),
    });
    // The optional beforeSpawn seam must not make the ordinary path asynchronous.
    expect(received).toBeDefined();
    await settle();

    expect(received).toEqual({
      executable: "/usr/bin/sandbox-wrapper",
      args: ["--deny-egress", realpathSync(join(BIN_DIR, "fakelsp")), "--stdio"],
    });
    await manager.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("acquires the durable lease before awaiting beforeSpawn and spawns only after success", async () => {
    const gate = deferred();
    const runtimeState = memoryRuntimeStatePort();
    const cleanup = vi.fn();
    const harness = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager({
      ...makeDeps(harness.spawn, makeConfig()),
      runtimeState,
      prepareSpawn: (input) => ({
        ...input,
        beforeSpawn: (): Promise<void> => gate.promise,
        cleanup,
      }),
    });

    expect(harness.spawnCount()).toBe(0);
    expect(runtimeState.snapshot()).toMatchObject({ generation: 1, leaseState: "active" });
    expect(cleanup).not.toHaveBeenCalled();

    gate.resolve();
    await settle();

    expect(harness.spawnCount()).toBe(1);
    expect(manager.getLspProcessStatus()).toBe("READY");
    await manager.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("releases the lease and cleanup once when beforeSpawn fails without spawning", async () => {
    const runtimeState = memoryRuntimeStatePort();
    const cleanup = vi.fn();
    const harness = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager({
      ...makeDeps(harness.spawn, makeConfig()),
      runtimeState,
      prepareSpawn: (input) => ({
        ...input,
        beforeSpawn: (): Promise<void> => Promise.reject(new Error("probe failed")),
        cleanup,
      }),
    });

    await settle();

    expect(harness.spawnCount()).toBe(0);
    expect(manager.getLspProcessStatus()).toBe("SPAWN_FAILED");
    expect(runtimeState.snapshot()).toMatchObject({ generation: 1, leaseState: "released" });
    expect(cleanup).toHaveBeenCalledOnce();
    await manager.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("aborts and awaits a pending beforeSpawn so late success cannot spawn", async () => {
    const gate = deferred();
    const cleanup = vi.fn();
    let probeSignal: AbortSignal | undefined;
    const harness = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager({
      ...makeDeps(harness.spawn, makeConfig()),
      prepareSpawn: (input) => ({
        ...input,
        beforeSpawn: (signal): Promise<void> => {
          probeSignal = signal;
          return gate.promise;
        },
        cleanup,
      }),
    });
    await settle();

    let disposed = false;
    const disposal = manager.dispose().then(() => {
      disposed = true;
    });
    await settle();

    expect(probeSignal?.aborted).toBe(true);
    expect(disposed).toBe(false);
    expect(harness.spawnCount()).toBe(0);
    expect(cleanup).not.toHaveBeenCalled();

    gate.resolve();
    await disposal;

    expect(harness.spawnCount()).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
  });

  it("restores a pending probe lease as quarantine in a second supervisor", async () => {
    const gate = deferred();
    const runtimeState = memoryRuntimeStatePort();
    const firstSpawn = vi.fn<LspSpawnFn>();
    const first = createLspProcessManager({
      ...makeDeps(firstSpawn, makeConfig()),
      runtimeState,
      prepareSpawn: (input) => ({
        ...input,
        beforeSpawn: (): Promise<void> => gate.promise,
      }),
    });
    await settle();
    expect(runtimeState.snapshot()).toMatchObject({ leaseState: "active" });

    const replacementSpawn = vi.fn<LspSpawnFn>();
    const replacement = createLspProcessManager({
      ...makeDeps(replacementSpawn, makeConfig()),
      runtimeState,
    });

    expect(replacement.getLspProcessStatus()).toBe("CRASHED");
    expect(replacement.hasRetainedProcessOwnership()).toBe(true);
    expect(replacementSpawn).not.toHaveBeenCalled();

    const disposal = first.dispose();
    gate.resolve();
    await disposal;
    expect(firstSpawn).not.toHaveBeenCalled();
    await replacement.dispose();
  });

  it("kills the process and fails closed when its runtime-state budget is exceeded", async () => {
    const controller = createFakeLspProcess({ results: { "textDocument/hover": null } });
    let budgetSatisfied = true;
    let spawnCount = 0;
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager({
      ...makeDeps(
        () => {
          spawnCount += 1;
          return controller.handle;
        },
        makeConfig(),
        (event) => events.push(event),
      ),
      prepareSpawn: (input) => ({
        executable: input.executable,
        args: input.args,
        env: input.env,
        resourceBudgetSatisfied: (): boolean => budgetSatisfied,
      }),
    });
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    budgetSatisfied = false;
    await expect(
      manager.sendRequest("textDocument/hover", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RESOURCE_BUDGET_EXCEEDED" });
    expect(manager.getLspProcessStatus()).toBe("CRASHED");
    expect(controller.killed()).toContain("SIGKILL");
    await settle();
    expect(spawnCount).toBe(1);
    const budgetEvents = events.filter((event) => event.errorCode === "RESOURCE_BUDGET_EXCEEDED");
    expect(budgetEvents).toHaveLength(1);
    // Review C2 (5058544058, 3887021649): the transition that carries the termination REASON must
    // also carry the child's identity, so support can join it to the spawn adapter's per-kill
    // `lsp.process.terminated` line (signal + verified tree-kill disposition) on childPid.
    expect(budgetEvents[0]?.childPid).toBe(4242);
    await manager.dispose();
  });

  // The default fake publishes a synchronous exit confirmation on SIGKILL. That confirmed path may
  // release its handle immediately; the unconfirmed counterpart is pinned separately below.
  it("does not re-signal a confirmed resource-budget exit during later disposal", async () => {
    const controller = createFakeLspProcess({ results: { "textDocument/hover": null } });
    let budgetSatisfied = true;
    const manager = createLspProcessManager({
      ...makeDeps(() => controller.handle, makeConfig()),
      prepareSpawn: (input) => ({
        executable: input.executable,
        args: input.args,
        env: input.env,
        resourceBudgetSatisfied: (): boolean => budgetSatisfied,
      }),
    });
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    budgetSatisfied = false;
    await expect(
      manager.sendRequest("textDocument/hover", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RESOURCE_BUDGET_EXCEEDED" });
    expect(manager.getLspProcessStatus()).toBe("CRASHED");
    const signalsBeforeDispose = [...controller.killed()];
    expect(signalsBeforeDispose).toContain("SIGKILL");

    await manager.dispose();

    // dispose() must not add a further signal against the already-dead handle.
    expect(controller.killed()).toEqual(signalsBeforeDispose);
  });

  it("retains a resource-budget child until a later OS exit confirmation", async () => {
    const log = captureServerLog();
    const controller = createFakeLspProcess({
      results: { "textDocument/hover": null },
      killConfirmsExit: false,
    });
    let budgetSatisfied = true;
    const manager = createLspProcessManager({
      ...makeDeps(() => controller.handle, makeConfig()),
      prepareSpawn: (input) => ({
        executable: input.executable,
        args: input.args,
        env: input.env,
        resourceBudgetSatisfied: (): boolean => budgetSatisfied,
      }),
    });
    await settle();
    budgetSatisfied = false;

    await expect(
      manager.sendRequest("textDocument/hover", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RESOURCE_BUDGET_EXCEEDED" });
    expect(controller.exitEmitted()).toBe(false);
    expect(findOwnershipLog(log, "retained-unconfirmed", { childPid: 4242 })).toBeDefined();
    controller.confirmExit();
    await settle();
    expect(findOwnershipLog(log, "released-after-exit", { childPid: 4242 })).toBeDefined();
    await manager.dispose();
  });

  it("retains generation resources until exit and tree containment are both confirmed", async () => {
    const cleanup = vi.fn();
    const controller = createFakeLspProcess({
      behavior: "unresponsive",
      killConfirmsExit: false,
    });
    const manager = createLspProcessManager({
      ...makeDeps(() => controller.handle, makeConfig({ shutdownTimeoutMs: 5 })),
      prepareSpawn: (input) => ({ ...input, cleanup }),
    });
    await settle();

    await manager.dispose();

    expect(controller.killed()).toEqual(["SIGKILL"]);
    expect(controller.exitEmitted()).toBe(false);
    expect(manager.hasRetainedProcessOwnership()).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();

    controller.confirmExit();
    await settle();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(manager.hasRetainedProcessOwnership()).toBe(false);
  });

  it("retains and retries a prepared resource cleanup that initially throws", async () => {
    const controller = createFakeLspProcess();
    let cleanupAttempts = 0;
    const cleanup = vi.fn((): void => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("cleanup sentinel");
    });
    const manager = createLspProcessManager({
      ...makeDeps(() => controller.handle, makeConfig()),
      approvedDescendantExecutables: ["approvedtool"],
      commandRules: [...RULES, { executable: "approvedtool" }],
      prepareSpawn: (input) => ({ ...input, cleanup }),
    });
    await settle();

    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
    expect(manager.hasRetainedProcessOwnership()).toBe(true);

    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(manager.hasRetainedProcessOwnership()).toBe(false);
  });

  it("retains an empty negotiated snapshot when a server advertises no capabilities", async () => {
    const controller = createFakeLspProcess({ initializeResult: { capabilities: {} } });
    const manager = createLspProcessManager({
      ...makeDeps(() => controller.handle, makeConfig()),
      protocol: {
        language: "python",
        candidateOperations: ["completion", "hover"],
        semanticTokensCandidate: true,
        configurationRevision: 8,
        configuration: {},
      },
    });
    await settle();

    expect(manager.getNegotiatedCapabilities()).toMatchObject({
      configurationRevision: 8,
      negotiatedOperations: [],
      textSync: "none",
    });
    expect(manager.getHealthSnapshot()).toMatchObject({
      language: "python",
      status: "READY",
      configurationRevision: 8,
      negotiatedOperations: [],
      requestCount: 0,
    });
    await manager.dispose();
  });

  it("records content-free request outcome and latency counters", async () => {
    const { spawn } = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager({
      ...makeDeps(spawn, makeConfig()),
      protocol: {
        language: "python",
        candidateOperations: ["hover"],
        semanticTokensCandidate: false,
        configurationRevision: 2,
        configuration: {},
      },
    });
    await settle();
    await manager.sendRequest("textDocument/hover", {}, new AbortController().signal);

    const health = manager.getHealthSnapshot();
    if (health === undefined) throw new Error("Expected LSP health snapshot");
    expect(health).toMatchObject({ requestCount: 1, successCount: 1, failureCount: 0 });
    expect(health.latency).toMatchObject({ count: 1, lessThanOrEqual10Ms: 1 });
    expect(JSON.stringify(health)).not.toContain(WORKSPACE_ROOT);
    await manager.dispose();
  });

  it("reaches READY after a successful initialize handshake", async () => {
    const { spawn } = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager(makeDeps(spawn, makeConfig()));
    await settle();

    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(manager.asLanguageProvider(["python"], ["hover"]).descriptor.availability).toBe(
      "available",
    );
    await manager.dispose();
  });

  it("emits a content-free lifecycle event on every transition", async () => {
    const events: LspLifecycleEvent[] = [];
    const { spawn } = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig(), (event) => events.push(event)),
    );
    await settle();
    await manager.dispose();

    const statuses = events.map((event) => event.status);
    expect(statuses).toContain("STARTING");
    expect(statuses).toContain("INITIALIZING");
    expect(statuses).toContain("READY");
    expect(statuses).toContain("SHUTDOWN");
    expect(statuses).toContain("DISPOSED");
    for (const event of events) {
      expect(event.schemaVersion).toBe("1");
      expect(event.managerId).toBe("mgr-1381");
    }
  });

  // F1 (PR reviewer finding, ~lspProcessManager.ts line 359): disposeManager called
  // cleanupSpawnResources and then transitioned to DISPOSED without ever clearing state.child, so
  // the terminal event's spread (`...state.child?.pid !== undefined ? { childPid: ... } : {}`) kept
  // emitting a child pid even after this normal path had observed exit and released ownership. An
  // unconfirmed terminal path intentionally retains the pid (pinned below), but a confirmed exit
  // must remove it before the OS can reuse that pid for an unrelated process.
  it("clears childPid from the terminal DISPOSED event after normal disposal (F1)", async () => {
    const { spawn } = fakeSpawnHarness(["normal"]);
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig(), (event) => events.push(event)),
    );
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    // Prove the manager genuinely had a live child before disposal, so the terminal assertion below
    // is not vacuous: 4242 is the fake process handle's constant pid (testing/fakeLspProcess.ts).
    const readyEvent = events.find((event) => event.status === "READY");
    expect(readyEvent?.childPid).toBe(4242);

    await manager.dispose();

    const disposedEvents = events.filter((event) => event.status === "DISPOSED");
    expect(disposedEvents).toHaveLength(1);
    const terminal = disposedEvents[0];
    expect(terminal).toBeDefined();
    if (terminal === undefined) throw new Error("terminal DISPOSED event missing");
    expect(terminal.childPid).toBeUndefined();
    // The field must be genuinely absent after confirmed ownership release, not merely
    // `undefined` — a stronger pin than toBeUndefined() alone, which would also pass for an
    // explicitly-set `undefined` value that still serialises differently under some encoders.
    expect(Object.hasOwn(terminal, "childPid")).toBe(false);
  });

  it("keeps an unconfirmed disposed child owned by the background exit reaper", async () => {
    const log = captureServerLog();
    const events: LspLifecycleEvent[] = [];
    const controller = createFakeLspProcess({
      behavior: "unresponsive",
      killConfirmsExit: false,
    });
    const manager = createLspProcessManager(
      makeDeps(
        () => controller.handle,
        makeConfig({ shutdownTimeoutMs: 5 }),
        (event) => events.push(event),
      ),
    );
    await settle();

    await manager.dispose();

    expect(controller.exitEmitted()).toBe(false);
    expect(events.filter((event) => event.status === "DISPOSED")).toContainEqual(
      expect.objectContaining({ childPid: 4242 }),
    );
    const retained = findOwnershipLog(log, "retained-unconfirmed", { childPid: 4242 });
    expect(retained?.correlationId).toBe(UNKNOWN_CORRELATION_ID);

    controller.confirmExit();
    await settle();
    expect(findOwnershipLog(log, "released-after-exit", { childPid: 4242 })).toBeDefined();
  });

  it("transitions to INITIALIZE_TIMEOUT when the server never answers initialize", async () => {
    const controller = createFakeLspProcess({ behavior: "slow", killConfirmsExit: false });
    const manager = createLspProcessManager(makeDeps(() => controller.handle, makeConfig()));
    await settleMs(60);

    expect(manager.getLspProcessStatus()).toBe("INITIALIZE_TIMEOUT");
    expect(manager.asLanguageProvider(["python"], ["hover"]).descriptor.availability).toBe(
      "unavailable",
    );
    await manager.dispose();
  });

  it("retains an initialize-timeout child until its delayed exit is observed", async () => {
    const log = captureServerLog();
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({
        behavior: controllers.length === 0 ? "slow" : "normal",
        killConfirmsExit: controllers.length !== 0,
      });
      controllers.push(controller);
      return controller.handle;
    };
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig({ initializeTimeoutMs: 10 })),
    );

    await settleMs(25);
    const controller = controllers[0];
    if (controller === undefined) throw new Error("initializing controller missing");
    expect(manager.getLspProcessStatus()).toBe("INITIALIZE_TIMEOUT");
    expect(controller.exitEmitted()).toBe(false);
    expect(findOwnershipLog(log, "retained-unconfirmed", { childPid: 4242 })).toBeDefined();

    controller.confirmExit();
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(controllers).toHaveLength(2);
    expect(findOwnershipLog(log, "released-after-exit", { childPid: 4242 })).toBeDefined();
    await manager.dispose();
  });

  it("restarts after a confirmed initialization-timeout exit and ignores stale callbacks", async () => {
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({
        behavior: controllers.length === 0 ? "slow" : "normal",
        killConfirmsExit: controllers.length !== 0,
      });
      controllers.push(controller);
      return controller.handle;
    };
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig(), (event) => events.push(event)),
    );

    await settleMs(60);

    expect(manager.getLspProcessStatus()).toBe("INITIALIZE_TIMEOUT");
    expect(controllers).toHaveLength(1);
    const failedChild = controllers[0];
    expect(failedChild).toBeDefined();
    if (failedChild === undefined) throw new TypeError("failed initialization child missing");
    expect(failedChild.killed()).toEqual(["SIGKILL"]);

    failedChild.confirmExit();
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(controllers).toHaveLength(2);

    // A late callback from the released generation must not restart or rewrite the replacement.
    failedChild.emitLateExit(1);
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(controllers).toHaveLength(2);

    await manager.dispose();
    expect(failedChild.killed()).toEqual(["SIGKILL"]);
    const disposed = events.find((event) => event.status === "DISPOSED");
    expect(disposed).toBeDefined();
    expect(Object.hasOwn(disposed ?? {}, "childPid")).toBe(false);
  });

  it("times out an in-flight request with REQUEST_TIMED_OUT while staying READY", async () => {
    const { spawn, controller } = silentAfterInitSpawn();
    const config = makeConfig({ requestTimeoutMs: 20 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    const pending = manager.sendRequest("textDocument/hover", {}, new AbortController().signal);
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMED_OUT" });
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(controller.exitEmitted()).toBe(false);
    await manager.dispose();
  });

  it("maps an aborted request to CANCELLED", async () => {
    const { spawn } = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager(makeDeps(spawn, makeConfig()));
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    const aborter = new AbortController();
    aborter.abort();
    await expect(
      manager.sendRequest("textDocument/hover", {}, aborter.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await manager.dispose();
  });

  it("restarts after confirmed crash termination and returns to READY", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["normal", "normal"]);
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig(), (event) => events.push(event)),
    );
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(manager.getChildGeneration()).toBe(1);

    controllers[0]?.emitError();
    await settle();

    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(manager.getChildGeneration()).toBe(2);
    const crashed = events.find((event) => event.status === "CRASHED");
    expect(crashed).toBeDefined();
    expect(events.some((event) => event.status === "READY" && event.restartCount === 1)).toBe(true);
    await manager.dispose();
  });

  it("rotates and removes the private descendant PATH across crash and disposal", async () => {
    const paths: string[] = [];
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = (_executable, _args, env) => {
      paths.push(env.PATH ?? "");
      const controller = createFakeLspProcess();
      controllers.push(controller);
      return controller.handle;
    };
    const manager = createLspProcessManager({
      ...makeDeps(spawn, makeConfig()),
      commandRules: [...RULES, { executable: "approvedtool" }],
      approvedDescendantExecutables: ["approvedtool"],
    });
    await settle();
    const firstPath = paths[0] ?? "";
    expect(existsSync(firstPath)).toBe(true);

    controllers[0]?.emitError();
    await settle();
    const secondPath = paths[1] ?? "";
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(secondPath)).toBe(true);

    await manager.dispose();
    expect(existsSync(secondPath)).toBe(false);
  });

  it("retains an unsolicited exit without starting a potentially parallel replacement", async () => {
    const log = captureServerLog();
    const events: LspLifecycleEvent[] = [];
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({ behavior: "unresponsive-request" });
      controllers.push(controller);
      return controller.handle;
    };
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig({ requestTimeoutMs: 30_000, maxRestartsInWindow: 0 }), (event) =>
        events.push(event),
      ),
    );
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    const pending = manager.sendRequest<unknown>(
      "textDocument/hover",
      {},
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "DISPOSED" });
    const first = controllers[0];
    if (first === undefined) throw new TypeError("first controller missing");
    // Model a leader that exits while a descendant may remain. No raw pid signal is safe after this
    // observation, and no second generation may start without tree-containment proof.
    first.crash(1);
    await settle();
    await assertion;

    expect(manager.getLspProcessStatus()).toBe("CRASHED");
    expect(manager.getChildGeneration()).toBe(1);
    expect(manager.hasRetainedProcessOwnership()).toBe(true);
    expect(controllers).toHaveLength(1);
    expect(first.killed()).toEqual([]);
    expect(events.filter((event) => event.status === "CRASHED")).toContainEqual(
      expect.objectContaining({ childPid: 4242, pendingRequestCount: 0, restartCount: 0 }),
    );
    expect(
      findOwnershipLog(log, "retained-unconfirmed", {
        reason: "tree-unconfirmed",
        childPid: 4242,
      }),
    ).toBeDefined();
    await manager.dispose();
    expect(manager.hasRetainedProcessOwnership()).toBe(true);
    expect(first.killed()).toEqual([]);
    expect(events.filter((event) => event.status === "DISPOSED")).toContainEqual(
      expect.objectContaining({ childPid: 4242, pendingRequestCount: 0 }),
    );
  });

  it.each(["child-error", "reader-error"] as const)(
    "waits for confirmed exit before restarting after %s",
    async (source) => {
      const log = captureServerLog();
      const controllers: FakeLspController[] = [];
      const spawn: LspSpawnFn = () => {
        const firstGeneration = controllers.length === 0;
        const controller = createFakeLspProcess({
          behavior: firstGeneration && source === "reader-error" ? "oversized" : "normal",
          oversizedContentLength: 8_000_000,
          killConfirmsExit: !firstGeneration,
        });
        controllers.push(controller);
        return controller.handle;
      };
      const manager = createLspProcessManager(
        makeDeps(spawn, makeConfig({ maxFrameBytes: 4_096, initializeTimeoutMs: 200 })),
      );
      await settle();
      const first = controllers[0];
      if (first === undefined) throw new Error("first controller missing");
      if (source === "child-error") {
        expect(manager.getLspProcessStatus()).toBe("READY");
        first.emitError();
        await settle();
      }

      expect(manager.getLspProcessStatus()).toBe("CRASHED");
      expect(first.killed()).toContain("SIGKILL");
      expect(first.exitEmitted()).toBe(false);
      expect(controllers).toHaveLength(1);
      expect(findOwnershipLog(log, "retained-unconfirmed", { childPid: 4242 })).toBeDefined();

      await settle();
      expect(controllers).toHaveLength(1);
      first.confirmExit();
      await settle();

      expect(controllers).toHaveLength(2);
      expect(manager.getLspProcessStatus()).toBe("READY");
      expect(findOwnershipLog(log, "released-after-exit", { childPid: 4242 })).toBeDefined();
      await manager.dispose();
    },
  );

  it("does not release or restart when the wrapper exits after an unconfirmed tree kill", async () => {
    const log = captureServerLog();
    const events: LspLifecycleEvent[] = [];
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({
        killResult: {
          treeContainment: "unconfirmed",
          windowsTreeKill: "failed",
        },
      });
      controllers.push(controller);
      return controller.handle;
    };
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig(), (event) => events.push(event)),
    );
    await settle();
    const first = controllers[0];
    if (first === undefined) throw new Error("first controller missing");

    first.emitError();
    await settle();

    expect(first.exitEmitted()).toBe(true);
    expect(first.killed()).toEqual(["SIGKILL"]);
    expect(controllers).toHaveLength(1);
    expect(manager.getLspProcessStatus()).toBe("CRASHED");
    const retained = findOwnershipLog(log, "retained-unconfirmed", {
      reason: "tree-unconfirmed",
      childPid: 4242,
    });
    expect(retained).toBeDefined();
    expect(redactLogFields(retained?.extra)).toEqual(retained?.extra);
    expect(findOwnershipLog(log, "released-after-exit")).toBeUndefined();

    await manager.dispose();
    expect(first.killed()).toEqual(["SIGKILL"]);
    expect(events.filter((event) => event.status === "DISPOSED")).toContainEqual(
      expect.objectContaining({ childPid: 4242 }),
    );
  });

  it("treats an asynchronous spawn error without a pid as confirmed not-spawned", async () => {
    const log = captureServerLog();
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({
        pid: controllers.length === 0 ? null : 4242,
      });
      controllers.push(controller);
      return controller.handle;
    };
    const manager = createLspProcessManager(makeDeps(spawn, makeConfig()));
    await settle();
    const pidless = controllers[0];
    if (pidless === undefined) throw new Error("pidless controller missing");

    pidless.emitError();
    await settle();

    expect(pidless.killed()).toEqual([]);
    expect(controllers).toHaveLength(2);
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(findOwnershipLog(log, "retained-unconfirmed")).toBeUndefined();
    await manager.dispose();
  });

  it("discards a stale exit from a superseded child without a second CRASHED or throttle debit (FIX 4)", async () => {
    // After a crash + restart, a LATE exit event from the OLD (superseded) child must be ignored:
    // its captured generation no longer matches state.childGeneration. Otherwise it would emit a
    // spurious CRASHED and debit the restart throttle, halving the budget on real servers.
    const { spawn, controllers } = fakeSpawnHarness(["normal", "normal", "normal"]);
    const events: LspLifecycleEvent[] = [];
    const config = makeConfig({ maxRestartsInWindow: 2, restartWindowMs: 60_000 });
    const manager = createLspProcessManager(makeDeps(spawn, config, (event) => events.push(event)));
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    controllers[0]?.emitError();
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    const crashedAfterRestart = events.filter((e) => e.status === "CRASHED").length;

    // A late, stale exit from the already-superseded first child — must be a no-op.
    controllers[0]?.emitLateExit(1);
    await settle();

    expect(events.filter((e) => e.status === "CRASHED")).toHaveLength(crashedAfterRestart);
    expect(manager.getLspProcessStatus()).toBe("READY");
    // The throttle budget is intact: a second genuine crash still restarts (not throttled).
    controllers[controllers.length - 1]?.emitError();
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    await manager.dispose();
  });

  it("stops at RESTART_THROTTLED once the crash window is exhausted", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["normal"]);
    const config = makeConfig({ maxRestartsInWindow: 1, restartWindowMs: 60_000 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();

    for (let i = 0; i < 4; i += 1) {
      controllers[controllers.length - 1]?.emitError();
      await settle();
    }

    expect(manager.getLspProcessStatus()).toBe("RESTART_THROTTLED");
    await manager.dispose();
  });

  it("disposes pending requests when the final confirmed crash is restart-throttled", async () => {
    const { spawn, controllers } = fakeSpawnHarness([
      "unresponsive-request",
      "unresponsive-request",
    ]);
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(
        spawn,
        makeConfig({
          maxRestartsInWindow: 1,
          restartWindowMs: 60_000,
          requestTimeoutMs: 30_000,
        }),
        (event) => events.push(event),
      ),
    );
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    // Spend the only restart and let the replacement reach READY.
    controllers[0]?.emitError();
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(manager.getChildGeneration()).toBe(2);

    let requestOutcome = "pending";
    const pending = manager.sendRequest<unknown>(
      "textDocument/hover",
      {},
      new AbortController().signal,
    );
    void pending.then(
      () => {
        requestOutcome = "resolved";
      },
      (error: unknown) => {
        requestOutcome = error instanceof Error ? error.message : "unknown-error";
      },
    );

    // No restart remains. The confirmed error → tree-kill → exit path must still dispose this
    // generation's transport instead of leaving the request alive until its long deadline.
    controllers[1]?.emitError();
    await settle();
    const outcomeAfterCrash = requestOutcome;
    const throttled = events.find((event) => event.status === "RESTART_THROTTLED");
    await manager.dispose();

    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
    expect(outcomeAfterCrash).toBe("DISPOSED");
    expect(throttled?.pendingRequestCount).toBe(0);
  });

  // P1-A: before this fix, supervisorOnCrash never cleared state.child on the CRASH path — only
  // disposeManager's NORMAL-disposal path did (F1). Once the restart budget is exhausted the manager
  // is left holding a reference to an already-dead child, and a later dispose() called kill() on that
  // stale handle: on Windows, nodeGroupKill's first act is `taskkill /PID <pid> /T /F`, and Windows
  // recycles pids aggressively, so that call can tear down an unrelated process tree on the customer's
  // machine. The assertion below is on the SIGNAL itself (kill() calls observed on the dead handle),
  // not on an evidence field: a vacuous variant of this class of test asserted only an event value that
  // reads the same with and without the fix on POSIX and passed with the guard removed.
  it("releases a confirmed crashed child so later dispose never re-signals it (P1-A)", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["normal"]);
    const config = makeConfig({ maxRestartsInWindow: 1, restartWindowMs: 60_000 });
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(makeDeps(spawn, config, (event) => events.push(event)));
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    // First confirmed crash termination restarts (budget = 1); the second is throttled.
    for (let i = 0; i < 4; i += 1) {
      controllers[controllers.length - 1]?.emitError();
      await settle();
    }
    expect(manager.getLspProcessStatus()).toBe("RESTART_THROTTLED");

    const deadController = controllers[controllers.length - 1];
    expect(deadController).toBeDefined();
    if (deadController === undefined) throw new Error("controller missing");
    const signalsBeforeDispose = [...deadController.killed()];
    expect(signalsBeforeDispose).toEqual(["SIGKILL"]);
    // The contract on LspLifecycleEvent.childPid ("present only for a current running child... absent
    // after cleanup") applies here too: once the manager gives up restarting, there is no current
    // child, so RESTART_THROTTLED must not carry the dead child's pid either.
    const throttled = events.find((event) => event.status === "RESTART_THROTTLED");
    expect(throttled).toBeDefined();
    if (throttled === undefined) throw new Error("RESTART_THROTTLED event missing");
    expect(Object.hasOwn(throttled, "childPid")).toBe(false);

    await manager.dispose();

    // The manager must never signal an already-dead child a second time.
    expect(deadController.killed()).toEqual(signalsBeforeDispose);
  });

  // P1-B: runInitialize had no generation guard, only a `state.status === "INITIALIZING"` check. A
  // crash DURING initialize disposes the transport, which rejects that generation's pending initialize
  // request — but the rejection settles on a LATER microtask, by which point a restart may already have
  // spawned and begun initializing the NEXT generation (status reads "INITIALIZING" again, just not for
  // the stale call). The stale failure handler then acted on whatever child was current when it finally
  // ran, killing a healthy restart mid-handshake and stranding the manager in INITIALIZE_TIMEOUT with no
  // further restart attempted.
  it("does not let a stale initialize failure from a superseded generation kill the new child (P1-B)", async () => {
    // Generation 1 ("slow") never answers `initialize`, so its request stays pending until crashed.
    // Generation 2 ("normal") answers immediately and should reach READY untouched.
    const { spawn, controllers } = fakeSpawnHarness(["slow", "normal"]);
    const config = makeConfig({ initializeTimeoutMs: 30_000 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();
    expect(manager.getLspProcessStatus()).toBe("INITIALIZING");
    expect(manager.getChildGeneration()).toBe(1);

    // Crashing generation 1 synchronously drives supervisorStart → spawnAndInitialize for generation 2,
    // which disposes generation 1's transport (rejecting its pending initialize call) and transitions to
    // INITIALIZING for generation 2 — all before generation 1's rejection is even observed.
    controllers[0]?.emitError();
    await settle();

    expect(manager.getChildGeneration()).toBe(2);
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(controllers[1]?.killed() ?? []).not.toContain("SIGKILL");
    await manager.dispose();
  });

  it("rejects an oversized response frame without crashing the request path", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["oversized"], 8_000_000);
    const manager = createLspProcessManager(makeDeps(spawn, makeConfig({ maxFrameBytes: 4_096 })));
    await settle();

    // The oversized frame is rejected at the reader; the manager surfaces it as a reader error
    // (CRASHED transition) rather than buffering the body or throwing out of band. READY is impossible
    // here: the oversized fake never returns a valid initialize response, so the manager can only land
    // in CRASHED or (after the restart budget is spent) RESTART_THROTTLED (FIX 5).
    expect(["CRASHED", "RESTART_THROTTLED"]).toContain(manager.getLspProcessStatus());
    expect(controllers.every((controller) => controller.killed().includes("SIGKILL"))).toBe(true);
    await manager.dispose();
  });

  it("escalates to SIGKILL and surfaces DISPOSED when the server never exits", async () => {
    // "unresponsive" ignores both shutdown and exit, so the grace window must elapse and SIGKILL fire.
    const { spawn, controllers } = fakeSpawnHarness(["unresponsive"]);
    const config = makeConfig({ initializeTimeoutMs: 200, shutdownTimeoutMs: 20 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();

    const disposePromise = manager.dispose();
    await settleMs(60);
    await disposePromise;

    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
    expect(controllers[0]?.killed()).toContain("SIGKILL");
  });

  it("keeps disposal ownership after exit when bounded tree termination is unconfirmed", async () => {
    const log = captureServerLog();
    const events: LspLifecycleEvent[] = [];
    const controller = createFakeLspProcess({
      behavior: "unresponsive",
      killResult: {
        treeContainment: "unconfirmed",
        windowsTreeKill: "root-not-found",
      },
    });
    const manager = createLspProcessManager(
      makeDeps(
        () => controller.handle,
        makeConfig({ shutdownTimeoutMs: 5 }),
        (event) => events.push(event),
      ),
    );
    await settle();

    await manager.dispose();

    expect(controller.exitEmitted()).toBe(true);
    expect(controller.killed()).toEqual(["SIGKILL"]);
    expect(events.filter((event) => event.status === "DISPOSED")).toContainEqual(
      expect.objectContaining({ childPid: 4242 }),
    );
    expect(
      findOwnershipLog(log, "retained-unconfirmed", {
        reason: "tree-unconfirmed",
        childPid: 4242,
      }),
    ).toBeDefined();
  });

  it("does not wait the full grace window and still proves tree teardown during dispose", async () => {
    // FIX 2: a well-behaved server answers `shutdown` (so requestGracefulShutdown returns fast) and
    // exits on `exit`. escalateKill's stop-predicate (`() => state.exited`) must observe the exit set
    // BEFORE the disposed early-return in supervisorOnCrash and resolve WITHOUT the SIGKILL fallback,
    // even though shutdownTimeoutMs (the grace window) is large. Before FIX 2 `state.exited` stayed
    // false during dispose, so escalateKill waited the full window and then sent SIGKILL.
    const { spawn, controllers } = fakeSpawnHarness(["normal"]);
    const config = makeConfig({ initializeTimeoutMs: 200, shutdownTimeoutMs: 5_000 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();

    const start = Date.now();
    const disposePromise = manager.dispose();
    await settleMs(20);
    await disposePromise;
    const elapsedMs = Date.now() - start;

    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
    // Resolved well before the 5 s grace window — proves escalateKill saw the prompt exit (FIX 2).
    expect(elapsedMs).toBeLessThan(2_000);
    // Protocol shutdown is followed immediately by a whole-tree SIGKILL while the generation-owned
    // handle is still live; cleanup never relies on the immediate root's graceful exit alone.
    expect(controllers[0]?.killed()).toEqual(["SIGKILL"]);
  });

  it("throws DISPOSED for calls made after dispose", async () => {
    const { spawn } = fakeSpawnHarness(["normal"]);
    const manager = createLspProcessManager(makeDeps(spawn, makeConfig()));
    await settle();
    await manager.dispose();

    await expect(
      manager.sendRequest("textDocument/hover", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "DISPOSED" });
    // A second dispose is a no-op.
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it("transitions to EXECUTABLE_NOT_FOUND on preflight denial without spawning", () => {
    const spawn = vi.fn<LspSpawnFn>();
    const config = makeConfig({ executableName: "rm" });
    const manager = createLspProcessManager({
      config,
      workspace: workspace(),
      processEnv: { PATH: BIN_DIR },
      commandRules: RULES,
      spawn,
    });

    expect(manager.getLspProcessStatus()).toBe("EXECUTABLE_NOT_FOUND");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("transitions to SPAWN_FAILED when the spawn function throws", async () => {
    const throwingSpawn: LspSpawnFn = () => {
      throw new Error("spawn boom");
    };
    const manager = createLspProcessManager({
      config: makeConfig(),
      workspace: workspace(),
      processEnv: { PATH: BIN_DIR },
      commandRules: RULES,
      spawn: throwingSpawn,
      now: () => 1_000,
    });
    await settle();

    expect(manager.getLspProcessStatus()).toBe("SPAWN_FAILED");
    await manager.dispose();
  });

  it("throws CRASHED when sendRequest is called while status is INITIALIZE_TIMEOUT (not READY)", async () => {
    // The "slow" behavior never answers initialize, so the manager ends up in INITIALIZE_TIMEOUT
    // after the timeout fires, but the transport/client exists. Sending a request then must yield
    // CRASHED (the client is undefined-or-not-ready branch of sendRequest, line 301-303).
    const controller = createFakeLspProcess({ behavior: "slow", killConfirmsExit: false });
    const config = makeConfig({ initializeTimeoutMs: 30, requestTimeoutMs: 30 });
    const manager = createLspProcessManager(makeDeps(() => controller.handle, config));
    await settleMs(60);

    expect(manager.getLspProcessStatus()).toBe("INITIALIZE_TIMEOUT");
    await expect(
      manager.sendRequest("textDocument/hover", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CRASHED" });
    await manager.dispose();
  });

  it("maps LspRpcDisposedError from a concurrent dispose to DISPOSED error code", async () => {
    // Drive a request that the server will never answer, then dispose mid-flight so the
    // client's rejectAll fires LspRpcDisposedError — covers the LspRpcDisposedError branch
    // in mapRequestError (line 325-326).
    const silentHandle = silentAfterInitSpawn();
    const config = makeConfig({ requestTimeoutMs: 30_000 });
    const manager = createLspProcessManager(makeDeps(silentHandle.spawn, config));
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    const pending = manager.sendRequest<unknown>(
      "textDocument/hover",
      {},
      new AbortController().signal,
    );
    // Attach the rejection assertion BEFORE disposing. dispose() rejects this in-flight request
    // synchronously inside transport.dispose()'s rejectAll, which lands several microtasks before
    // dispose() resolves; attaching the handler first closes the unhandled-rejection window while
    // still asserting the DISPOSED mapping the caller observes.
    const assertion = expect(pending).rejects.toMatchObject({ code: "DISPOSED" });
    // dispose immediately while the request is in-flight; the client will rejectAll with LspRpcDisposedError
    await manager.dispose();
    await assertion;
  });

  it("maps a generic server RPC error to CRASHED (mapRequestError catch-all, not RESPONSE_TOO_LARGE)", async () => {
    // Build a spawn handle that answers initialize (reaching READY), then replies to subsequent
    // requests with a JSON-RPC error whose `message` field is a non-string object. The JSON-RPC
    // client rejects with a plain `new Error("LSP error")` in that case — none of the typed RPC
    // error subclasses — so mapRequestError's catch-all returns CRASHED. RESPONSE_TOO_LARGE is
    // reserved for an actual frame-size rejection and must NOT mislabel a generic RPC error (FIX 9).
    const config = makeConfig();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    void (async (): Promise<void> => {
      const reader = createLspFrameReader(stdin, 1_048_576);
      try {
        for await (const body of reader) {
          const msg = JSON.parse(body.toString("utf8")) as { id?: number; method?: string };
          if (msg.method === "initialize" && msg.id !== undefined) {
            writeLspFrame(stdout, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          } else if (
            msg.method !== undefined &&
            msg.method !== "initialize" &&
            msg.id !== undefined
          ) {
            // A JSON-RPC error with a non-string `message` field. The client creates a plain Error
            // with the fallback "LSP error" message, which mapRequestError catches as the catch-all.
            writeLspFrame(
              stdout,
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: { nested: "not a string" } },
              }),
            );
          }
        }
      } catch {
        // stream closed
      }
    })();
    const plainErrSpawn: LspSpawnFn = () => ({
      stdin: {
        write: (chunk: Buffer): void => {
          stdin.write(chunk);
        },
      },
      stdout,
      stderr,
      pid: 9999,
      kill: (): void => {
        stdout.end();
      },
      onExit: (): void => undefined,
      onError: (): void => undefined,
    });
    const manager = createLspProcessManager(makeDeps(plainErrSpawn, config));
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");
    // The request gets an RPC error with a non-string message — client rejects with a plain Error.
    // mapRequestError's catch-all returns CRASHED (a generic request/protocol fault), never the
    // frame-size-only RESPONSE_TOO_LARGE.
    await expect(
      manager.sendRequest("textDocument/hover", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CRASHED" });
    await manager.dispose();
  });

  it("classifies a non-timeout initialize failure as INITIALIZE_FAILED error code", async () => {
    // When initialize fails with a non-timeout error (e.g. RPC error response), the error code
    // emitted on the transition should be INITIALIZE_FAILED, not INITIALIZE_TIMEOUT.
    // Use a fake that replies to initialize with an RPC error.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    void (async (): Promise<void> => {
      const reader = createLspFrameReader(stdin, 1_048_576);
      try {
        for await (const body of reader) {
          const msg = JSON.parse(body.toString("utf8")) as { id?: number; method?: string };
          if (msg.method === "initialize" && msg.id !== undefined) {
            writeLspFrame(
              stdout,
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32001, message: "server error during init" },
              }),
            );
          }
        }
      } catch {
        // stream closed
      }
    })();
    const errInitSpawn: LspSpawnFn = () => ({
      stdin: {
        write: (chunk: Buffer): void => {
          stdin.write(chunk);
        },
      },
      stdout,
      stderr,
      pid: 8888,
      kill: (): void => {
        stdout.end();
      },
      onExit: (): void => undefined,
      onError: (): void => undefined,
    });
    const events: LspLifecycleEvent[] = [];
    const config = makeConfig({ initializeTimeoutMs: 500 });
    const manager = createLspProcessManager(
      makeDeps(errInitSpawn, config, (event) => events.push(event)),
    );
    await settle();

    // The manager should have transitioned to INITIALIZE_TIMEOUT state (classifyInitFailure
    // returns "INITIALIZE_FAILED" for non-timeout errors; state transitions to "INITIALIZE_TIMEOUT").
    expect(manager.getLspProcessStatus()).toBe("INITIALIZE_TIMEOUT");
    const initFailEvent = events.find((e) => e.errorCode === "INITIALIZE_FAILED");
    expect(initFailEvent).toBeDefined();
    await manager.dispose();
  });

  it("ignores a stale error callback after confirmed crash restart", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["normal", "normal"]);
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig(), (event) => events.push(event)),
    );
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    const ctrl = controllers[0];
    expect(ctrl).toBeDefined();
    if (ctrl === undefined) throw new Error("controller missing");
    // The first error requests a confirmed tree kill and restart. A repeated callback from that old
    // handle carries a stale generation and must be a no-op.
    ctrl.emitError();
    ctrl.emitError();
    await settle();

    // Only one CRASHED event should exist for the first controller (double crash is guarded).
    const crashedEvents = events.filter((e) => e.status === "CRASHED");
    expect(crashedEvents).toHaveLength(1);
    await manager.dispose();
  });

  it("disposes cleanly when no child was ever spawned (e.g. EXECUTABLE_NOT_FOUND path)", async () => {
    // When preflight fails, child is undefined. Dispose must not call escalateKill.
    // This covers the `if (child !== undefined)` false-branch in disposeManager (line 346-348).
    const spawn = vi.fn<LspSpawnFn>();
    const config = makeConfig({ executableName: "rm" });
    const manager = createLspProcessManager({
      config,
      workspace: workspace(),
      processEnv: { PATH: BIN_DIR },
      commandRules: RULES,
      spawn,
    });

    expect(manager.getLspProcessStatus()).toBe("EXECUTABLE_NOT_FOUND");
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ignores an onCrash from the child after dispose is complete (crash-after-dispose guard)", async () => {
    // After dispose, supervisorOnCrash is called but ctx.state.disposed is true so it returns
    // early. The status must remain DISPOSED after the spurious crash.
    const { spawn, controllers } = fakeSpawnHarness(["ignore-shutdown"]);
    const config = makeConfig({ initializeTimeoutMs: 200, shutdownTimeoutMs: 10 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();

    const disposePromise = manager.dispose();
    await settleMs(30);
    await disposePromise;
    expect(manager.getLspProcessStatus()).toBe("DISPOSED");

    // Crash the child AFTER dispose completed; must not change status.
    controllers[0]?.crash(9);
    await settle();
    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
  });

  it("uses Date.now as the default clock when no now function is provided", async () => {
    // When deps.now is undefined the manager should fall back to Date.now. Verify it still
    // reaches READY without an injected clock.
    const { spawn } = fakeSpawnHarness(["normal"]);
    const deps: LspProcessManagerDeps = {
      config: makeConfig(),
      workspace: workspace(),
      processEnv: { PATH: BIN_DIR },
      commandRules: RULES,
      spawn,
      // intentionally omit `now`
    };
    const manager = createLspProcessManager(deps);
    await settle();

    expect(manager.getLspProcessStatus()).toBe("READY");
    await manager.dispose();
  });

  it("persists an identity-safe active lease before spawn and releases it only after proven teardown", async () => {
    const port = memoryRuntimeStatePort();
    const controller = createFakeLspProcess();
    let snapshotAtSpawn: LspRuntimeStateSnapshot | undefined;
    const manager = createLspProcessManager({
      ...makeDeps(() => {
        snapshotAtSpawn = port.snapshot();
        return controller.handle;
      }, makeConfig()),
      runtimeState: port,
    });
    await settle();

    expect(snapshotAtSpawn).toMatchObject({
      generation: 1,
      leaseState: "active",
      leaseReason: "process-live",
    });
    await manager.dispose();
    expect(port.snapshot()).toMatchObject({ generation: 1, leaseState: "released" });
  });

  it("restores an active lease as a durable quarantine without spawning a replacement", () => {
    const port = memoryRuntimeStatePort({
      state: "ready",
      snapshot: {
        generation: 3,
        leaseState: "active",
        leaseReason: "tree-unconfirmed",
        crashTimestampsMs: [100],
        restartCount: 1,
        updatedAtMs: 200,
      },
    });
    const spawn = vi.fn<LspSpawnFn>();
    const manager = createLspProcessManager({
      ...makeDeps(spawn, makeConfig()),
      runtimeState: port,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(manager.getChildGeneration()).toBe(3);
    expect(manager.getLspProcessStatus()).toBe("CRASHED");
    expect(manager.hasRetainedProcessOwnership()).toBe(true);
  });

  it("restores a saturated restart window and does not spend a replacement spawn", () => {
    const port = memoryRuntimeStatePort({
      state: "ready",
      snapshot: {
        generation: 2,
        leaseState: "released",
        crashTimestampsMs: [900, 950],
        restartCount: 1,
        updatedAtMs: 950,
      },
    });
    const spawn = vi.fn<LspSpawnFn>();
    const manager = createLspProcessManager({
      ...makeDeps(spawn, makeConfig({ maxRestartsInWindow: 1, restartWindowMs: 1_000 })),
      now: () => 1_000,
      runtimeState: port,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(manager.getLspProcessStatus()).toBe("RESTART_THROTTLED");
  });

  it("restarts an unsolicited root exit only when an OS-owned lifetime boundary proves containment", async () => {
    const port = memoryRuntimeStatePort();
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({ treeLifetimeBoundary: "os-owned" });
      controllers.push(controller);
      return controller.handle;
    };
    const manager = createLspProcessManager({
      ...makeDeps(spawn, makeConfig()),
      runtimeState: port,
    });
    await settle();

    controllers[0]?.crash();
    await settle();

    expect(controllers).toHaveLength(2);
    expect(manager.getLspProcessStatus()).toBe("READY");
    expect(port.snapshot()).toMatchObject({ generation: 2, leaseState: "active" });
    await manager.dispose();
  });

  it("persists an unsolicited uncontained root exit and blocks a post-restart manager", async () => {
    const port = memoryRuntimeStatePort();
    const firstController = createFakeLspProcess();
    const first = createLspProcessManager({
      ...makeDeps(() => firstController.handle, makeConfig()),
      runtimeState: port,
    });
    await settle();

    firstController.crash();
    await settle();
    expect(first.getLspProcessStatus()).toBe("CRASHED");
    expect(first.hasRetainedProcessOwnership()).toBe(true);
    expect(port.snapshot()).toMatchObject({
      generation: 1,
      leaseState: "active",
      leaseReason: "tree-unconfirmed",
    });

    const replacementSpawn = vi.fn<LspSpawnFn>();
    const afterRestart = createLspProcessManager({
      ...makeDeps(replacementSpawn, makeConfig()),
      runtimeState: port,
    });
    expect(replacementSpawn).not.toHaveBeenCalled();
    expect(afterRestart.hasRetainedProcessOwnership()).toBe(true);
  });

  it("retains adapter HOME/runtime cleanup when disposal lacks descendant proof", async () => {
    const releaseRuntimeResources = vi.fn();
    const controller = createFakeLspProcess({
      killConfirmsExit: false,
      killResult: { treeContainment: "unconfirmed", windowsTreeKill: "failed" },
      releaseRuntimeResources,
    });
    const manager = createLspProcessManager(
      makeDeps(() => controller.handle, makeConfig({ shutdownTimeoutMs: 5 })),
    );
    await settle();

    await manager.dispose();
    controller.confirmExit();
    await settle();

    expect(manager.hasRetainedProcessOwnership()).toBe(true);
    expect(releaseRuntimeResources).not.toHaveBeenCalled();
  });
});
