import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeGatewayConfinement,
  currentPlatform,
  probeBackends,
} from "@oscharko-dev/keiko-sandbox";
import { createBufferedServerLogSink } from "../observability/index.js";

import {
  createDevLaneRuntimeProcessBackend,
  type DevLaneRuntimeChildProcess,
  type DevLaneRuntimeSpawn,
} from "./devLaneRuntimeProcessBackend.js";
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  type RuntimeProcessTree,
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

  // The activity line exposes the bounded child-executable policy without logging either path.
  it("records the runtime-and-Apple-git executable boundary (#3390)", () => {
    const fixture = stageFixture();
    const activityLog = createBufferedServerLogSink();
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      gatewayConfinement: gatewayConfinement(),
      runtimeRoot: fixture.runtimeRoot,
      activityLog,
      spawnRuntime: () => fakeChild(4711),
      killProcessGroup: () => undefined,
    });
    backend.spawnOwnedTree(launchRequest(fixture));
    expect(activityLog.events).toContainEqual(
      expect.objectContaining({
        category: "process",
        op: "runtime.confinement.spawned",
        correlationId: "run-2475",
        extra: expect.objectContaining({
          profile: "keiko-gateway",
          childExecutablePolicy: "runtime-and-apple-git-only",
        }) as unknown,
      }),
    );
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

// LIVE OS-level proof through the production backend (#2951). runtime-gateway.test.ts proves the
// wrapper builder in isolation; this proves createDevLaneRuntimeProcessBackend's real
// spawnOwnedTree path actually applies it when spawning a real process, not only that it exits 0.
// Both destinations are real, listening loopback servers on ephemeral ports -- never the internet.
// It self-skips with a loud, recorded closed reason (never a silent green) off macOS or without
// sandbox-exec on PATH.
// Use the real interpreter installation as the read-only runtime payload. A script shebang
// would require a second executable and be denied before the network probe; copying Homebrew
// Node alone also loses its relative shared-library dependencies. The workspace stays temporary.
function connectProbeScript(): string {
  return [
    "const net = require('net');",
    "const port = parseInt(process.argv[1], 10);",
    "const s = net.connect({ host: '127.0.0.1', port });",
    "s.setTimeout(3000);",
    "s.on('connect', () => { process.stdout.write('CONNECTED'); s.destroy(); process.exit(0); });",
    "s.on('error', () => { process.stdout.write('BLOCKED'); process.exit(3); });",
    "s.on('timeout', () => { process.stdout.write('TIMEOUT'); s.destroy(); process.exit(3); });",
    "",
  ].join("\n");
}

function stageProbeFixture(): Fixture {
  const fixture = stageFixture();
  const executable = realpathSync(process.execPath);
  return { ...fixture, executable, runtimeRoot: dirname(executable) };
}

async function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ephemeral-listen-failed"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

// Waits on the stdout pipe's own "end" (EOF), not the process "exit" event: exit can fire before
// the last buffered chunk is delivered to a listener, which would otherwise race an empty read.
function collectStdout(tree: RuntimeProcessTree): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    tree.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    tree.stdout.on("end", () => {
      resolve(out);
    });
  });
}

describe("real OS-level gateway confinement through the production backend (#2951)", () => {
  const canProveOnThisHost = currentPlatform() === "darwin" && probeBackends().seatbelt;

  it.skipIf(!canProveOnThisHost)(
    "denies a hostile loopback destination while permitting the gateway port via spawnOwnedTree",
    async () => {
      const fixture = stageProbeFixture();
      const gateway = await listenEphemeral();
      const hostile = await listenEphemeral();
      try {
        const backend = createDevLaneRuntimeProcessBackend({
          identity: IDENTITY,
          runtimeRoot: fixture.runtimeRoot,
          gatewayConfinement: createRuntimeGatewayConfinement({
            gatewayUrl: `http://127.0.0.1:${String(gateway.port)}/gateway`,
            runId: "run-2951-os",
            treeBindingId: "f".repeat(64),
            envelopeDigest: "a".repeat(64),
            runtimeArtifactDigest: "b".repeat(64),
            modelProfileDigest: "c".repeat(64),
          }),
        });
        const deniedTree = backend.spawnOwnedTree({
          ...launchRequest(fixture),
          runId: "run-2951-os",
          args: ["-e", connectProbeScript(), String(hostile.port)],
        });
        expect(["BLOCKED", "TIMEOUT"]).toContain(await collectStdout(deniedTree));

        const allowedTree = backend.spawnOwnedTree({
          ...launchRequest(fixture),
          runId: "run-2951-os",
          args: ["-e", connectProbeScript(), String(gateway.port)],
        });
        expect(await collectStdout(allowedTree)).toBe("CONNECTED");
      } finally {
        gateway.server.close();
        hostile.server.close();
      }
    },
    20_000,
  );

  it("records a closed skip reason when the real OS proof cannot run on this host", () => {
    if (canProveOnThisHost) {
      expect(canProveOnThisHost).toBe(true);
      return;
    }
    const reason =
      currentPlatform() !== "darwin"
        ? `non-darwin platform (${currentPlatform()})`
        : "sandbox-exec is not on PATH";
    process.stderr.write(
      `[gateway-confinement-proof] skipped: ${reason}. The real seatbelt OS-level proof runs on ` +
        "macOS hosts only (ADR-0043/ADR-0140 macOS-only scope; Linux/Windows tracked separately).\n",
    );
    expect(canProveOnThisHost).toBe(false);
  });
});
