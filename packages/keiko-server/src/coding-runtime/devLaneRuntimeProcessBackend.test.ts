import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

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
  settle(code: number | null): void;
}

function fakeChild(pid: number | undefined): FakeChild {
  const emitter = new EventEmitter();
  const kills: NodeJS.Signals[] = [];
  return {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    emitter,
    kills,
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
    settle: (code): void => {
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
  it("spawns a detached child from inside the runtime root and reports its exit", async () => {
    const fixture = stageFixture();
    const spawned: { executable: string; options: Parameters<DevLaneRuntimeSpawn>[2] }[] = [];
    const child = fakeChild(4711);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: fixture.runtimeRoot,
      spawnRuntime: (executable, _args, options) => {
        spawned.push({ executable, options });
        return child;
      },
      killProcessGroup: () => undefined,
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.executable).toBe(fixture.executable);
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

  it("signals the direct child when the platform reports no pid", () => {
    const fixture = stageFixture();
    const child = fakeChild(undefined);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
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
      runtimeRoot: fixture.runtimeRoot,
    });
    const tree = backend.spawnOwnedTree(launchRequest(fixture));
    await expect(backend.waitForCompleteTreeExit(tree, 10_000)).resolves.toBe(true);
    await expect(backend.reconcileTreeExit(tree)).resolves.toBe(true);
  });
});
