// #2951 residual finding: the native (Windows Job Object) gateway-confinement refusal path threw
// GATEWAY_UNSUPPORTED_ON_HOST_REASON with no body-free activity-log line, unlike the macOS dev-lane
// path's `runtime.confinement.failed` (devLaneRuntimeProcessBackend.ts's `recordConfinementFailure`).
// A support bundle for a Windows refusal therefore had no evidence at all. New file (not an edit to
// the existing native-backend suites) per the write-scope split.
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

import { createBufferedServerLogSink } from "../observability/index.js";
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
  const root = mkdtempSync(join(tmpdir(), "keiko-native-backend-gateway-log-"));
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
    runId: "run-2951-log",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
  });
}

function request(runtime: string, workspace: string): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-2951-log",
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

describe("native runtime process backend gateway-confinement refusal logging", () => {
  // Failing-before: before this change, NativeRuntimeProcessBackendOptions had no `activityLog`
  // field and the refusal threw with no write to any sink, so `activityLog.events` stayed empty
  // for a refusal that should have produced exactly one `runtime.confinement.failed` line.
  it("records a body-free runtime.confinement.failed line before throwing the closed refusal", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const activityLog = createBufferedServerLogSink();
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      gatewayConfinement: gatewayConfinement(),
      activityLog,
      spawnHelper: spawn,
    });

    expect(() => backend.spawnOwnedTree(request(paths.runtime, paths.workspace))).toThrow(
      GATEWAY_UNSUPPORTED_ON_HOST_REASON,
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(activityLog.events).toHaveLength(1);
    expect(activityLog.events).toContainEqual(
      expect.objectContaining({
        category: "process",
        level: "error",
        op: "runtime.confinement.failed",
        correlationId: "run-2951-log",
      }),
    );
    // Body-free: no path, no gateway URL, no helper/runtime executable location anywhere in the line.
    expect(JSON.stringify(activityLog.events)).not.toContain(paths.helper);
    expect(JSON.stringify(activityLog.events)).not.toContain(paths.workspace);
    expect(Array.isArray(activityLog.events[0]?.extra?.frames)).toBe(true);
    expect(Array.isArray(activityLog.events[0]?.extra?.causeChain)).toBe(true);
  });

  it("also logs a runId/treeBindingId drift refusal under the same op", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const activityLog = createBufferedServerLogSink();
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      gatewayConfinement: gatewayConfinement(),
      activityLog,
      spawnHelper: spawn,
    });

    expect(() =>
      backend.spawnOwnedTree({ ...request(paths.runtime, paths.workspace), runId: "other-run" }),
    ).toThrow("runtime-gateway-confinement-drift");
    expect(spawn).not.toHaveBeenCalled();
    expect(activityLog.events).toContainEqual(
      expect.objectContaining({ op: "runtime.confinement.failed", correlationId: "other-run" }),
    );
  });

  it("writes no confinement-failure line when no gateway confinement is configured (no regression)", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const activityLog = createBufferedServerLogSink();
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      activityLog,
      spawnHelper: spawn,
    });

    backend.spawnOwnedTree(request(paths.runtime, paths.workspace));

    expect(spawn).toHaveBeenCalledOnce();
    expect(activityLog.events).toHaveLength(0);
  });
});
