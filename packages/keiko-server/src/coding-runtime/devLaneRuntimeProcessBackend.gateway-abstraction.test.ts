// #2951: devLaneRuntimeProcessBackend.ts now spawns through keiko-sandbox's shared
// planIsolatedRun/selectGatewayBackend core instead of calling buildRuntimeGatewaySeatbeltCommand
// directly, so a host with no confining backend fails the launch closed rather than spawning the
// hardcoded seatbelt path unconditionally. This file is new (not an edit to the existing suite) per
// the write-scope split for this change.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeGatewayConfinement,
  LINUX_GATEWAY_DIAGNOSTIC_FD_ENV,
  type BackendAvailability,
} from "@oscharko-dev/keiko-sandbox";
import { createBufferedServerLogSink } from "../observability/index.js";

import {
  createDevLaneRuntimeProcessBackend,
  type DevLaneRuntimeChildProcess,
} from "./devLaneRuntimeProcessBackend.js";
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";

const spawnMock = vi.hoisted(() => vi.fn<typeof spawn>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

const IDENTITY = { platform: "darwin", arch: "arm64", backend: "macos-app-sandbox" } as const;
const LINUX_IDENTITY = {
  platform: "linux",
  arch: "x64",
  backend: "linux-namespace-gateway",
} as const;
const RELEASE_RECEIPT = `sha256:${"0".repeat(64)}`;
const ALL: BackendAvailability = {
  bubblewrap: true,
  unshare: true,
  seatbelt: true,
  docker: true,
  podman: true,
};
const ATTESTED_GIT = { path: "/qualified/apple/git", sha256: "d".repeat(64) } as const;
const NONE: BackendAvailability = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};

const roots: string[] = [];
beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly runtimeRoot: string;
  readonly executable: string;
  readonly cwd: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-dev-lane-gateway-abstraction-"));
  roots.push(root);
  const runtimeRoot = join(root, "payload");
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
  const executable = join(runtimeRoot, "bin", "opencode");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { runtimeRoot, executable, cwd };
}

function gatewayConfinement(): ReturnType<typeof createRuntimeGatewayConfinement> {
  return createRuntimeGatewayConfinement({
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    runId: "run-2951",
    treeBindingId: "f".repeat(64),
    envelopeDigest: "a".repeat(64),
    runtimeArtifactDigest: "b".repeat(64),
    modelProfileDigest: "c".repeat(64),
  });
}

function launchRequest(
  paths: ReturnType<typeof fixture>,
  identity: typeof IDENTITY | typeof LINUX_IDENTITY = IDENTITY,
): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-2951",
    recoveryHandle: "0".repeat(32),
    treeBindingId: "f".repeat(64),
    executable: paths.executable,
    args: ["serve"],
    cwd: paths.cwd,
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
    qualification: { ...identity, releaseReceipt: RELEASE_RECEIPT },
    launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
  };
}

function fakeChild(launcherDiagnostics?: PassThrough): DevLaneRuntimeChildProcess {
  return {
    pid: 4711,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    ...(launcherDiagnostics === undefined ? {} : { launcherDiagnostics }),
    settled: (): boolean => false,
    kill: (): boolean => true,
    onExit: (): void => {
      // Never settles in these tests: the fail-closed cases assert on the throw, not on exit.
    },
    onError: (): void => {
      // Never invoked in these tests; present only to satisfy the DevLaneRuntimeChildProcess shape.
    },
  };
}

interface SpawnedChildControl {
  readonly child: ChildProcess;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  readonly diagnostics: PassThrough | null;
  readonly kill: ReturnType<typeof vi.fn>;
}

function spawnedChild(
  options: {
    readonly stdout?: boolean;
    readonly stderr?: boolean;
    readonly diagnostics?: boolean;
    readonly pid?: number | undefined;
  } = {},
): SpawnedChildControl {
  const child = new EventEmitter() as ChildProcess;
  const stdout = options.stdout === false ? null : new PassThrough();
  const stderr = options.stderr === false ? null : new PassThrough();
  const diagnostics = options.diagnostics === true ? new PassThrough() : null;
  const kill = vi.fn(() => true);
  Object.assign(child, {
    pid: options.pid,
    stdout,
    stderr,
    stdio: [null, stdout, stderr, diagnostics],
    exitCode: null,
    signalCode: null,
    kill,
  });
  return { child, stdout, stderr, diagnostics, kill };
}

function requireSpawnOptions(value: unknown): SpawnOptions {
  if (typeof value !== "object" || value === null) throw new Error("spawn-options-unavailable");
  return value;
}

describe("dev-lane backend consumes the shared gateway plan/backend abstraction", () => {
  it("selects the seatbelt-wrapped gateway plan and spawns it when the host can enforce it", () => {
    const paths = fixture();
    let spawned: { readonly command: string; readonly args: readonly string[] } | undefined;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "darwin",
      resolveGitExecutable: () => ATTESTED_GIT,
      spawnRuntime: (command, args) => {
        spawned = { command, args };
        return fakeChild();
      },
    });

    backend.spawnOwnedTree(launchRequest(paths));

    expect(spawned?.command).toBe("/usr/bin/sandbox-exec");
    expect(spawned?.args[1]).toContain('(remote tcp4 "localhost:1983")');
  });

  it("fails closed before spawn when the exact Git launcher cannot be attested", () => {
    const paths = fixture();
    let spawns = 0;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "darwin",
      resolveGitExecutable: () => {
        throw new Error("runtime-gateway-git-untrusted");
      },
      spawnRuntime: () => {
        spawns += 1;
        return fakeChild();
      },
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths))).toThrow(
      "runtime-gateway-git-untrusted",
    );
    expect(spawns).toBe(0);
  });

  // Failing-before: before this change, spawnConfinedTree always built the wrapper directly and
  // spawned it, with no notion of "this host cannot enforce it" at all — a missing backend would
  // only surface as an OS-level ENOENT from the child process, not a reasoned, pre-spawn refusal.
  it("fails closed and never spawns when no backend on the host can enforce the gateway policy", () => {
    const paths = fixture();
    const activityLog = createBufferedServerLogSink();
    let spawns = 0;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => NONE,
      platform: "darwin",
      resolveGitExecutable: () => ATTESTED_GIT,
      activityLog,
      spawnRuntime: () => {
        spawns += 1;
        return fakeChild();
      },
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths))).toThrow(
      "runtime-gateway-confinement-unavailable",
    );
    expect(spawns).toBe(0);
    expect(activityLog.events).toContainEqual({
      category: "process",
      level: "info",
      op: "runtime.confinement.unavailable",
      correlationId: "run-2951",
      extra: IDENTITY,
    });
    expect(activityLog.events.some((event) => event.op === "runtime.confinement.failed")).toBe(
      false,
    );
  });

  it("rejects a mismatched host/backend identity before any weaker run", () => {
    const paths = fixture();
    let spawns = 0;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "win32",
      resolveGitExecutable: () => ATTESTED_GIT,
      spawnRuntime: () => {
        spawns += 1;
        return fakeChild();
      },
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths))).toThrow(
      "runtime-gateway-platform-identity-drift",
    );
    expect(spawns).toBe(0);
  });

  it("records trusted Linux launcher failures without accepting sidecar stderr as evidence", () => {
    const paths = fixture();
    const activityLog = createBufferedServerLogSink();
    const launcherDiagnostics = new PassThrough();
    const child = fakeChild(launcherDiagnostics);
    const sidecarStderr = child.stderr as PassThrough;
    let diagnosticsRequested = false;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: LINUX_IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "linux",
      resolveGitExecutable: () => ATTESTED_GIT,
      activityLog,
      spawnRuntime: (_command, _args, options) => {
        diagnosticsRequested = options.launcherDiagnostics;
        return child;
      },
    });

    backend.spawnOwnedTree(launchRequest(paths, LINUX_IDENTITY));
    sidecarStderr.write("keiko-linux-gateway:error:cleanup-failed\n");
    expect(activityLog.events.filter((event) => event.op === "runtime.confinement.failed")).toEqual(
      [],
    );

    launcherDiagnostics.write("keiko-linux-gateway:error:host-relay-failed\n");
    expect(diagnosticsRequested).toBe(true);
    expect(activityLog.events).toContainEqual({
      category: "process",
      level: "error",
      op: "runtime.confinement.failed",
      correlationId: "run-2951",
      errorKind: "host-relay-failed",
      extra: {
        backend: "bubblewrap",
        diagnosticSource: "linux-gateway-launcher",
        frames: [],
        causeChain: [],
      },
    });
  });

  it("kills and refuses a Linux wrapper whose private diagnostic channel is missing", () => {
    const paths = fixture();
    const child = fakeChild();
    const kills: NodeJS.Signals[] = [];
    const backend = createDevLaneRuntimeProcessBackend({
      identity: LINUX_IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "linux",
      resolveGitExecutable: () => ATTESTED_GIT,
      activityLog: createBufferedServerLogSink(),
      spawnRuntime: () => ({
        ...child,
        kill: (signal): boolean => {
          kills.push(signal);
          return true;
        },
      }),
      killProcessGroup: () => {
        throw new Error("group-kill-unavailable");
      },
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths, LINUX_IDENTITY))).toThrow(
      "linux-gateway-diagnostics-unavailable",
    );
    expect(kills).toEqual(["SIGKILL"]);
  });

  it("uses the production spawn adapter with a private Linux diagnostic pipe", () => {
    const paths = fixture();
    const activityLog = createBufferedServerLogSink();
    const control = spawnedChild({ diagnostics: true });
    spawnMock.mockReturnValue(control.child);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: LINUX_IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "linux",
      resolveGitExecutable: () => ATTESTED_GIT,
      activityLog,
    });

    const tree = backend.spawnOwnedTree(launchRequest(paths, LINUX_IDENTITY));
    const options = requireSpawnOptions(spawnMock.mock.calls[0]?.[2]);
    expect(options.detached).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe", "pipe"]);
    expect(options.env?.[LINUX_GATEWAY_DIAGNOSTIC_FD_ENV]).toBe("3");
    control.diagnostics?.write("keiko-linux-gateway:error:host-relay-failed\n");
    expect(activityLog.events).toContainEqual(
      expect.objectContaining({
        op: "runtime.confinement.failed",
        errorKind: "host-relay-failed",
      }),
    );
    control.diagnostics?.emit("end");
    control.diagnostics?.emit("error", new Error("late-diagnostic-error"));
    expect(
      activityLog.events.filter((event) => event.op === "runtime.confinement.failed"),
    ).toHaveLength(1);
    backend.signalTree(tree, "force");
    expect(control.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("uses the production spawn adapter without a diagnostic pipe for seatbelt", () => {
    const paths = fixture();
    const control = spawnedChild({ pid: 4711 });
    spawnMock.mockReturnValue(control.child);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "darwin",
      resolveGitExecutable: () => ATTESTED_GIT,
    });

    backend.spawnOwnedTree(launchRequest(paths));
    const options = requireSpawnOptions(spawnMock.mock.calls[0]?.[2]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env?.[LINUX_GATEWAY_DIAGNOSTIC_FD_ENV]).toBeUndefined();
  });

  it.each([
    ["stdout", { stdout: false }],
    ["stderr", { stderr: false }],
  ] as const)("fails closed when the production adapter has no %s pipe", (_name, childOptions) => {
    const paths = fixture();
    spawnMock.mockReturnValue(spawnedChild(childOptions).child);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "darwin",
      resolveGitExecutable: () => ATTESTED_GIT,
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths))).toThrow(
      "dev-lane-runtime-pipes-unavailable",
    );
  });

  it("fails closed when the production adapter has no readable diagnostic pipe", () => {
    const paths = fixture();
    spawnMock.mockReturnValue(spawnedChild().child);
    const backend = createDevLaneRuntimeProcessBackend({
      identity: LINUX_IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "linux",
      resolveGitExecutable: () => ATTESTED_GIT,
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths, LINUX_IDENTITY))).toThrow(
      "linux-gateway-diagnostics-unavailable",
    );
  });
});
