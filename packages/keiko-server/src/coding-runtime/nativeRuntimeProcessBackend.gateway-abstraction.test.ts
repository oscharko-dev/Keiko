// #2951: nativeRuntimeProcessBackend.ts (the Windows Job Object / native-helper backend) has no OS
// primitive that can bind its launch-packet protocol to a single loopback destination. A caller
// that attaches a gateway-allowlist confinement policy must get a closed refusal, never an
// unconfined spawn. New file (not an edit to the existing suite) per the write-scope split.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeGatewayConfinement,
  buildRuntimeGatewaySeatbeltCommand,
  GATEWAY_UNSUPPORTED_ON_HOST_REASON,
  type RuntimeGatewayFilesystem,
} from "@oscharko-dev/keiko-sandbox";

import {
  createNativeRuntimeProcessBackend,
  type NativeRuntimeHelperProcess,
  type NativeRuntimeHelperSpawn,
} from "./nativeRuntimeProcessBackend.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";
import { planLongLivedRuntimeSandbox } from "@oscharko-dev/keiko-sandbox";
import { encodeLaunchPacket } from "./nativeRuntimeProcessProtocol.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeHelper extends EventEmitter implements NativeRuntimeHelperProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly controlInput = new PassThrough();
  public readonly controlOutput = new PassThrough();

  public onExit(listener: (code: number | null) => void): void {
    this.once("exit", listener);
  }

  public onError(listener: () => void): void {
    this.once("error", listener);
  }
}

function fixture(): {
  readonly helper: string;
  readonly runtime: string;
  readonly workspace: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-backend-gateway-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const workspace = join(root, "workspace");
  mkdirSync(runtimeRoot);
  mkdirSync(workspace);
  const helper = join(root, "keiko-runtime-supervisor.exe");
  const runtime = join(runtimeRoot, "runtime.exe");
  writeFileSync(helper, "helper");
  writeFileSync(runtime, "runtime");
  return { helper, runtime, workspace };
}

function gatewayConfinement(
  filesystem?: RuntimeGatewayFilesystem,
): ReturnType<typeof createRuntimeGatewayConfinement> {
  return createRuntimeGatewayConfinement({
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    runId: "run-2951",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    ...(filesystem === undefined ? {} : { filesystem }),
  });
}

function request(runtime: string, workspace: string): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-2951",
    recoveryHandle: "c".repeat(32),
    treeBindingId: "a".repeat(64),
    executable: runtime,
    args: ["--stdio"],
    cwd: workspace,
    env: { KEIKO_RUNTIME_MODE: "managed" },
    qualification: {
      platform: "win32",
      arch: "x64",
      backend: "windows-job-object",
      releaseReceipt: `sha256:${"b".repeat(64)}`,
    },
    launchProfile: {
      upstreamEditAuthority: false,
      upstreamShellAuthority: false,
      upstreamGitAuthority: false,
      upstreamDeliveryAuthority: false,
      upstreamConnectorAuthority: false,
      upstreamBrowserAuthority: false,
      unrestrictedNetworkAuthority: false,
    },
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    authorityEnvelopeDigest: "b".repeat(64),
    egressPolicy: {
      kind: "loopback-only",
      reviewedEgressReceipt: `sha256:${"b".repeat(64)}`,
    },
  };
}

describe("native runtime process backend and gateway confinement", () => {
  it("passes the exact gateway wrapper through the macOS sealed helper after supervisor preparation", () => {
    const paths = fixture();
    const helper = new FakeHelper();
    const packets: Buffer[] = [];
    helper.controlInput.on("data", (packet: Buffer) => {
      packets.push(packet);
    });
    const activityLog = createBufferedServerLogSink();
    const privateStateRoot = join(realpathSync(paths.workspace), ".keiko", "native-run");
    mkdirSync(privateStateRoot, { recursive: true, mode: 0o700 });
    const policy = gatewayConfinement({
      workspaceRoot: realpathSync(paths.workspace),
      workspaceAccess: "read-only",
      privateStateRoot,
      runtimeReadRoot: realpathSync(join(paths.runtime, "..")),
    });
    const git = { path: "/usr/bin/git", sha256: "e".repeat(64), source: "selected" as const };
    const identity = {
      platform: "darwin" as const,
      arch: "arm64" as const,
      backend: "macos-app-sandbox" as const,
    };
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      identity,
      gatewayConfinement: policy,
      activityLog,
      spawnHelper: () => helper,
      resolveGitExecutable: () => git,
      probeAvailability: () => ({
        bubblewrap: false,
        unshare: false,
        seatbelt: true,
        docker: false,
        podman: false,
      }),
    });
    const launch = {
      ...request(paths.runtime, paths.workspace),
      qualification: { ...request(paths.runtime, paths.workspace).qualification, ...identity },
    };
    const supervisor = createRuntimeProcessSupervisor({
      backend,
      qualifications: [launch.qualification],
      planSandbox: (input) =>
        planLongLivedRuntimeSandbox(
          input,
          { bubblewrap: false, unshare: false, seatbelt: true, docker: false, podman: false },
          "darwin",
        ),
    });
    expect(supervisor.spawnOwnedTree(launch).ok).toBe(true);
    const wrapped = buildRuntimeGatewaySeatbeltCommand(
      policy,
      realpathSync(paths.runtime),
      launch.args,
      git.path,
    );
    expect(Buffer.concat(packets)).toEqual(
      encodeLaunchPacket(
        { ...launch, args: wrapped.args },
        { executable: wrapped.command, cwd: realpathSync(paths.workspace) },
      ),
    );
    expect(activityLog.events.map((event) => event.op)).toEqual(["runtime.confinement.spawned"]);
    expect(activityLog.events[0]?.extra).toMatchObject({
      filesystemPolicy: "native-root-union-v1",
      workspaceAccess: "read-only-outside-private-state",
      privateStateAccess: "read-write",
    });
    expect(JSON.stringify(activityLog.events)).not.toContain(paths.workspace);
  });
  it("refuses unsupported gateway confinement even after supervisor preparation", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      gatewayConfinement: gatewayConfinement(),
      spawnHelper: spawn,
    });
    const launch = request(paths.runtime, paths.workspace);
    const supervisor = createRuntimeProcessSupervisor({
      backend,
      qualifications: [launch.qualification],
      planSandbox: (input) =>
        planLongLivedRuntimeSandbox(
          input,
          { bubblewrap: false, unshare: false, seatbelt: true, docker: false, podman: false },
          "darwin",
        ),
    });

    expect(supervisor.spawnOwnedTree(launch)).toEqual({ ok: false, failureCode: "spawn-failed" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns exactly as before when no gateway confinement is configured (no regression)", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      spawnHelper: spawn,
    });

    backend.spawnOwnedTree(request(paths.runtime, paths.workspace));

    expect(spawn).toHaveBeenCalledOnce();
  });

  // Failing-before: before this change, NativeRuntimeProcessBackendOptions had no
  // gatewayConfinement field at all, so a caller could not even express "this launch requires
  // gateway confinement" — the backend would silently spawn every launch unconfined.
  it("fails closed with the shared unsupported-on-this-host reason and never spawns", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      gatewayConfinement: gatewayConfinement(),
      spawnHelper: spawn,
    });

    expect(() => backend.spawnOwnedTree(request(paths.runtime, paths.workspace))).toThrow(
      GATEWAY_UNSUPPORTED_ON_HOST_REASON,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects runId/treeBindingId drift before checking backend support", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      gatewayConfinement: gatewayConfinement(),
      spawnHelper: spawn,
    });

    expect(() =>
      backend.spawnOwnedTree({ ...request(paths.runtime, paths.workspace), runId: "other-run" }),
    ).toThrow("runtime-gateway-confinement-drift");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a tampered gateway confinement object at construction time", () => {
    const paths = fixture();
    const policy = gatewayConfinement();
    expect(() =>
      createNativeRuntimeProcessBackend({
        helperPath: paths.helper,
        runtimeRoots: [join(paths.runtime, "..")],
        workspaceRoot: paths.workspace,
        gatewayConfinement: { ...policy, port: 80 },
      }),
    ).toThrow("native-runtime-config-invalid");
  });
});
