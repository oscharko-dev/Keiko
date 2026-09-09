// #2951: nativeRuntimeProcessBackend.ts (the Windows Job Object / native-helper backend) has no OS
// primitive that can bind its launch-packet protocol to a single loopback destination. A caller
// that attaches a gateway-allowlist confinement policy must get a closed refusal, never an
// unconfined spawn. New file (not an edit to the existing suite) per the write-scope split.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeGatewayConfinement,
  GATEWAY_UNSUPPORTED_ON_HOST_REASON,
} from "@oscharko-dev/keiko-sandbox";

import {
  createNativeRuntimeProcessBackend,
  type NativeRuntimeHelperProcess,
  type NativeRuntimeHelperSpawn,
} from "./nativeRuntimeProcessBackend.js";
import type { RuntimeSupervisorLaunchRequest } from "./runtimeProcessSupervisor.js";

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

function gatewayConfinement(): ReturnType<typeof createRuntimeGatewayConfinement> {
  return createRuntimeGatewayConfinement({
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    runId: "run-2951",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
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
  };
}

describe("native runtime process backend and gateway confinement", () => {
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
