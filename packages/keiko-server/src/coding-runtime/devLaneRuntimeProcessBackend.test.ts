import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeGatewayConfinement } from "@oscharko-dev/keiko-sandbox";
import { createBufferedServerLogSink } from "../observability/index.js";

import {
  createDevLaneRuntimeProcessBackend,
  type DevLaneRuntimeChildProcess,
  type DevLaneRuntimeSpawn,
} from "./devLaneRuntimeProcessBackend.js";
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";

const IDENTITY = { platform: "darwin", arch: "arm64", backend: "macos-app-sandbox" } as const;

const roots: string[] = [];

interface FakeChild extends DevLaneRuntimeChildProcess {
  readonly emitter: EventEmitter;
  readonly kills: NodeJS.Signals[];
  /** Marks the synchronous exit fact without dispatching the async exit event. */
  reapWithoutEvent(): void;
  settle(code: number | null): void;
}

function fakeChild(pid: number | undefined): FakeChild {
  const emitter = new EventEmitter();
  const kills: NodeJS.Signals[] = [];
  let reaped = false;
  return {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    emitter,
    kills,
    settled: (): boolean => reaped,
    kill: (signal): boolean => {
      kills.push(signal);
      return true;
    },
    onExit: (listener): void => {
      emitter.once("exit", listener);
    },
    onError: (listener): void => {
      emitter.once("error", listener);
    },
    reapWithoutEvent: (): void => {
      reaped = true;
    },
    settle: (code): void => {
      reaped = true;
      emitter.emit("exit", code);
    },
  };
}

interface Fixture {
  readonly runtimeRoot: string;
  readonly executable: string;
  readonly cwd: string;
  readonly outside: string;
}

function stageFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-lane-backend-")));
  roots.push(root);
  const runtimeRoot = join(root, "payload");
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
  const executable = join(runtimeRoot, "bin", "opencode");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const outside = join(root, "outside");
  writeFileSync(outside, "#!/bin/sh\nexit 0\n");
  chmodSync(outside, 0o755);
  return { runtimeRoot, executable, cwd, outside };
}

function gatewayConfinement(): ReturnType<typeof createRuntimeGatewayConfinement> {
  return createRuntimeGatewayConfinement({
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    runId: "run-2475",
    treeBindingId: "f".repeat(64),
    envelopeDigest: "a".repeat(64),
    runtimeArtifactDigest: "b".repeat(64),
    modelProfileDigest: "c".repeat(64),
  });
}

function launchRequest(fixture: Fixture, executable?: string): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-2475",
    recoveryHandle: "0".repeat(32),
    treeBindingId: "f".repeat(64),
    executable: executable ?? fixture.executable,
    args: ["serve"],
    cwd: fixture.cwd,
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
    qualification: { ...IDENTITY, releaseReceipt: `sha256:${"0".repeat(64)}` },
    launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dev-lane runtime process backend", () => {
  it("does not mistake a live child's error event for a completed process tree", async () => {
    const fixture = stageFixture();
    const child = fakeChild(4711);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: fixture.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      spawnRuntime: () => child,
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    child.emitter.emit("error", new Error("failed signal"));
    await expect(backend.reconcileTreeExit(tree)).resolves.toBe(false);
    child.settle(0);
    await expect(backend.reconcileTreeExit(tree)).resolves.toBe(true);
  });

  it.each(["runId", "treeBindingId"] as const)(
    "rejects %s drift before spawn with body-free evidence",
    (key) => {
      const fixture = stageFixture();
      const activityLog = createBufferedServerLogSink();
      let spawns = 0;
      const backend = createDevLaneRuntimeProcessBackend({
        identity: IDENTITY,
        runtimeRoot: fixture.runtimeRoot,
        gatewayConfinement: gatewayConfinement(),
        activityLog,
        spawnRuntime: () => {
          spawns += 1;
          return fakeChild(4711);
        },
      });
      const request = { ...launchRequest(fixture), [key]: "different" };
      expect(() => backend.spawnOwnedTree(request)).toThrow("runtime-gateway-confinement-drift");
      expect(spawns).toBe(0);
      expect(activityLog.events).toContainEqual(
        expect.objectContaining({
          op: "runtime.confinement.failed",
          correlationId: request.runId,
          errorKind: "Error",
        }),
      );
      expect(JSON.stringify(activityLog.events)).not.toContain(fixture.runtimeRoot);
    },
  );

  it("refuses a missing gateway confinement before spawning a sidecar (#2951)", () => {
    const fixture = stageFixture();
    const activityLog = createBufferedServerLogSink();
    let spawns = 0;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: fixture.runtimeRoot,
      activityLog,
      spawnRuntime: () => {
        spawns += 1;
        return fakeChild(4711);
      },
      killProcessGroup: () => undefined,
    });
    expect(() => backend.spawnOwnedTree(launchRequest(fixture))).toThrow(
      "runtime-gateway-confinement-required",
    );
    expect(Array.isArray(activityLog.events[0]?.extra?.frames)).toBe(true);
    expect(Array.isArray(activityLog.events[0]?.extra?.causeChain)).toBe(true);
    expect(spawns).toBe(0);
  });

  it("spawns a detached child from inside the runtime root and reports its exit", async () => {
    const fixture = stageFixture();
    const spawned: {
      executable: string;
      args: readonly string[];
      options: Parameters<DevLaneRuntimeSpawn>[2];
    }[] = [];
    const child = fakeChild(4711);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: (executable, args, options) => {
        spawned.push({ executable, args, options });
        return child;
      },
      killProcessGroup: () => undefined,
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.executable).toBe("/usr/bin/sandbox-exec");
    expect(spawned[0]?.args.slice(2)).toEqual([fixture.executable, "serve"]);
    expect(spawned[0]?.args[1]).toContain('(remote tcp4 "localhost:1983")');
    expect(spawned[0]?.options.detached).toBe(true);
    expect(spawned[0]?.options.shell).toBe(false);
    await expect(backend.reconcileTreeExit(tree)).resolves.toBe(false);
    const wait = backend.waitForCompleteTreeExit(tree, 5_000);
    child.settle(0);
    await expect(wait).resolves.toBe(true);
    await expect(backend.reconcileTreeExit(tree)).resolves.toBe(true);
    let observed: number | null | undefined;
    tree.onTreeExit((code) => {
      observed = code;
    });
    expect(observed).toBe(0);
  });

  it("refuses executables outside the runtime root and unsafe paths, fail closed", () => {
    const fixture = stageFixture();
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: () => fakeChild(1),
      killProcessGroup: () => undefined,
    });
    expect(() => backend.spawnOwnedTree(launchRequest(fixture, fixture.outside))).toThrow();
    expect(() =>
      backend.spawnOwnedTree(launchRequest(fixture, join(fixture.runtimeRoot, "missing"))),
    ).toThrow();
  });

  it("terminates the whole process group, falling back to the direct child", () => {
    const fixture = stageFixture();
    const groupKills: { pid: number; signal: NodeJS.Signals }[] = [];
    const child = fakeChild(4711);
    let groupKillFails = false;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: () => child,
      killProcessGroup: (pid, signal) => {
        if (groupKillFails) throw new Error("ESRCH");
        groupKills.push({ pid, signal });
      },
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    backend.signalTree(tree, "graceful");
    backend.signalTree(tree, "force");
    expect(groupKills).toEqual([
      { pid: 4711, signal: "SIGTERM" },
      { pid: 4711, signal: "SIGKILL" },
    ]);
    expect(child.kills).toEqual([]);
    groupKillFails = true;
    backend.signalTree(tree, "force");
    expect(child.kills).toEqual(["SIGKILL"]);
    child.settle(null);
    backend.signalTree(tree, "force");
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  // Gitar finding (#2475 review): once the OS has reaped the child its process-group id may be
  // reused; the synchronous exit fact must suppress every signal even before Node dispatches
  // the async exit event.
  it("never signals a group whose leader is already reaped but not yet event-dispatched", () => {
    const fixture = stageFixture();
    const child = fakeChild(4711);
    const groupKills: NodeJS.Signals[] = [];
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: () => child,
      killProcessGroup: (_pid, signal) => {
        groupKills.push(signal);
      },
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    child.reapWithoutEvent();
    backend.signalTree(tree, "force");
    backend.signalTree(tree, "graceful");
    expect(groupKills).toEqual([]);
    expect(child.kills).toEqual([]);
  });

  it("signals the direct child when the platform reports no pid", () => {
    const fixture = stageFixture();
    const child = fakeChild(undefined);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: () => child,
      killProcessGroup: () => {
        throw new Error("group-kill-must-not-run");
      },
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    backend.signalTree(tree, "graceful");
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("rejects trees it does not own", () => {
    const fixture = stageFixture();
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: () => fakeChild(1),
      killProcessGroup: () => undefined,
    });
    const foreign = {
      treeId: "foreign",
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onTreeExit: (): void => undefined,
    };
    expect(() => {
      backend.signalTree(foreign, "force");
    }).toThrow("dev-lane-runtime-tree-not-owned");
    expect(() => backend.reconcileTreeExit(foreign)).toThrow("dev-lane-runtime-tree-not-owned");
  });

  it("times out honestly when the child never exits", async () => {
    const fixture = stageFixture();
    const child = fakeChild(1);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: () => child,
      killProcessGroup: () => undefined,
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    await expect(backend.waitForCompleteTreeExit(tree, 10)).resolves.toBe(false);
  });

  it.skipIf(process.platform === "win32")("spawns and reaps a real process group", async () => {
    const fixture = stageFixture();
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    await expect(backend.waitForCompleteTreeExit(tree, 10_000)).resolves.toBe(true);
    await expect(backend.reconcileTreeExit(tree)).resolves.toBe(true);
  });
});
