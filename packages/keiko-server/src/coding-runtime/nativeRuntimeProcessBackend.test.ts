import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNativeRuntimeProcessBackend,
  createNativeRuntimeRecoveryPort,
  type NativeRuntimeHelperProcess,
  type NativeRuntimeHelperSpawn,
} from "./nativeRuntimeProcessBackend.js";
import { encodeLaunchPacket, validateLaunchPacketRequest } from "./nativeRuntimeProcessProtocol.js";
import type { RuntimeSupervisorLaunchRequest } from "./runtimeProcessSupervisor.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixture(): {
  readonly helper: string;
  readonly runtime: string;
  readonly workspace: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-backend-"));
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

function request(runtime: string, workspace: string): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-1",
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

function backendFixture(): {
  readonly backend: ReturnType<typeof createNativeRuntimeProcessBackend>;
  readonly child: FakeHelper;
  readonly spawn: ReturnType<typeof vi.fn<NativeRuntimeHelperSpawn>>;
  readonly paths: ReturnType<typeof fixture>;
} {
  const paths = fixture();
  const child = new FakeHelper();
  const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => child);
  return {
    backend: createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      spawnHelper: spawn,
    }),
    child,
    spawn,
    paths,
  };
}

function response(kind: number, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(12);
  header.write("KRS1", 0, "ascii");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(kind, 6);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

describe("native runtime process backend", () => {
  it("encodes the exact executable and workspace paths accepted by validation", () => {
    const launch = request("/untrusted/runtime.exe", "/untrusted/workspace");
    const validated = validateLaunchPacketRequest(launch, {
      runtimeRoots: ["/validated/runtime"],
      workspaceRoot: "/validated/workspace",
      safeRealFile: () => "/validated/runtime/runtime.exe",
      safeRealDirectory: () => "/validated/workspace",
      pathIsContained: (root, candidate) => candidate.startsWith(root),
      invalidRequest: () => {
        throw new Error("unexpected-invalid-request");
      },
    });
    expect(decodeLaunchStrings(encodeLaunchPacket(launch, validated)).slice(1, 3)).toEqual([
      "/validated/runtime/runtime.exe",
      "/validated/workspace",
    ]);
  });

  it("spawns the fixed helper without a shell and sends a bounded launch packet", () => {
    const { backend, child, paths, spawn } = backendFixture();
    const chunks: Buffer[] = [];
    child.controlInput.on("data", (chunk: Buffer) => chunks.push(chunk));

    const launch = {
      ...request(paths.runtime, paths.workspace),
      args: ["--stdio", "second"],
      env: { KEIKO_ALPHA: "one", KEIKO_BETA: "two" },
    };
    const tree = backend.spawnOwnedTree(launch);

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[0]).toBe(realpathSync(paths.helper));
    expect(spawn.mock.calls[0]?.[1]).toEqual([]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true });
    expect(tree.stdout).toBe(child.stdout);
    expect(tree.stderr).toBe(child.stderr);
    expect(tree.stdin).toBe(child.stdin);
    expect(tree.treeId).toBe(launch.recoveryHandle);
    const packet = Buffer.concat(chunks);
    expect(packet.subarray(0, 4).toString("ascii")).toBe("KRP1");
    expect(decodeLaunchStrings(packet)).toEqual([
      tree.treeId,
      realpathSync(paths.runtime),
      realpathSync(paths.workspace),
      "--stdio",
      "second",
      "KEIKO_ALPHA",
      "one",
      "KEIKO_BETA",
      "two",
    ]);
  });

  it("accepts reap proof only when the helper reports zero active Job Object processes", async () => {
    const { backend, child, paths } = backendFixture();
    const tree = backend.spawnOwnedTree(request(paths.runtime, paths.workspace));
    const payload = Buffer.alloc(8);
    payload.writeInt32LE(0, 0);
    payload.writeUInt32LE(0, 4);
    child.controlOutput.write(response(2, payload));

    await expect(backend.waitForCompleteTreeExit(tree, 50)).resolves.toBe(true);
  });

  it("rejects path, environment, and protocol abuse before spawning", () => {
    const { backend, paths, spawn } = backendFixture();
    const candidates = [
      { ...request(paths.runtime, paths.workspace), executable: join(paths.workspace, "evil.exe") },
      { ...request(paths.runtime, paths.workspace), cwd: join(paths.workspace, "..") },
      { ...request(paths.runtime, paths.workspace), args: ["ok\0bad"] },
      {
        ...request(paths.runtime, paths.workspace),
        env: { "BAD=KEY": "value" },
      },
      {
        ...request(paths.runtime, paths.workspace),
        env: { SECRET: "x".repeat(16_385) },
      },
    ];

    for (const candidate of candidates) {
      expect(() => backend.spawnOwnedTree(candidate)).toThrow("native-runtime-request-invalid");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rechecks a Windows helper digest immediately before spawn", () => {
    const paths = fixture();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => new FakeHelper());
    const expectedHelperSha256 = createHash("sha256").update("helper").digest("hex");
    const backend = createNativeRuntimeProcessBackend({
      helperPath: paths.helper,
      expectedHelperSha256,
      runtimeRoots: [join(paths.runtime, "..")],
      workspaceRoot: paths.workspace,
      spawnHelper: spawn,
    });
    writeFileSync(paths.helper, "replaced helper");

    expect(() => backend.spawnOwnedTree(request(paths.runtime, paths.workspace))).toThrow(
      "native-runtime-helper-digest-mismatch",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("maps both signals to closed helper protocol commands without OS process signaling", () => {
    const { backend, child, paths } = backendFixture();
    const tree = backend.spawnOwnedTree(request(paths.runtime, paths.workspace));
    const write = vi.spyOn(child.controlInput, "write");

    backend.signalTree(tree, "graceful");
    backend.signalTree(tree, "force");

    expect(write).toHaveBeenCalledTimes(2);
    expect((write.mock.calls[0]?.[0] as Buffer).subarray(0, 4).toString("ascii")).toBe("KRC1");
    expect((write.mock.calls[1]?.[0] as Buffer).subarray(0, 4).toString("ascii")).toBe("KRC1");
  });

  it("fails closed on malformed or nonzero-active-process responses", async () => {
    const { backend, child, paths } = backendFixture();
    const tree = backend.spawnOwnedTree(request(paths.runtime, paths.workspace));
    child.controlOutput.write(Buffer.from("attacker-controlled-output"));
    child.emit("exit", 0);

    await expect(backend.waitForCompleteTreeExit(tree, 10)).resolves.toBe(false);
    await expect(backend.reconcileTreeExit(tree)).resolves.toBe(false);
  });

  it("reconciles a persisted opaque handle without an in-memory process tree", async () => {
    const paths = fixture();
    const child = new FakeHelper();
    const spawn = vi.fn<NativeRuntimeHelperSpawn>(() => child);
    const recovery = createNativeRuntimeRecoveryPort({
      helperPath: paths.helper,
      spawnHelper: spawn,
    });
    const handle = "c".repeat(32);
    const pending = recovery.reconcile(handle, 50);
    const payload = Buffer.alloc(8);
    child.controlOutput.write(response(2, payload));

    await expect(pending).resolves.toBe(true);
    expect(spawn.mock.calls[0]?.[1]).toEqual(["--reconcile", handle]);
    await expect(recovery.reconcile("../unsafe", 50)).rejects.toThrow(
      "native-runtime-request-invalid",
    );
  });
});

function decodeLaunchStrings(packet: Buffer): readonly string[] {
  const payloadLength = packet.readUInt32LE(8);
  const argumentCount = packet.readUInt16LE(12);
  const environmentCount = packet.readUInt16LE(14);
  const values: string[] = [];
  let offset = 16;
  const count = 3 + argumentCount + environmentCount * 2;
  for (let index = 0; index < count; index += 1) {
    const length = packet.readUInt32LE(offset);
    offset += 4;
    values.push(packet.subarray(offset, offset + length).toString("utf8"));
    expect(packet[offset + length]).toBe(0);
    offset += length + 1;
  }
  expect(offset).toBe(12 + payloadLength);
  return values;
}
