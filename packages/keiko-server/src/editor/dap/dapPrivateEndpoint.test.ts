import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  classifyEndpointOwner,
  closeDapPrivateEndpointSocket,
  connectPrivateDapEndpoint,
  createNodeDapPrivateEndpointDeps,
  DapPrivateEndpointError,
  type DapPrivateEndpointDeps,
} from "./dapPrivateEndpoint.js";
import type {
  DebugRuntimeDirectoryIdentity,
  Layer2DebugCapsulePlan,
  PosixDebugEndpointPlan,
} from "./debugCapsulePlan.js";
import type { Socket } from "node:net";

const runtimeDirectoryIdentity = Object.freeze({
  realPath: "/private/runtime",
  identityDigest: "runtime_a",
  device: 1,
  inode: 2,
  mode: 0o40700,
  ownerUid: 7,
});
const safeDirectory = Object.freeze({
  mode: "0700",
  owner: "currentUser",
  device: runtimeDirectoryIdentity.device,
  inode: runtimeDirectoryIdentity.inode,
  modeBits: runtimeDirectoryIdentity.mode,
  ownerUid: runtimeDirectoryIdentity.ownerUid,
});

const plan = Object.freeze({
  schemaVersion: "1",
  planId: "plan_opaque",
  workspacePartitionKey: "partition_a",
  activationRevision: 1,
  targetKind: "file",
  provisioningDigest: "a".repeat(64),
  backend: "oci",
  runtimeIdentityDigest: "b".repeat(64),
  spawnEnvelope: { runtimeDirectoryIdentity },
  endpoint: {
    kind: "posixSocket",
    hostRuntimeDirectory: "/private/runtime",
    hostSocketPath: "/private/runtime/dap.sock",
    capsuleRuntimeDirectory: "/run/keiko-debug",
    capsuleSocketPath: "/run/keiko-debug/dap.sock",
    runtimeIdentity: "runtime_a",
  },
  capsule: {
    runtimeMount: {
      hostPath: "/private/runtime",
      capsulePath: "/run/keiko-debug",
      mode: "0700",
      writable: true,
    },
    runtimeIdentityDigest: "b".repeat(64),
  },
  attestation: {
    filesystem: "executionRoot",
    network: "none",
    processScope: "capsule",
    runtimeDirectoryMode: "0700",
    endpointOwnership: "currentUser",
  },
  launchRequest: { command: "launch", arguments: { request: "launch" } },
}) as unknown as Layer2DebugCapsulePlan;

interface PlanChanges {
  readonly endpoint?: Partial<PosixDebugEndpointPlan>;
  readonly runtimeDirectoryIdentity?: Partial<DebugRuntimeDirectoryIdentity>;
  readonly runtimeMount?: Readonly<Record<string, unknown>>;
  readonly runtimeIdentityDigest?: string;
  readonly capsuleRuntimeIdentityDigest?: string;
}

function changedPlan(changes: PlanChanges): Layer2DebugCapsulePlan {
  if (plan.endpoint.kind !== "posixSocket") throw new Error("invalid test fixture");
  return {
    ...plan,
    runtimeIdentityDigest: changes.runtimeIdentityDigest ?? plan.runtimeIdentityDigest,
    endpoint: { ...plan.endpoint, ...changes.endpoint },
    spawnEnvelope: {
      ...plan.spawnEnvelope,
      runtimeDirectoryIdentity: {
        ...plan.spawnEnvelope.runtimeDirectoryIdentity,
        ...changes.runtimeDirectoryIdentity,
      },
    },
    capsule: {
      ...plan.capsule,
      runtimeMount: { ...plan.capsule.runtimeMount, ...changes.runtimeMount },
      runtimeIdentityDigest:
        changes.capsuleRuntimeIdentityDigest ?? plan.capsule.runtimeIdentityDigest,
    },
  };
}

function safeDeps(overrides: Partial<DapPrivateEndpointDeps> = {}): DapPrivateEndpointDeps {
  return {
    platform: "linux",
    inspectDirectory: () => Promise.resolve(safeDirectory),
    inspectSocket: () => Promise.resolve({ type: "socket", owner: "currentUser", symlink: false }),
    realpath: (path) => Promise.resolve(path),
    connect: () =>
      Promise.resolve({
        source: new PassThrough(),
        sendFrame: vi.fn(),
        close: () => Promise.resolve(),
        destroy: vi.fn(),
      }),
    wait: () => Promise.resolve(),
    maxAttempts: 1,
    ...overrides,
  };
}

function socketPathWithLength(length: number): string {
  return `/${"a".repeat(length - 8)}/d.sock`;
}

function planWithSocketPaths(
  hostSocketPath: string,
  capsuleSocketPath: string,
): Layer2DebugCapsulePlan {
  const hostRuntimeDirectory = dirname(hostSocketPath);
  const capsuleRuntimeDirectory = dirname(capsuleSocketPath);
  return changedPlan({
    endpoint: {
      hostRuntimeDirectory,
      hostSocketPath,
      capsuleRuntimeDirectory,
      capsuleSocketPath,
    },
    runtimeDirectoryIdentity: { realPath: hostRuntimeDirectory },
    runtimeMount: { hostPath: hostRuntimeDirectory, capsulePath: capsuleRuntimeDirectory },
  });
}

describe("private DAP endpoint", () => {
  it("allows a bounded production startup window for provisioned adapters", () => {
    expect(createNodeDapPrivateEndpointDeps().maxAttempts).toBe(100);
  });

  it("classifies exact endpoint ownership", () => {
    expect(classifyEndpointOwner(7, 7)).toBe("currentUser");
    expect(classifyEndpointOwner(7, 8)).toBe("other");
  });
  it("surfaces exact closed endpoint errors", () => {
    for (const code of ["PRIVATE_ENDPOINT_INVALID", "PRIVATE_ENDPOINT_UNSUPPORTED"] as const) {
      const error = new DapPrivateEndpointError(code);
      expect(error).toMatchObject({ name: "DapPrivateEndpointError", message: code, code });
    }
  });
  it("validates 0700 directory, socket type, owner, and realpath before connecting", async () => {
    const connect = vi.fn(() =>
      Promise.resolve({
        source: new PassThrough(),
        sendFrame: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
        destroy: vi.fn(),
      }),
    );
    const endpoint = await connectPrivateDapEndpoint(plan, {
      platform: "linux",
      inspectDirectory: () => Promise.resolve(safeDirectory),
      inspectSocket: () =>
        Promise.resolve({ type: "socket", owner: "currentUser", symlink: false }),
      realpath: (path) => Promise.resolve(path),
      connect,
      wait: () => Promise.resolve(),
      maxAttempts: 1,
    });
    expect(connect).toHaveBeenCalledWith("/private/runtime/dap.sock");
    await endpoint.close();
  });

  it.each([
    { directory: { ...safeDirectory, mode: "0755" } },
    { directory: { ...safeDirectory, owner: "other" } },
    { socket: { type: "file", owner: "currentUser", symlink: false } },
    { socket: { type: "socket", owner: "other", symlink: false } },
    { socket: { type: "socket", owner: "currentUser", symlink: true } },
    { driftDirectory: true },
    { driftSocket: true },
  ])("fails closed before connect for an unsafe endpoint", async (unsafe) => {
    const connect = vi.fn();
    let runtimeRealpathCalls = 0;
    await expect(
      connectPrivateDapEndpoint(plan, {
        platform: "linux",
        inspectDirectory: () => Promise.resolve(unsafe.directory ?? safeDirectory),
        inspectSocket: () =>
          Promise.resolve(
            unsafe.socket ?? { type: "socket", owner: "currentUser", symlink: false },
          ),
        realpath: (path) => {
          const firstRuntimeInspection =
            path === "/private/runtime" && runtimeRealpathCalls++ === 0;
          const drift =
            (unsafe.driftDirectory === true && firstRuntimeInspection) ||
            (unsafe.driftSocket === true && path === "/private/runtime/dap.sock");
          return Promise.resolve(drift ? `${path}-drift` : path);
        },
        connect,
        wait: () => Promise.resolve(),
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "host socket outside its runtime directory",
      candidate: changedPlan({ endpoint: { hostSocketPath: "/other/dap.sock" } }),
    },
    {
      name: "capsule socket outside its runtime directory",
      candidate: changedPlan({ endpoint: { capsuleSocketPath: "/other/dap.sock" } }),
    },
    {
      name: "unsafe host socket basename",
      candidate: changedPlan({ endpoint: { hostSocketPath: "/private/runtime/.sock" } }),
    },
    {
      name: "unsafe capsule socket basename",
      candidate: changedPlan({ endpoint: { capsuleSocketPath: "/run/keiko-debug/.sock" } }),
    },
    {
      name: "different runtime mount host",
      candidate: changedPlan({ runtimeMount: { hostPath: "/other" } }),
    },
    {
      name: "different runtime mount capsule path",
      candidate: changedPlan({ runtimeMount: { capsulePath: "/other" } }),
    },
    {
      name: "non-private runtime mount mode",
      candidate: changedPlan({ runtimeMount: { mode: "0755" } }),
    },
    {
      name: "read-only runtime mount",
      candidate: changedPlan({ runtimeMount: { writable: false } }),
    },
    {
      name: "different capsule runtime identity",
      candidate: changedPlan({ capsuleRuntimeIdentityDigest: "c".repeat(64) }),
    },
  ])("rejects a plan with $name before filesystem inspection", async ({ candidate }) => {
    const inspectDirectory = vi.fn();
    const connect = vi.fn();
    await expect(
      connectPrivateDapEndpoint(candidate, safeDeps({ inspectDirectory, connect })),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
    expect(inspectDirectory).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("accepts host and capsule socket paths at the exact 100-byte boundary", async () => {
    const exactPath = socketPathWithLength(100);
    const candidate = planWithSocketPaths(exactPath, exactPath);
    const connect = vi.fn(safeDeps().connect);
    await expect(
      connectPrivateDapEndpoint(candidate, safeDeps({ connect })),
    ).resolves.toBeDefined();
    expect(Buffer.byteLength(exactPath)).toBe(100);
    expect(connect).toHaveBeenCalledWith(exactPath);
  });

  it.each([
    {
      name: "host",
      candidate: planWithSocketPaths(socketPathWithLength(101), "/run/keiko-debug/dap.sock"),
    },
    {
      name: "capsule",
      candidate: planWithSocketPaths("/private/runtime/dap.sock", socketPathWithLength(101)),
    },
  ])("rejects a $name socket path above 100 bytes", async ({ candidate }) => {
    const inspectDirectory = vi.fn();
    await expect(
      connectPrivateDapEndpoint(candidate, safeDeps({ inspectDirectory })),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
    expect(inspectDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ["device", 11],
    ["inode", 12],
    ["modeBits", 0o40755],
    ["ownerUid", 13],
  ] as const)(
    "rejects runtime-directory %s drift after socket validation",
    async (field, value) => {
      let inspections = 0;
      const inspectDirectory = (): ReturnType<DapPrivateEndpointDeps["inspectDirectory"]> => {
        inspections += 1;
        return Promise.resolve(
          inspections === 1 ? safeDirectory : { ...safeDirectory, [field]: value },
        );
      };
      const connect = vi.fn();
      await expect(
        connectPrivateDapEndpoint(plan, safeDeps({ inspectDirectory, connect })),
      ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
      expect(inspections).toBe(2);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "recorded realpath",
      candidate: changedPlan({ runtimeDirectoryIdentity: { realPath: "/private/other" } }),
    },
    {
      name: "recorded identity digest",
      candidate: changedPlan({ endpoint: { runtimeIdentity: "runtime_other" } }),
    },
  ])("rejects a different $name after socket validation", async ({ candidate }) => {
    const connect = vi.fn();
    await expect(connectPrivateDapEndpoint(candidate, safeDeps({ connect }))).rejects.toMatchObject(
      { code: "PRIVATE_ENDPOINT_INVALID" },
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a runtime realpath change after the socket validation", async () => {
    let runtimeInspections = 0;
    const connect = vi.fn();
    const realpath = (path: string): Promise<string> => {
      if (path !== "/private/runtime") return Promise.resolve(path);
      runtimeInspections += 1;
      return Promise.resolve(runtimeInspections === 1 ? path : "/private/runtime-replaced");
    };
    await expect(
      connectPrivateDapEndpoint(plan, safeDeps({ connect, realpath })),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
    expect(runtimeInspections).toBe(2);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a current runtime realpath that matches identity but not the endpoint binding", async () => {
    const candidate = changedPlan({
      runtimeDirectoryIdentity: { realPath: "/private/runtime-replaced" },
    });
    let runtimeInspections = 0;
    const connect = vi.fn();
    const realpath = (path: string): Promise<string> => {
      if (path !== "/private/runtime") return Promise.resolve(path);
      runtimeInspections += 1;
      return Promise.resolve(runtimeInspections === 1 ? path : "/private/runtime-replaced");
    };
    await expect(
      connectPrivateDapEndpoint(candidate, safeDeps({ connect, realpath })),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
    expect(runtimeInspections).toBe(2);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "normalizes hostile retry limits to one attempt",
    async (maxAttempts) => {
      const inspect = vi.fn(() => Promise.reject(new Error("not ready")));
      const wait = vi.fn(() => Promise.resolve());
      await expect(
        connectPrivateDapEndpoint(plan, {
          platform: "linux",
          inspectDirectory: inspect,
          inspectSocket: vi.fn(),
          realpath: vi.fn(),
          connect: vi.fn(),
          wait,
          maxAttempts,
        }),
      ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    },
  );

  it("uses every configured retry and passes increasing wait attempts", async () => {
    const inspect = vi.fn(() => Promise.reject(new Error("not ready")));
    const wait = vi.fn(() => Promise.resolve());
    await expect(
      connectPrivateDapEndpoint(plan, {
        platform: "linux",
        inspectDirectory: inspect,
        inspectSocket: vi.fn(),
        realpath: vi.fn(),
        connect: vi.fn(),
        wait,
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toStrictEqual([[1], [2]]);
  });

  it("uses a typed Windows port or fails closed when none is available", async () => {
    await expect(
      connectPrivateDapEndpoint(
        {
          ...plan,
          backend: "windowsContainer",
          endpoint: { kind: "windowsPipe", pipeName: "opaque-pipe", runtimeIdentity: "runtime_a" },
        },
        {
          platform: "win32",
          inspectDirectory: vi.fn(),
          inspectSocket: vi.fn(),
          realpath: vi.fn(),
          connect: vi.fn(),
          wait: vi.fn(),
          maxAttempts: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_UNSUPPORTED" });
  });

  it("rejects a Windows pipe on a non-Windows host even when a connector is injected", async () => {
    const connectWindowsPipe = vi.fn();
    await expect(
      connectPrivateDapEndpoint(
        {
          ...plan,
          backend: "windowsContainer",
          endpoint: { kind: "windowsPipe", pipeName: "opaque-pipe", runtimeIdentity: "runtime_a" },
        },
        {
          platform: "linux",
          inspectDirectory: vi.fn(),
          inspectSocket: vi.fn(),
          realpath: vi.fn(),
          connect: vi.fn(),
          connectWindowsPipe,
          wait: vi.fn(),
          maxAttempts: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_UNSUPPORTED" });
    expect(connectWindowsPipe).not.toHaveBeenCalled();
  });

  it("rejects a POSIX endpoint on a Windows host before inspection", async () => {
    const inspectDirectory = vi.fn();
    await expect(
      connectPrivateDapEndpoint(plan, {
        platform: "win32",
        inspectDirectory,
        inspectSocket: vi.fn(),
        realpath: vi.fn(),
        connect: vi.fn(),
        wait: vi.fn(),
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({
      name: "DapPrivateEndpointError",
      message: "PRIVATE_ENDPOINT_UNSUPPORTED",
      code: "PRIVATE_ENDPOINT_UNSUPPORTED",
    });
    expect(inspectDirectory).not.toHaveBeenCalled();
  });

  it("uses the typed Windows connector when supplied", async () => {
    const connection = {
      source: new PassThrough(),
      sendFrame: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
      destroy: vi.fn(),
    };
    const connectWindowsPipe = vi.fn(() => Promise.resolve(connection));
    await expect(
      connectPrivateDapEndpoint(
        {
          ...plan,
          backend: "windowsContainer",
          endpoint: { kind: "windowsPipe", pipeName: "p", runtimeIdentity: "runtime_a" },
        },
        {
          platform: "win32",
          inspectDirectory: vi.fn(),
          inspectSocket: vi.fn(),
          realpath: vi.fn(),
          connect: vi.fn(),
          connectWindowsPipe,
          wait: vi.fn(),
          maxAttempts: 1,
        },
      ),
    ).resolves.toBe(connection);
  });

  it("waits for a not-yet-created safe socket before connecting", async () => {
    let inspection = 0;
    const wait = vi.fn(() => Promise.resolve());
    const connect = vi.fn(() =>
      Promise.resolve({
        source: new PassThrough(),
        sendFrame: vi.fn(),
        close: () => Promise.resolve(),
        destroy: vi.fn(),
      }),
    );
    await connectPrivateDapEndpoint(plan, {
      platform: "linux",
      inspectDirectory: () => {
        inspection += 1;
        return inspection === 1
          ? Promise.reject(new Error("not ready"))
          : Promise.resolve(safeDirectory);
      },
      inspectSocket: () =>
        Promise.resolve({ type: "socket", owner: "currentUser", symlink: false }),
      realpath: (path) => Promise.resolve(path),
      connect,
      wait,
      maxAttempts: 2,
    });
    expect(wait).toHaveBeenCalledWith(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform !== "win32")(
    "connects and closes a real private UDS through the production dependency adapter",
    async () => {
      const created = mkdtempSync(join(tmpdir(), "keiko-dap-endpoint-"));
      const directory = realpathSync(created);
      chmodSync(directory, 0o700);
      const socketPath = join(directory, "dap.sock");
      const server = createServer((socket) => socket.resume());
      try {
        server.listen(socketPath);
        await once(server, "listening");
        const connection = await connectPrivateDapEndpoint(
          {
            ...plan,
            endpoint: {
              kind: "posixSocket",
              hostRuntimeDirectory: directory,
              hostSocketPath: socketPath,
              capsuleRuntimeDirectory: "/run/keiko-debug",
              capsuleSocketPath: "/run/keiko-debug/dap.sock",
              runtimeIdentity: "runtime_a",
            },
            spawnEnvelope: {
              ...plan.spawnEnvelope,
              runtimeDirectoryIdentity:
                ((): Layer2DebugCapsulePlan["spawnEnvelope"]["runtimeDirectoryIdentity"] => {
                  const stats = lstatSync(directory);
                  return {
                    realPath: directory,
                    identityDigest: "runtime_a",
                    device: stats.dev,
                    inode: stats.ino,
                    mode: stats.mode,
                    ownerUid: stats.uid,
                  };
                })(),
            },
            capsule: {
              ...plan.capsule,
              runtimeMount: { ...plan.capsule.runtimeMount, hostPath: directory },
            },
          },
          createNodeDapPrivateEndpointDeps(),
        );
        await connection.close();
      } finally {
        await new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a runtime directory inode replacement between spawn and endpoint inspection",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "keiko-dap-runtime-replacement-"));
      const runtime = join(root, "runtime");
      mkdirSync(runtime, { mode: 0o700 });
      const original = lstatSync(runtime);
      const replacement = join(root, "runtime-old");
      renameSync(runtime, replacement);
      mkdirSync(runtime, { mode: 0o700 });
      const socketPath = join(runtime, "dap.sock");
      const server = createServer((socket) => socket.resume());
      server.listen(socketPath);
      await once(server, "listening");
      const connect = vi.fn();
      try {
        await expect(
          connectPrivateDapEndpoint(
            {
              ...plan,
              endpoint: {
                kind: "posixSocket",
                hostRuntimeDirectory: runtime,
                hostSocketPath: socketPath,
                capsuleRuntimeDirectory: "/run/keiko-debug",
                capsuleSocketPath: "/run/keiko-debug/dap.sock",
                runtimeIdentity: "runtime_a",
              },
              spawnEnvelope: {
                ...plan.spawnEnvelope,
                runtimeDirectoryIdentity: {
                  realPath: runtime,
                  identityDigest: "runtime_a",
                  device: original.dev,
                  inode: original.ino,
                  mode: original.mode,
                  ownerUid: original.uid,
                },
              },
              capsule: {
                ...plan.capsule,
                runtimeMount: { ...plan.capsule.runtimeMount, hostPath: runtime },
              },
            },
            { ...createNodeDapPrivateEndpointDeps(), connect, maxAttempts: 1 },
          ),
        ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
        expect(connect).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("uses the bounded production retry scheduler", async () => {
    vi.useFakeTimers();
    const waiting = createNodeDapPrivateEndpointDeps().wait(2);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("forces a hanging socket closed at the exact endpoint deadline", async () => {
    vi.useFakeTimers();
    let closeListener: (() => void) | undefined;
    const destroy = vi.fn(() => closeListener?.());
    const socket = {
      destroyed: false,
      once: (event: string, listener: () => void): void => {
        if (event === "close") closeListener = listener;
      },
      end: vi.fn(),
      destroy,
    } as unknown as Socket;
    const closing = closeDapPrivateEndpointSocket(socket);
    await vi.advanceTimersByTimeAsync(249);
    expect(destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("clears the close deadline after an orderly socket close", async () => {
    vi.useFakeTimers();
    let closeListener: (() => void) | undefined;
    const destroy = vi.fn();
    const socket = {
      destroyed: false,
      once: (event: string, listener: () => void): void => {
        if (event === "close") closeListener = listener;
      },
      end: (): void => closeListener?.(),
      destroy,
    } as unknown as Socket;
    await closeDapPrivateEndpointSocket(socket);
    await vi.advanceTimersByTimeAsync(250);
    expect(destroy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not touch a socket that is already destroyed", async () => {
    const onceMock = vi.fn(() => {
      throw new Error("must not subscribe");
    });
    const endMock = vi.fn(() => {
      throw new Error("must not end");
    });
    const socket = {
      destroyed: true,
      once: onceMock,
      end: endMock,
      destroy: vi.fn(() => {
        throw new Error("must not destroy");
      }),
    } as unknown as Socket;
    await expect(closeDapPrivateEndpointSocket(socket)).resolves.toBeUndefined();
    expect(onceMock).not.toHaveBeenCalled();
    expect(endMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "surfaces production socket connection errors and supports forced destroy",
    async () => {
      const deps = createNodeDapPrivateEndpointDeps();
      await expect(deps.connect(join(tmpdir(), "keiko-missing-dap.sock"))).rejects.toBeDefined();
      const directory = mkdtempSync(join(tmpdir(), "keiko-dap-destroy-"));
      const socketPath = join(directory, "dap.sock");
      let peer: Socket | undefined;
      const received: Buffer[] = [];
      const server = createServer((socket) => {
        peer = socket;
        socket.on("data", (chunk: Buffer) => received.push(chunk));
      });
      try {
        server.listen(socketPath);
        await once(server, "listening");
        const connection = await deps.connect(socketPath);
        connection.sendFrame("{}");
        await vi.waitFor(() => {
          expect(Buffer.concat(received).toString("ascii")).toBe("Content-Length: 2\r\n\r\n{}");
        });
        expect(peer).toBeDefined();
        const peerClosed =
          peer === undefined
            ? Promise.resolve(false)
            : Promise.race([
                once(peer, "close").then(() => true),
                new Promise<boolean>((resolve) =>
                  setTimeout(() => {
                    resolve(false);
                  }, 250),
                ),
              ]);
        connection.destroy();
        await expect(peerClosed).resolves.toBe(true);
        await expect(connection.close()).resolves.toBeUndefined();
      } finally {
        await new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports production directory and non-socket identity without leaking paths",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "keiko-dap-inspect-"));
      chmodSync(directory, 0o700);
      const file = join(directory, "plain");
      writeFileSync(file, "x", "utf8");
      try {
        const deps = createNodeDapPrivateEndpointDeps();
        await expect(deps.inspectDirectory(directory)).resolves.toMatchObject({
          mode: "0700",
          owner: "currentUser",
        });
        await expect(deps.inspectSocket(file)).resolves.toStrictEqual({
          type: "other",
          owner: "currentUser",
          symlink: false,
        });
        await expect(deps.realpath(directory)).resolves.toBe(realpathSync(directory));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
