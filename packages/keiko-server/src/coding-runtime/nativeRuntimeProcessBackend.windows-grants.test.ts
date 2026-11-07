// #4068: the confined Windows tree's filesystem grants travel to the supervisor as one KGG1 frame,
// between the launch packet and the broker open. The native side (gateway_grants.c) applies them once
// the broker named the tree's SID; these cases pin the host side of that contract.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeGatewayConfinement,
  planWindowsGatewayRuntimeSandbox,
} from "@oscharko-dev/keiko-sandbox";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  createNativeRuntimeProcessBackend,
  type NativeRuntimeHelperProcess,
} from "./nativeRuntimeProcessBackend.js";
import {
  encodeLaunchPacket,
  encodeWindowsGatewayGrants,
  encodeWindowsGatewayOpen,
  type WindowsFilesystemGrant,
} from "./nativeRuntimeProcessProtocol.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";

const CAPABILITY = `keiko.workspace.${"0123456789abcdef".repeat(2)}`;
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

describe("the KGG1 grants frame", () => {
  it("frames each grant as access, principal and length-prefixed text", () => {
    const frame = encodeWindowsGatewayGrants([
      { path: "C:\\run", access: "modify", principal: "tree" },
      { path: "D:\\w", access: "read", principal: "capability", capability: CAPABILITY },
    ]);
    const entries = Buffer.concat([
      Buffer.from([2, 1, 6, 0, 0, 0]),
      Buffer.from("C:\\run"),
      Buffer.from([1, 2, 4, 0, 0, 0]),
      Buffer.from("D:\\w"),
      Buffer.from([CAPABILITY.length, 0, 0, 0]),
      Buffer.from(CAPABILITY),
    ]);
    expect(frame.subarray(0, 4).toString()).toBe("KGG1");
    expect(frame.readUInt16LE(4)).toBe(1);
    expect(frame.readUInt16LE(6)).toBe(1);
    expect(frame.readUInt32LE(8)).toBe(2 + entries.length);
    expect(frame.readUInt16LE(12)).toBe(2);
    expect(frame.subarray(14)).toEqual(entries);
  });

  it("sends an empty frame when nothing is granted, and refuses more than eight grants", () => {
    expect(encodeWindowsGatewayGrants([])).toEqual(
      Buffer.from([0x4b, 0x47, 0x47, 0x31, 1, 0, 1, 0, 2, 0, 0, 0, 0, 0]),
    );
    const many = Array.from({ length: 9 }, (): WindowsFilesystemGrant => ({
      path: "C:\\x",
      access: "read",
      principal: "tree",
    }));
    expect(() => encodeWindowsGatewayGrants(many)).toThrow("windows-grants-invalid");
  });
});

function fixture(): {
  root: string;
  helper: string;
  runtime: string;
  workspace: string;
  state: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-windows-grants-")));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  for (const path of [runtimeRoot, workspace, state]) mkdirSync(path);
  const helper = join(root, "keiko-runtime-supervisor.exe");
  const runtime = join(runtimeRoot, "opencode.exe");
  writeFileSync(helper, "helper");
  writeFileSync(runtime, "runtime");
  return { root, helper, runtime, workspace, state };
}

function launch(runtime: string, workspace: string): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-4068",
    recoveryHandle: "c".repeat(32),
    treeBindingId: "a".repeat(64),
    executable: runtime,
    args: ["serve"],
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
    egressPolicy: { kind: "loopback-only", reviewedEgressReceipt: `sha256:${"b".repeat(64)}` },
  };
}

describe("a confined Windows launch", () => {
  it("sends the launch, then the tree's grants at their real paths, then the broker open", () => {
    const paths = fixture();
    const helper = new FakeHelper();
    const packets: Buffer[] = [];
    helper.controlInput.on("data", (packet: Buffer) => {
      packets.push(packet);
    });
    const policy = createRuntimeGatewayConfinement({
      gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      runId: "run-4068",
      treeBindingId: "a".repeat(64),
      envelopeDigest: "b".repeat(64),
      runtimeArtifactDigest: "c".repeat(64),
      modelProfileDigest: "d".repeat(64),
    });
    const runtimeGrant: WindowsFilesystemGrant = {
      path: join(paths.runtime, ".."),
      access: "read",
      principal: "tree",
    };
    const stateGrant: WindowsFilesystemGrant = {
      path: paths.state,
      access: "modify",
      principal: "tree",
    };
    const worktreeGrant: WindowsFilesystemGrant = {
      path: paths.workspace,
      access: "read",
      principal: "capability",
      capability: CAPABILITY,
    };
    const request = launch(paths.runtime, paths.workspace);
    const activityLog = createBufferedServerLogSink();
    const supervisor = createRuntimeProcessSupervisor({
      backend: createNativeRuntimeProcessBackend({
        helperPath: paths.helper,
        useInstalledWindowsGateway: true,
        expectedHelperSha256: createHash("sha256").update("helper").digest("hex"),
        runtimeRoots: [join(paths.runtime, "..")],
        workspaceRoot: paths.workspace,
        gatewayConfinement: policy,
        windowsFilesystemGrants: [runtimeGrant, stateGrant, worktreeGrant],
        activityLog,
        spawnHelper: () => helper,
      }),
      qualifications: [request.qualification],
      planSandbox: planWindowsGatewayRuntimeSandbox,
    });

    expect(supervisor.spawnOwnedTree(request)).toMatchObject({ ok: true });
    expect(Buffer.concat(packets)).toEqual(
      Buffer.concat([
        encodeLaunchPacket(request, { executable: paths.runtime, cwd: paths.workspace }),
        encodeWindowsGatewayGrants([
          { ...runtimeGrant, path: realpathSync(join(paths.runtime, "..")) },
          stateGrant,
          worktreeGrant,
        ]),
        encodeWindowsGatewayOpen(policy, request.recoveryHandle),
      ]),
    );
    // The grants are counted, never named: no path or capability reaches the log.
    const event = activityLog.events.find((record) => record.op === "runtime.confinement.spawned");
    if (event === undefined) throw new Error("expected confined Windows tree evidence");
    expect(
      expectActivityLogProof(
        "runtime.confinement.spawned.emitted-line",
        formatActivityLogProofLine(event),
      ),
    ).toMatchObject({
      correlationId: "run-4068",
      backend: "windows-wfp",
      childExecutablePolicy: "appcontainer-inherited",
      windowsTreeGrantCount: 2,
      windowsWorktreeAccess: "capability-read",
    });
    const serialized = JSON.stringify(activityLog.events);
    expect(serialized).not.toContain("keiko-windows-grants-");
    expect(serialized).not.toContain(CAPABILITY);
  });

  it.each([
    ["a relative path", [{ path: "state", access: "modify", principal: "tree" }]],
    ["an access the frame does not know", [{ path: "/w", access: "full", principal: "tree" }]],
    [
      "write access for a capability",
      [{ path: "/w", access: "modify", principal: "capability", capability: CAPABILITY }],
    ],
    [
      "a capability that names no worktree",
      [{ path: "/w", access: "read", principal: "capability", capability: "keiko.other" }],
    ],
  ])("refuses %s before anything spawns", (_name, grants) => {
    const paths = fixture();
    expect(() =>
      createNativeRuntimeProcessBackend({
        helperPath: paths.helper,
        runtimeRoots: [join(paths.runtime, "..")],
        workspaceRoot: paths.workspace,
        windowsFilesystemGrants: grants as unknown as readonly WindowsFilesystemGrant[],
      }),
    ).toThrow("native-runtime-config-invalid");
  });
});
