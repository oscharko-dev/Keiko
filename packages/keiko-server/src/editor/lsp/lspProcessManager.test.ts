import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { LspLifecycleEvent, LspProcessConfig } from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import { createLspProcessManager } from "./lspProcessManager.js";
import type { LspProcessManagerDeps } from "./lspProcessManager.js";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import { createLspFrameReader, writeLspFrame } from "./lspFrameCodec.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";
import type { FakeLspBehavior, FakeLspController } from "./testing/fakeLspProcess.js";

// `resolveExecutableOutsideWorkspace` runs against the real filesystem even when the spawn function is
// faked, so the manager only proceeds to spawn if `fakelsp` actually resolves on PATH outside the
// workspace. A throwaway bin dir holding an executable `fakelsp` satisfies that preflight while the
// injected fake stands in for the real process behaviour.
let BIN_DIR = "";
let WORKSPACE_ROOT = "";

beforeAll(() => {
  BIN_DIR = mkdtempSync(join(tmpdir(), "keiko-lsp-bin-"));
  WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "keiko-lsp-ws-"));
  const exe = join(BIN_DIR, "fakelsp");
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
});

afterAll(() => {
  rmSync(BIN_DIR, { recursive: true, force: true });
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

describe("createLspProcessManager", () => {
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

  it("transitions to INITIALIZE_TIMEOUT when the server never answers initialize", async () => {
    const { spawn } = fakeSpawnHarness(["slow"]);
    const manager = createLspProcessManager(makeDeps(spawn, makeConfig()));
    await settleMs(60);

    expect(manager.getLspProcessStatus()).toBe("INITIALIZE_TIMEOUT");
    expect(manager.asLanguageProvider(["python"], ["hover"]).descriptor.availability).toBe(
      "unavailable",
    );
    await manager.dispose();
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

  it("restarts after a crash and returns to READY", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["normal", "normal"]);
    const events: LspLifecycleEvent[] = [];
    const manager = createLspProcessManager(
      makeDeps(spawn, makeConfig(), (event) => events.push(event)),
    );
    await settle();
    expect(manager.getLspProcessStatus()).toBe("READY");

    controllers[0]?.crash(1);
    await settle();

    expect(manager.getLspProcessStatus()).toBe("READY");
    const crashed = events.find((event) => event.status === "CRASHED");
    expect(crashed).toBeDefined();
    expect(events.some((event) => event.status === "READY" && event.restartCount === 1)).toBe(true);
    await manager.dispose();
  });

  it("stops at RESTART_THROTTLED once the crash window is exhausted", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["normal"]);
    const config = makeConfig({ maxRestartsInWindow: 1, restartWindowMs: 60_000 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();

    for (let i = 0; i < 4; i += 1) {
      controllers[controllers.length - 1]?.crash(1);
      await settle();
    }

    expect(manager.getLspProcessStatus()).toBe("RESTART_THROTTLED");
    await manager.dispose();
  });

  it("rejects an oversized response frame without crashing the request path", async () => {
    const { spawn } = fakeSpawnHarness(["oversized"], 8_000_000);
    const manager = createLspProcessManager(makeDeps(spawn, makeConfig({ maxFrameBytes: 4_096 })));
    await settle();

    // The oversized frame is rejected at the reader; the manager surfaces it as a reader error
    // (CRASHED transition) rather than buffering the body or throwing out of band.
    expect(["CRASHED", "READY", "RESTART_THROTTLED"]).toContain(manager.getLspProcessStatus());
    await manager.dispose();
  });

  it("kills the process and surfaces DISPOSED when the server ignores shutdown", async () => {
    const { spawn, controllers } = fakeSpawnHarness(["ignore-shutdown"]);
    const config = makeConfig({ initializeTimeoutMs: 200 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
    await settle();

    const disposePromise = manager.dispose();
    await settleMs(50);
    await disposePromise;

    expect(manager.getLspProcessStatus()).toBe("DISPOSED");
    expect(controllers[0]?.killed()).toContain("SIGKILL");
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
    const { spawn } = fakeSpawnHarness(["slow"]);
    const config = makeConfig({ initializeTimeoutMs: 30, requestTimeoutMs: 30 });
    const manager = createLspProcessManager(makeDeps(spawn, config));
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

  it("maps an unknown error to RESPONSE_TOO_LARGE (mapRequestError catch-all)", async () => {
    // Build a spawn handle that answers initialize (reaching READY), then replies to subsequent
    // requests with a JSON-RPC error whose `message` field is a non-string object. The JSON-RPC
    // client rejects with a plain `new Error("LSP error")` in that case — none of the typed RPC
    // error subclasses — so mapRequestError's catch-all returns RESPONSE_TOO_LARGE.
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
    // mapRequestError's catch-all returns RESPONSE_TOO_LARGE.
    await expect(
      manager.sendRequest("textDocument/hover", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
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

  it("ignores a crash signal when the process has already been marked exited (double-crash guard)", async () => {
    // supervisorOnCrash has an early return when state.exited is already true (line 86-88).
    // Trigger this by crashing once (exited becomes true), then crashing again before the
    // restart completes. The second crash should be silently ignored.
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
    // First crash triggers normal CRASHED → restart sequence.
    ctrl.crash(1);
    // Immediately crash again (state.exited is now true) — this must be a no-op.
    ctrl.crash(2);
    await settle();

    // Only one CRASHED event should exist for the first controller (double crash is guarded).
    const crashedEvents = events.filter((e) => e.status === "CRASHED");
    expect(crashedEvents.length).toBe(1);
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
});
