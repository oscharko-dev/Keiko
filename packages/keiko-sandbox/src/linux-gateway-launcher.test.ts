import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildLinuxGatewayNamespaceCommand,
  linuxGatewayLauncherPath,
  linuxGatewayDiagnosticKind,
  parseLinuxGatewayDiagnosticLine,
  parseLinuxGatewayPort,
  runLinuxGatewayLauncher,
  runWithLinuxGatewayCleanup,
} from "./runtime.js";
import { planIsolatedRun } from "./plan.js";
import { probeBackends } from "./probe.js";
import type { IsolatedRunDecision, IsolatedRunPlan } from "./types.js";

interface ChildRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ROUND_TRIP_SNIPPET = [
  "const net = require('node:net');",
  "const port = Number(process.argv[1]);",
  "const socket = net.connect({ host: '127.0.0.1', port });",
  "socket.setTimeout(3000);",
  "socket.on('connect', () => socket.write('PING'));",
  "socket.on('data', (data) => { const ok = data.toString() === 'PONG'; process.stdout.write(ok ? 'RELAYED' : 'INVALID'); socket.destroy(); process.exitCode = ok ? 0 : 3; });",
  "socket.on('error', () => { process.stdout.write('BLOCKED'); process.exitCode = 3; });",
  "socket.on('timeout', () => { process.stdout.write('TIMEOUT'); socket.destroy(); process.exitCode = 3; });",
].join("");

const SILENT_ROUND_TRIP_SNIPPET = [
  "const net = require('node:net');",
  "const port = Number(process.argv[1]);",
  "const socket = net.connect({ host: '127.0.0.1', port });",
  "socket.setTimeout(3000);",
  "socket.on('connect', () => socket.write('PING'));",
  "socket.on('data', (data) => { socket.destroy(); process.exitCode = data.toString() === 'PONG' ? 0 : 3; });",
  "socket.on('error', () => { process.exitCode = 3; });",
  "socket.on('timeout', () => { socket.destroy(); process.exitCode = 3; });",
].join("");

const NAMESPACE_SNIPPET = [
  "const net = require('node:net');",
  "const port = Number(process.argv[1]);",
  "const socket = net.connect({ host: '127.0.0.1', port });",
  "socket.setTimeout(3000);",
  "socket.on('connect', () => socket.write('PING'));",
  "socket.on('data', (data) => { socket.destroy(); process.exit(data.toString() === 'PONG' ? 0 : 3); });",
  "socket.on('error', () => process.exit(4));",
  "socket.on('timeout', () => { socket.destroy(); process.exit(5); });",
].join("");

function runChild(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (status) => {
      clearTimeout(timeout);
      resolve({ status: status ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function listen(server: Server, target: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (typeof target === "number") server.listen(target, "127.0.0.1", resolve);
    else server.listen(target, resolve);
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

async function listenEphemeral(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((socket) => {
    socket.once("data", (data) => socket.end(data.toString("utf8") === "PING" ? "PONG" : "NO"));
  });
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listen-failed");
  return { server, port: address.port };
}

async function reservePort(): Promise<number> {
  const reservation = await listenEphemeral();
  await close(reservation.server);
  return reservation.port;
}

function requireWrapped(
  decision: IsolatedRunDecision,
): Extract<IsolatedRunDecision, { kind: "wrapped" }> {
  if (decision.kind !== "wrapped") throw new Error("expected-wrapped-decision");
  return decision;
}

describe("Linux gateway launcher validation", () => {
  it.each([
    ["1", 1],
    ["65535", 65_535],
  ] as const)("accepts the valid gateway port boundary %s", (value, expected) => {
    expect(parseLinuxGatewayPort(value)).toBe(expected);
  });

  it.each([
    [[], "invalid-mode"],
    [["host", "container", "127.0.0.1", "1983", "/tmp", "/bin/true"], "invalid-backend"],
    [["host", "bubblewrap", "localhost", "1983", "/tmp", "/bin/true"], "invalid-gateway-host"],
    [["host", "bubblewrap", "127.0.0.1", "0", "/tmp", "/bin/true"], "invalid-gateway-port"],
    [["host", "bubblewrap", "127.0.0.1", "65536", "/tmp", "/bin/true"], "invalid-gateway-port"],
    [["host", "bubblewrap", "127.0.0.1", "1983", "relative", "/bin/true"], "invalid-cwd"],
    [["host", "bubblewrap", "127.0.0.1", "1983", "/tmp", "true"], "invalid-command"],
    [
      ["namespace", "bubblewrap", "127.0.0.1", "1983", "relative", "/tmp", "/bin/true"],
      "invalid-socket-path",
    ],
  ] as const)(
    "rejects malformed launcher arguments without starting a child",
    async (args, code) => {
      await expect(runLinuxGatewayLauncher(args)).rejects.toThrow(code);
    },
  );

  it("maps failures to a closed diagnostic kind without leaking arbitrary error text", async () => {
    let failure: unknown;
    try {
      await runLinuxGatewayLauncher(["host", "invalid", "secret-endpoint"]);
    } catch (error: unknown) {
      failure = error;
    }
    expect(linuxGatewayDiagnosticKind(failure)).toBe("invalid-backend");
    expect(linuxGatewayDiagnosticKind(new Error("secret-endpoint"))).toBe("internal-failure");
  });

  it("emits only the closed diagnostic code from the assembled CLI", () => {
    const result = spawnSync(
      process.execPath,
      [linuxGatewayLauncherPath(), "invalid-mode", "secret-endpoint"],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("keiko-linux-gateway:error:invalid-mode");
    expect(result.stderr).not.toContain("secret-endpoint");
  });

  it("parses only the exact closed launcher diagnostic protocol", () => {
    expect(parseLinuxGatewayDiagnosticLine("keiko-linux-gateway:error:host-relay-failed")).toBe(
      "host-relay-failed",
    );
    expect(
      parseLinuxGatewayDiagnosticLine("keiko-linux-gateway:error:private-detail"),
    ).toBeUndefined();
    expect(
      parseLinuxGatewayDiagnosticLine("keiko-linux-gateway:error:host-relay-failed:private-detail"),
    ).toBeUndefined();
  });

  it("refuses a host launcher on a non-Linux platform before creating bridge state", async () => {
    if (process.platform === "linux") {
      expect(process.platform).toBe("linux");
      return;
    }
    await expect(
      runLinuxGatewayLauncher([
        "host",
        "bubblewrap",
        "127.0.0.1",
        "1983",
        process.cwd(),
        process.execPath,
      ]),
    ).rejects.toThrow("unsupported-platform");
  });
});

describe("Linux gateway launcher cleanup", () => {
  it("preserves the primary run failure while attempting every cleanup step", async () => {
    const primary = new Error("primary-run-failure");
    const remove = vi.fn<() => Promise<void>>().mockResolvedValue();
    await expect(
      runWithLinuxGatewayCleanup(
        async () => Promise.reject(primary),
        async () => Promise.reject(new Error("close-failure")),
        remove,
      ),
    ).rejects.toBe(primary);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("classifies cleanup failure after a successful child with a closed kind", async () => {
    await expect(
      runWithLinuxGatewayCleanup(
        () => Promise.resolve(0),
        () => Promise.resolve(),
        async () => Promise.reject(new Error("private-cleanup-path")),
      ),
    ).rejects.toThrow("cleanup-failed");
  });
});

describe("Linux namespace command compilation", () => {
  const config = {
    backend: "bubblewrap" as const,
    gatewayHost: "127.0.0.1" as const,
    gatewayPort: 1983,
    cwd: "/work/root",
    command: "/trusted/opencode",
    args: ["serve"],
  };

  it("uses a parent-bound bubblewrap network namespace", () => {
    const [command, args] = buildLinuxGatewayNamespaceCommand(
      config,
      "/tmp/private/relay.sock",
      true,
    );
    expect(command).toBe("bwrap");
    expect(args).toEqual([
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
      "--sync-fd",
      "3",
      "--dev-bind",
      "/",
      "/",
      "--chdir",
      "/work/root",
      "--",
      process.execPath,
      linuxGatewayLauncherPath(),
      "namespace",
      "bubblewrap",
      "127.0.0.1",
      "1983",
      "/tmp/private/relay.sock",
      "/work/root",
      "/trusted/opencode",
      "serve",
    ]);
  });

  it("uses an owner-mapped namespace whose child dies with unshare", () => {
    const [command, args] = buildLinuxGatewayNamespaceCommand(
      { ...config, backend: "unshare" },
      "/tmp/private/relay.sock",
    );
    expect(command).toBe("unshare");
    expect(args.slice(0, 5)).toEqual([
      "--map-root-user",
      "--net",
      "--kill-child=SIGKILL",
      "--",
      process.execPath,
    ]);
    expect(args).not.toContain("--mount-proc");
  });
});

describe("Linux namespace relay lifecycle", () => {
  it("relays through the private Unix socket and removes its loopback listener before returning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "keiko-gateway-unit-"));
    const socketPath = join(directory, "relay.sock");
    const port = await reservePort();
    const unixServer = createServer((socket) => {
      socket.once("data", (data) => socket.end(data.toString("utf8") === "PING" ? "PONG" : "NO"));
    });
    try {
      await listen(unixServer, socketPath);
      const status = await runLinuxGatewayLauncher([
        "namespace",
        "bubblewrap",
        "127.0.0.1",
        String(port),
        socketPath,
        process.cwd(),
        process.execPath,
        "-e",
        NAMESPACE_SNIPPET,
        String(port),
      ]);
      expect(status).toBe(0);
      const after = createServer();
      await listen(after, port);
      await close(after);
    } finally {
      await close(unixServer);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies an upstream relay failure instead of returning a child result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "keiko-gateway-unit-"));
    const socketPath = join(directory, "missing.sock");
    const port = await reservePort();
    try {
      await expect(
        runLinuxGatewayLauncher([
          "namespace",
          "bubblewrap",
          "127.0.0.1",
          String(port),
          socketPath,
          process.cwd(),
          process.execPath,
          "-e",
          ROUND_TRIP_SNIPPET,
          String(port),
        ]),
      ).rejects.toThrow("namespace-relay-failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("real OS-level gateway confinement (Linux namespace bridge, #3422)", () => {
  const platformIsLinux = process.platform === "linux";

  it.skipIf(!platformIsLinux)(
    "permits only the configured gateway and isolates concurrent gateway ports",
    async () => {
      const availability = probeBackends();
      if (!availability.bubblewrap && !availability.unshare) {
        throw new Error("linux-gateway-proof-backend-unavailable");
      }
      const firstGateway = await listenEphemeral();
      const secondGateway = await listenEphemeral();
      const hostile = await listenEphemeral();
      const launcherTemp = await mkdtemp(join(tmpdir(), "keiko-gateway-proof-"));
      const env = { ...process.env, TMPDIR: launcherTemp };
      const plan = (gatewayPort: number, destinationPort: number): IsolatedRunPlan => ({
        command: process.execPath,
        args: ["-e", ROUND_TRIP_SNIPPET, String(destinationPort)],
        cwd: process.cwd(),
        network: { mode: "gateway", host: "127.0.0.1", port: gatewayPort },
      });
      try {
        const control = await runChild(process.execPath, [
          "-e",
          ROUND_TRIP_SNIPPET,
          String(hostile.port),
        ]);
        expect(control.stdout).toBe("RELAYED");

        const denied = requireWrapped(
          planIsolatedRun(plan(firstGateway.port, hostile.port), availability, "linux"),
        );
        const deniedResult = await runChild(denied.command, denied.args, env);
        expect(["BLOCKED", "TIMEOUT"]).toContain(deniedResult.stdout);
        expect(deniedResult.stdout).not.toBe("RELAYED");

        const crossRun = requireWrapped(
          planIsolatedRun(plan(firstGateway.port, secondGateway.port), availability, "linux"),
        );
        expect((await runChild(crossRun.command, crossRun.args, env)).stdout).toBe("BLOCKED");

        const firstAllowed = requireWrapped(
          planIsolatedRun(
            {
              ...plan(firstGateway.port, firstGateway.port),
              args: ["-e", SILENT_ROUND_TRIP_SNIPPET, String(firstGateway.port)],
            },
            availability,
            "linux",
          ),
        );
        const secondAllowed = requireWrapped(
          planIsolatedRun(plan(secondGateway.port, secondGateway.port), availability, "linux"),
        );
        const allowed = await Promise.all([
          runLinuxGatewayLauncher(firstAllowed.args.slice(1)),
          runChild(secondAllowed.command, secondAllowed.args, env),
        ]);
        expect(allowed[0]).toBe(0);
        expect(allowed[1]).toEqual({ status: 0, stdout: "RELAYED", stderr: "" });
        expect(await readdir(launcherTemp)).toEqual([]);
      } finally {
        await Promise.all([
          close(firstGateway.server),
          close(secondGateway.server),
          close(hostile.server),
        ]);
        await rm(launcherTemp, { recursive: true, force: true });
      }
    },
    45_000,
  );

  it("records why the Linux-native proof does not run on another platform", () => {
    if (platformIsLinux) {
      expect(platformIsLinux).toBe(true);
      return;
    }
    process.stderr.write(
      `[linux-gateway-confinement-proof] skipped: non-linux platform (${process.platform}).\n`,
    );
    expect(platformIsLinux).toBe(false);
  });
});
