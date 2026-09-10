import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { fstatSync } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINUX_GATEWAY_DIAGNOSTIC_FD,
  LINUX_GATEWAY_DIAGNOSTIC_FD_ENV,
  LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD,
  runLinuxGatewayLauncher,
} from "./runtime.js";

const spawnMock = vi.hoisted(() => vi.fn<typeof spawn>());
const accessMock = vi.hoisted(() => vi.fn<typeof access>());
const fstatSyncMock = vi.hoisted(() => vi.fn<typeof fstatSync>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: accessMock };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fstatSync: fstatSyncMock };
});

interface FakeChild {
  readonly child: ChildProcess;
  readonly exit: (code: number | null) => void;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
}

type SendCallback = (error: Error | null) => void;

const processDescriptors = new Map(
  ["platform", "connected", "send", "disconnect"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(process, name),
  ]),
);
const privateEnvironment = new Map(
  [LINUX_GATEWAY_DIAGNOSTIC_FD_ENV, "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].map(
    (name) => [name, process.env[name]] as const,
  ),
);

function callbackFrom(args: readonly unknown[]): SendCallback | undefined {
  const candidate = args.at(-1);
  return typeof candidate === "function" ? (candidate as SendCallback) : undefined;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as ChildProcess;
  const exit = (code: number | null): void => {
    child.emit("exit", code, null);
  };
  const kill = vi.fn((_signal?: string | number): boolean => {
    queueMicrotask(() => {
      exit(null);
    });
    return true;
  });
  const send = vi.fn((...args: unknown[]): boolean => {
    callbackFrom(args)?.(null);
    return true;
  });
  Object.assign(child, { kill, send });
  return { child, exit, kill, send };
}

function exitingChild(code: number): FakeChild {
  const control = fakeChild();
  queueMicrotask(() => {
    control.exit(code);
  });
  return control;
}

function setProcessProperty(name: string, value: unknown): void {
  Object.defineProperty(process, name, { configurable: true, writable: true, value });
}

function installIpcSend(send: (...args: unknown[]) => boolean, connected = false): void {
  setProcessProperty("send", send);
  setProcessProperty("connected", connected);
  setProcessProperty("disconnect", vi.fn());
}

function restoreProcessProperties(): void {
  for (const [name, descriptor] of processDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(process, name);
    else Object.defineProperty(process, name, descriptor);
  }
}

function hostArgs(port: number): readonly string[] {
  return ["host", "bubblewrap", "127.0.0.1", String(port), process.cwd(), process.execPath];
}

function namespaceArgs(backend: "bubblewrap" | "unshare", port: number): readonly string[] {
  return ["namespace", backend, "127.0.0.1", String(port), process.cwd(), process.execPath];
}

function requireSpawnOptions(value: unknown): SpawnOptions {
  if (typeof value !== "object" || value === null) throw new Error("spawn-options-unavailable");
  return value;
}

function clearPrivateEnvironment(): void {
  for (const name of privateEnvironment.keys()) Reflect.deleteProperty(process.env, name);
}

function restorePrivateEnvironment(): void {
  for (const [name, value] of privateEnvironment) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("listen-failed"));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

describe("Linux gateway launcher in-process orchestration", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    accessMock.mockReset();
    fstatSyncMock.mockReset();
    setProcessProperty("platform", "linux");
    clearPrivateEnvironment();
  });

  afterEach(() => {
    restoreProcessProperties();
    restorePrivateEnvironment();
  });

  it("transfers only a host-connected gateway socket after the ready handshake", async () => {
    const gateway = createServer();
    const port = await listen(gateway);
    const control = fakeChild();
    control.send.mockImplementation((...args: unknown[]): boolean => {
      const handle = args[1];
      expect(handle).toBeInstanceOf(Socket);
      callbackFrom(args)?.(null);
      if (handle instanceof Socket) handle.destroy();
      queueMicrotask(() => {
        control.exit(0);
      });
      return true;
    });
    spawnMock.mockReturnValue(control.child);
    try {
      const run = runLinuxGatewayLauncher(hostArgs(port));
      control.child.emit("message", { kind: "ready" });
      control.child.emit("message", { kind: "open", connectionId: 1 });
      await expect(run).resolves.toBe(0);
      expect(control.send).toHaveBeenCalledWith(
        { kind: "socket", connectionId: 1 },
        expect.any(Socket),
        expect.any(Function),
      );
    } finally {
      await close(gateway);
    }
  });

  it("fails closed for malformed, premature, duplicated, or handle-bearing IPC messages", async () => {
    const cases: readonly (readonly [unknown, unknown?, boolean?])[] = [
      [{ kind: "open", connectionId: 1 }],
      [{ kind: "ready", extra: true }],
      [{ kind: "ready" }, new Socket()],
      [{ kind: "ready" }, undefined, true],
    ];
    for (const [message, handle, repeated] of cases) {
      const control = fakeChild();
      spawnMock.mockReturnValueOnce(control.child);
      const run = runLinuxGatewayLauncher(hostArgs(19_983));
      if (repeated === true) {
        control.child.emit("message", message);
        control.child.emit("message", message);
      } else {
        control.child.emit("message", message, handle);
      }
      await expect(run).rejects.toThrow("host-relay-failed");
      expect(control.kill).toHaveBeenCalledWith("SIGKILL");
      if (handle instanceof Socket) handle.destroy();
    }
  });

  it("classifies an unavailable upstream and a failed descriptor transfer", async () => {
    const unavailablePort = await reservePort();
    const unavailable = fakeChild();
    spawnMock.mockReturnValueOnce(unavailable.child);
    const failedConnection = runLinuxGatewayLauncher(hostArgs(unavailablePort));
    unavailable.child.emit("message", { kind: "ready" });
    unavailable.child.emit("message", { kind: "open", connectionId: 1 });
    await expect(failedConnection).rejects.toThrow("host-relay-failed");

    const gateway = createServer();
    const port = await listen(gateway);
    const failedTransfer = fakeChild();
    failedTransfer.send.mockImplementation((...args: unknown[]): boolean => {
      callbackFrom(args)?.(new Error("descriptor-transfer-failed"));
      return false;
    });
    spawnMock.mockReturnValueOnce(failedTransfer.child);
    try {
      const run = runLinuxGatewayLauncher(hostArgs(port));
      failedTransfer.child.emit("message", { kind: "ready" });
      failedTransfer.child.emit("message", { kind: "open", connectionId: 1 });
      await expect(run).rejects.toThrow("host-relay-failed");
    } finally {
      await close(gateway);
    }
  });

  it("keeps the private diagnostic descriptor for the nested launcher only", async () => {
    process.env[LINUX_GATEWAY_DIAGNOSTIC_FD_ENV] = String(LINUX_GATEWAY_DIAGNOSTIC_FD);
    fstatSyncMock.mockReturnValue({} as ReturnType<typeof fstatSync>);
    const control = exitingChild(0);
    spawnMock.mockReturnValue(control.child);
    await expect(runLinuxGatewayLauncher(hostArgs(19_983))).resolves.toBe(0);
    const options = requireSpawnOptions(spawnMock.mock.calls[0]?.[2]);
    expect(options.env?.[LINUX_GATEWAY_DIAGNOSTIC_FD_ENV]).toBe(
      String(LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD),
    );
    expect(options.stdio).toEqual(expect.arrayContaining([LINUX_GATEWAY_DIAGNOSTIC_FD, "ipc"]));
  });

  it("runs the namespace target and strips every private bridge marker", async () => {
    const port = await reservePort();
    const disconnect = vi.fn();
    installIpcSend((...args: unknown[]): boolean => {
      callbackFrom(args)?.(null);
      return true;
    }, true);
    setProcessProperty("disconnect", disconnect);
    process.env[LINUX_GATEWAY_DIAGNOSTIC_FD_ENV] = "3";
    process.env.NODE_CHANNEL_FD = "10";
    process.env.NODE_CHANNEL_SERIALIZATION_MODE = "advanced";
    spawnMock.mockImplementation(() => exitingChild(7).child);
    await expect(runLinuxGatewayLauncher(namespaceArgs("bubblewrap", port))).resolves.toBe(7);
    const options = requireSpawnOptions(spawnMock.mock.calls[0]?.[2]);
    expect(options.env).not.toHaveProperty(LINUX_GATEWAY_DIAGNOSTIC_FD_ENV);
    expect(options.env).not.toHaveProperty("NODE_CHANNEL_FD");
    expect(options.env).not.toHaveProperty("NODE_CHANNEL_SERIALIZATION_MODE");
    expect(options.stdio).toEqual([
      "inherit",
      "inherit",
      "inherit",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
    ]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("fails closed when namespace IPC is unavailable or rejects readiness", async () => {
    for (const send of [
      undefined,
      (...args: unknown[]): boolean => {
        callbackFrom(args)?.(new Error("ipc-rejected"));
        return false;
      },
      (): never => {
        throw new Error("ipc-threw");
      },
    ]) {
      const port = await reservePort();
      installIpcSend(send ?? undefinedSend);
      if (send === undefined) Reflect.deleteProperty(process, "send");
      await expect(runLinuxGatewayLauncher(namespaceArgs("bubblewrap", port))).rejects.toThrow(
        "namespace-relay-failed",
      );
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });

  it("enables loopback for unshare and fails closed when setup is unavailable", async () => {
    const port = await reservePort();
    installIpcSend(successfulSend);
    accessMock.mockResolvedValueOnce();
    spawnMock
      .mockImplementationOnce(() => exitingChild(0).child)
      .mockImplementationOnce(() => exitingChild(0).child);
    await expect(runLinuxGatewayLauncher(namespaceArgs("unshare", port))).resolves.toBe(0);
    expect(spawnMock).toHaveBeenNthCalledWith(1, "/usr/sbin/ip", ["link", "set", "lo", "up"], {
      stdio: "ignore",
    });

    accessMock.mockRejectedValue(new Error("not-installed"));
    await expect(
      runLinuxGatewayLauncher(namespaceArgs("unshare", await reservePort())),
    ).rejects.toThrow("loopback-tool-unavailable");
  });
});

function successfulSend(...args: unknown[]): boolean {
  callbackFrom(args)?.(null);
  return true;
}

function undefinedSend(): boolean {
  return false;
}
