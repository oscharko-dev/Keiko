// Linux gateway bridge entry point (#3422). The host process owns one private Unix socket whose
// relay destination is fixed before the isolated child starts. A second copy of this entry point
// runs inside the fresh network namespace, exposes the attested loopback port there, and forwards
// every accepted stream through that Unix socket. No child-controlled value can select another
// host destination.

import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants } from "node:fs";

type LinuxGatewayBackend = "bubblewrap" | "unshare";
type ForwardedSignal = "SIGINT" | "SIGHUP" | "SIGTERM";

interface CommonConfig {
  readonly backend: LinuxGatewayBackend;
  readonly gatewayHost: "127.0.0.1" | "::1";
  readonly gatewayPort: number;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
}

interface NamespaceConfig extends CommonConfig {
  readonly socketPath: string;
}

interface Relay {
  readonly server: Server;
  readonly destroyConnections: () => void;
}

interface ChildReference {
  current: ChildProcess | undefined;
}

const SIGNALS: readonly ForwardedSignal[] = ["SIGINT", "SIGHUP", "SIGTERM"];
const LOOPBACK_TOOLS: readonly string[] = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];

export const LINUX_GATEWAY_LAUNCHER_PATH = fileURLToPath(
  new URL("../dist/linux-gateway-launcher.js", import.meta.url),
);

class LinuxGatewayLauncherError extends Error {
  public constructor(public readonly errorKind: string) {
    super(errorKind);
    this.name = "LinuxGatewayLauncherError";
  }
}

function fail(errorKind: string): never {
  throw new LinuxGatewayLauncherError(errorKind);
}

function parseBackend(value: string | undefined): LinuxGatewayBackend {
  return value === "bubblewrap" || value === "unshare" ? value : fail("invalid-backend");
}

function parseGatewayHost(value: string | undefined): "127.0.0.1" | "::1" {
  return value === "127.0.0.1" || value === "::1" ? value : fail("invalid-gateway-host");
}

function parseGatewayPort(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,4}$/u.test(value)) {
    return fail("invalid-gateway-port");
  }
  const port = Number(value);
  return port <= 65_535 ? port : fail("invalid-gateway-port");
}

function parseAbsolute(value: string | undefined, errorKind: string): string {
  return value !== undefined && isAbsolute(value) && !value.includes("\0")
    ? value
    : fail(errorKind);
}

function parseCommon(values: readonly string[], offset: number): CommonConfig {
  return {
    backend: parseBackend(values[offset]),
    gatewayHost: parseGatewayHost(values[offset + 1]),
    gatewayPort: parseGatewayPort(values[offset + 2]),
    cwd: parseAbsolute(values[offset + 3], "invalid-cwd"),
    command: parseAbsolute(values[offset + 4], "invalid-command"),
    args: values.slice(offset + 5),
  };
}

function parseNamespace(values: readonly string[]): NamespaceConfig {
  return {
    backend: parseBackend(values[1]),
    gatewayHost: parseGatewayHost(values[2]),
    gatewayPort: parseGatewayPort(values[3]),
    socketPath: parseAbsolute(values[4], "invalid-socket-path"),
    cwd: parseAbsolute(values[5], "invalid-cwd"),
    command: parseAbsolute(values[6], "invalid-command"),
    args: values.slice(7),
  };
}

function relaySockets(client: Socket, upstream: Socket): void {
  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.once("error", close);
  upstream.once("error", close);
  client.pipe(upstream);
  upstream.pipe(client);
}

function createRelay(connectUpstream: () => Socket, onFatal: () => void): Relay {
  const connections = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connectUpstream();
    connections.add(client);
    connections.add(upstream);
    client.once("close", () => connections.delete(client));
    upstream.once("close", () => connections.delete(upstream));
    relaySockets(client, upstream);
  });
  server.maxConnections = 64;
  server.on("error", onFatal);
  return {
    server,
    destroyConnections: (): void => {
      for (const connection of connections) connection.destroy();
    },
  };
}

function hostRelay(config: CommonConfig, onFatal: () => void): Relay {
  return createRelay(
    () => createConnection({ host: config.gatewayHost, port: config.gatewayPort }),
    onFatal,
  );
}

function namespaceRelay(config: NamespaceConfig, onFatal: () => void): Relay {
  return createRelay(() => createConnection(config.socketPath), onFatal);
}

function listen(
  server: Server,
  target: string | { readonly host: string; readonly port: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(target);
  });
}

function closeRelay(relay: Relay): Promise<void> {
  relay.destroyConnections();
  return new Promise((resolve, reject) => {
    relay.server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

function forwardSignals(child: ChildProcess): () => void {
  const listeners = SIGNALS.map((signal) => {
    const listener = (): void => {
      child.kill(signal);
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  return (): void => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  };
}

function namespaceArgs(config: CommonConfig, socketPath: string): readonly string[] {
  return [
    LINUX_GATEWAY_LAUNCHER_PATH,
    "namespace",
    config.backend,
    config.gatewayHost,
    String(config.gatewayPort),
    socketPath,
    config.cwd,
    config.command,
    ...config.args,
  ];
}

function wrapperCommand(
  config: CommonConfig,
  socketPath: string,
): readonly [string, readonly string[]] {
  const launcher = [process.execPath, ...namespaceArgs(config, socketPath)];
  if (config.backend === "bubblewrap") {
    return [
      "bwrap",
      [
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--dev-bind",
        "/",
        "/",
        "--chdir",
        config.cwd,
        "--",
        ...launcher,
      ],
    ];
  }
  return ["unshare", ["--map-root-user", "--net", "--kill-child=SIGKILL", "--", ...launcher]];
}

async function executableLoopbackTool(): Promise<string> {
  for (const candidate of LOOPBACK_TOOLS) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the closed, system-owned candidate list.
    }
  }
  return fail("loopback-tool-unavailable");
}

async function enableUnshareLoopback(): Promise<void> {
  const command = await executableLoopbackTool();
  const child = spawn(command, ["link", "set", "lo", "up"], { stdio: "ignore" });
  if ((await waitForChild(child)) !== 0) fail("loopback-setup-failed");
}

async function runNamespace(config: NamespaceConfig): Promise<number> {
  if (config.backend === "unshare") await enableUnshareLoopback();
  const childReference: ChildReference = { current: undefined };
  const relay = namespaceRelay(config, () => {
    childReference.current?.kill("SIGKILL");
  });
  await listen(relay.server, { host: config.gatewayHost, port: config.gatewayPort });
  const child = spawn(config.command, config.args, { cwd: config.cwd, stdio: "inherit" });
  childReference.current = child;
  const stopForwarding = forwardSignals(child);
  try {
    return await waitForChild(child);
  } finally {
    stopForwarding();
    await closeRelay(relay);
  }
}

async function runHost(config: CommonConfig): Promise<number> {
  if (process.platform !== "linux") return fail("unsupported-platform");
  const directory = await mkdtemp(join(tmpdir(), "keiko-gateway-"));
  const socketPath = join(directory, "relay.sock");
  const childReference: ChildReference = { current: undefined };
  const relay = hostRelay(config, () => {
    childReference.current?.kill("SIGKILL");
  });
  try {
    await chmod(directory, 0o700);
    await listen(relay.server, socketPath);
    await chmod(socketPath, 0o600);
    const [command, args] = wrapperCommand(config, socketPath);
    const child = spawn(command, args, { cwd: config.cwd, stdio: "inherit" });
    childReference.current = child;
    const stopForwarding = forwardSignals(child);
    try {
      return await waitForChild(child);
    } finally {
      stopForwarding();
    }
  } finally {
    if (relay.server.listening) await closeRelay(relay);
    await rm(directory, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

async function main(values: readonly string[]): Promise<number> {
  if (values[0] === "host") return runHost(parseCommon(values, 1));
  if (values[0] === "namespace") return runNamespace(parseNamespace(values));
  return fail("invalid-mode");
}

function diagnosticKind(error: unknown): string {
  return error instanceof LinuxGatewayLauncherError ? error.errorKind : "internal-failure";
}

if (isMainModule()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`keiko-linux-gateway:error:${diagnosticKind(error)}\n`);
    process.exitCode = 1;
  }
}
