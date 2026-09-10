import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  buildLinuxGatewayNamespaceCommand,
  LINUX_GATEWAY_DIAGNOSTIC_FD,
  LINUX_GATEWAY_DIAGNOSTIC_FD_ENV,
  LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD,
  LINUX_GATEWAY_NAMESPACE_IPC_FD,
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
  readonly launcherDiagnostics?: string | undefined;
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

const EXTERNAL_DESTINATION_SNIPPET = [
  "const net = require('node:net');",
  "const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });",
  "socket.setTimeout(3000);",
  "socket.on('connect', () => socket.write('PING'));",
  "socket.on('data', (data) => { const ok = data.toString() === 'PONG'; process.stdout.write(ok ? 'REACHED' : 'INVALID'); socket.destroy(); process.exitCode = ok ? 0 : 4; });",
  "socket.on('error', () => { process.stdout.write('BLOCKED'); process.exitCode = 3; });",
  "socket.on('timeout', () => { process.stdout.write('BLOCKED'); socket.destroy(); process.exitCode = 3; });",
].join("");

const HELD_ROUND_TRIP_SNIPPET = [
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const port = Number(process.argv[1]);",
  "const readyPath = process.argv[2];",
  "const releasePath = process.argv[3];",
  "const socket = net.connect({ host: '127.0.0.1', port });",
  "socket.on('connect', () => socket.write('PING'));",
  "socket.on('data', (data) => {",
  "  socket.destroy();",
  "  if (data.toString() !== 'PONG') process.exit(3);",
  "  fs.writeFileSync(readyPath, '');",
  "  const wait = () => fs.existsSync(releasePath) ? process.exit(0) : setTimeout(wait, 20);",
  "  wait();",
  "});",
  "socket.on('error', () => process.exit(4));",
].join("");

const SIBLING_BRIDGE_PROBE_SNIPPET = [
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const path = require('node:path');",
  "const port = Number(process.argv[1]);",
  "const directory = process.argv[2];",
  "const sockets = fs.readdirSync(directory, { withFileTypes: true })",
  "  .filter((entry) => entry.isDirectory() && entry.name.startsWith('keiko-gateway-'))",
  "  .map((entry) => path.join(directory, entry.name, 'relay.sock'))",
  "  .filter((candidate) => { try { return fs.statSync(candidate).isSocket(); } catch { return false; } });",
  "const probe = (candidate) => new Promise((resolve) => {",
  "  const socket = net.connect(candidate);",
  "  let body = '';",
  "  socket.setTimeout(1000);",
  "  socket.on('connect', () => socket.write('PING'));",
  "  socket.on('data', (chunk) => { body += chunk.toString(); });",
  "  socket.on('end', () => resolve(body === 'PONG'));",
  "  socket.on('error', () => resolve(false));",
  "  socket.on('timeout', () => { socket.destroy(); resolve(false); });",
  "});",
  "Promise.all(sockets.map(probe)).then((results) => {",
  "  if (results.some(Boolean)) { process.stdout.write('BRIDGE_EXPOSED'); process.exit(44); }",
  "  const socket = net.connect({ host: '127.0.0.1', port });",
  "  socket.on('connect', () => socket.write('PING'));",
  "  socket.on('data', (data) => { process.stdout.write(data.toString() === 'PONG' ? 'RELAYED' : 'INVALID'); socket.destroy(); });",
  "  socket.on('error', () => { process.stdout.write('BLOCKED'); process.exitCode = 3; });",
  "});",
].join("");

const SPOOF_ROUND_TRIP_SNIPPET = [
  `if [ "\${${LINUX_GATEWAY_DIAGNOSTIC_FD_ENV}+x}" = x ]; then exit 41; fi;`,
  'if [ "${NODE_CHANNEL_FD+x}" = x ]; then exit 40; fi;',
  "if { printf '%s\\n' 'keiko-linux-gateway:error:cleanup-failed' >&3; } 2>/dev/null; then exit 42; fi;",
  `if { printf '%s\\n' 'keiko-linux-gateway:error:cleanup-failed' >&${String(LINUX_GATEWAY_NAMESPACE_DIAGNOSTIC_FD)}; } 2>/dev/null; then exit 43; fi;`,
  `if [ -e /proc/self/fd/${String(LINUX_GATEWAY_NAMESPACE_IPC_FD)} ]; then exit 45; fi;`,
  "printf '%s\\n' 'keiko-linux-gateway:error:cleanup-failed' >&2;",
  'exec "$1" -e "$2" "$3" "$4"',
].join(" ");

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
  captureLauncherDiagnostics = false,
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const stdio: StdioOptions = captureLauncherDiagnostics
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];
    const child = spawn(command, args, {
      env: captureLauncherDiagnostics
        ? {
            ...env,
            [LINUX_GATEWAY_DIAGNOSTIC_FD_ENV]: String(LINUX_GATEWAY_DIAGNOSTIC_FD),
          }
        : env,
      stdio,
    });
    let stdout = "";
    let stderr = "";
    let launcherDiagnostics = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream === null || stderrStream === null) {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(new Error("child-output-pipes-unavailable"));
      return;
    }
    stdoutStream.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    stderrStream.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const diagnosticStream = child.stdio[LINUX_GATEWAY_DIAGNOSTIC_FD];
    if (diagnosticStream instanceof Readable) {
      diagnosticStream.on(
        "data",
        (chunk: Buffer) => (launcherDiagnostics += chunk.toString("utf8")),
      );
    }
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({
        status: status ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ...(captureLauncherDiagnostics ? { launcherDiagnostics: launcherDiagnostics.trim() } : {}),
      });
    });
  });
}

function captureNamespaceChild(
  child: ChildProcess,
  onMessage: (child: ChildProcess, message: unknown) => void,
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    if (child.stdout === null || child.stderr === null) {
      reject(new Error("namespace-output-pipes-unavailable"));
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("message", (message) => {
      onMessage(child, message);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status: status ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function runNamespaceChild(
  port: number,
  onMessage: (child: ChildProcess, message: unknown) => void,
): Promise<ChildRun> {
  const child = spawn(
    process.execPath,
    [
      linuxGatewayLauncherPath(),
      "namespace",
      "bubblewrap",
      "127.0.0.1",
      String(port),
      process.cwd(),
      process.execPath,
      "-e",
      NAMESPACE_SNIPPET,
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  return captureNamespaceChild(child, onMessage);
}

function connectionId(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null || !("connectionId" in message)) {
    return undefined;
  }
  return typeof message.connectionId === "number" ? message.connectionId : undefined;
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

async function listenEphemeral(
  host = "127.0.0.1",
): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((socket) => {
    socket.once("data", (data) => socket.end(data.toString("utf8") === "PING" ? "PONG" : "NO"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listen-failed");
  return { server, port: address.port };
}

function nonLoopbackIpv4Address(): string {
  for (const entries of Object.values(networkInterfaces())) {
    const address = entries?.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    if (address !== undefined) return address;
  }
  throw new Error("non-loopback-ipv4-unavailable");
}

async function reservePort(): Promise<number> {
  const reservation = await listenEphemeral();
  await close(reservation.server);
  return reservation.port;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("path-readiness-timeout");
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
    [["namespace", "bubblewrap", "127.0.0.1", "1983", "relative", "/bin/true"], "invalid-cwd"],
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
    const [command, args] = buildLinuxGatewayNamespaceCommand(config);
    expect(command).toBe("bwrap");
    expect(args).toEqual([
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
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
      "/work/root",
      "/trusted/opencode",
      "serve",
    ]);
  });

  it("uses an owner-mapped namespace whose child dies with unshare", () => {
    const [command, args] = buildLinuxGatewayNamespaceCommand({ ...config, backend: "unshare" });
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
  it("relays a host-connected socket received through the anonymous IPC channel", async () => {
    const gateway = await listenEphemeral();
    const port = await reservePort();
    try {
      const result = await runNamespaceChild(port, (child, message) => {
        const id = connectionId(message);
        if (id === undefined) return;
        const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
        socket.once("connect", () => child.send({ kind: "socket", connectionId: id }, socket));
      });
      expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
      const after = createServer();
      await listen(after, port);
      await close(after);
    } finally {
      await close(gateway.server);
    }
  });

  it("classifies a malformed IPC bridge message instead of returning a child result", async () => {
    const port = await reservePort();
    const result = await runNamespaceChild(port, (child, message) => {
      if (connectionId(message) !== undefined) child.send({ kind: "unexpected" });
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("keiko-linux-gateway:error:namespace-relay-failed");
  });
});

describe("real OS-level gateway confinement (Linux namespace bridge, #3422)", () => {
  const platformIsLinux = process.platform === "linux";

  it.skipIf(!platformIsLinux)(
    "passes the anonymous bridge through the unshare fallback",
    async () => {
      if (!probeBackends().unshare) throw new Error("linux-unshare-proof-backend-unavailable");
      const gateway = await listenEphemeral();
      try {
        const wrapped = requireWrapped(
          planIsolatedRun(
            {
              command: process.execPath,
              args: ["-e", ROUND_TRIP_SNIPPET, String(gateway.port)],
              cwd: process.cwd(),
              network: { mode: "gateway", host: "127.0.0.1", port: gateway.port },
            },
            {
              bubblewrap: false,
              unshare: true,
              seatbelt: false,
              docker: false,
              podman: false,
            },
            "linux",
          ),
        );
        expect(wrapped.attestation.backend).toBe("unshare");
        const result = await runChild(wrapped.command, wrapped.args, process.env, true);
        expect(result).toEqual({
          status: 0,
          stdout: "RELAYED",
          stderr: "",
          launcherDiagnostics: "",
        });
      } finally {
        await close(gateway.server);
      }
    },
  );

  it.skipIf(!platformIsLinux)(
    "permits only the configured gateway and isolates concurrent gateway ports",
    async () => {
      const availability = probeBackends();
      if (!availability.bubblewrap && !availability.unshare) {
        throw new Error("linux-gateway-proof-backend-unavailable");
      }
      const externalHost = nonLoopbackIpv4Address();
      const firstGateway = await listenEphemeral();
      const secondGateway = await listenEphemeral();
      const hostile = await listenEphemeral();
      const externalHostService = await listenEphemeral(externalHost);
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

        const externalControl = await runChild(process.execPath, [
          "-e",
          EXTERNAL_DESTINATION_SNIPPET,
          externalHost,
          String(externalHostService.port),
        ]);
        expect(externalControl).toMatchObject({ status: 0, stdout: "REACHED", stderr: "" });

        const external = requireWrapped(
          planIsolatedRun(
            {
              ...plan(firstGateway.port, firstGateway.port),
              args: [
                "-e",
                EXTERNAL_DESTINATION_SNIPPET,
                externalHost,
                String(externalHostService.port),
              ],
            },
            availability,
            "linux",
          ),
        );
        expect(await runChild(external.command, external.args, env)).toMatchObject({
          status: 3,
          stdout: "BLOCKED",
          stderr: "",
        });

        const crossRun = requireWrapped(
          planIsolatedRun(plan(firstGateway.port, secondGateway.port), availability, "linux"),
        );
        expect((await runChild(crossRun.command, crossRun.args, env)).stdout).toBe("BLOCKED");

        const unavailablePort = await reservePort();
        const unavailableGateway = requireWrapped(
          planIsolatedRun(plan(unavailablePort, unavailablePort), availability, "linux"),
        );
        const unavailableResult = await runChild(
          unavailableGateway.command,
          unavailableGateway.args,
          env,
          true,
        );
        expect(unavailableResult.status).toBe(1);
        expect(unavailableResult.launcherDiagnostics).toBe(
          "keiko-linux-gateway:error:host-relay-failed",
        );

        const readyPath = join(launcherTemp, "first-ready");
        const releasePath = join(launcherTemp, "first-release");
        const firstAllowed = requireWrapped(
          planIsolatedRun(
            {
              ...plan(firstGateway.port, firstGateway.port),
              args: [
                "-e",
                HELD_ROUND_TRIP_SNIPPET,
                String(firstGateway.port),
                readyPath,
                releasePath,
              ],
            },
            availability,
            "linux",
          ),
        );
        const secondAllowed = requireWrapped(
          planIsolatedRun(
            {
              ...plan(secondGateway.port, secondGateway.port),
              command: "/bin/sh",
              args: [
                "-c",
                SPOOF_ROUND_TRIP_SNIPPET,
                "keiko-spoof-proof",
                process.execPath,
                SIBLING_BRIDGE_PROBE_SNIPPET,
                String(secondGateway.port),
                launcherTemp,
              ],
            },
            availability,
            "linux",
          ),
        );
        const firstRun = runChild(firstAllowed.command, firstAllowed.args, env);
        await waitForPath(readyPath);
        const secondRun = await runChild(secondAllowed.command, secondAllowed.args, env, true);
        await writeFile(releasePath, "");
        expect(await firstRun).toMatchObject({ status: 0 });
        await Promise.all([rm(readyPath, { force: true }), rm(releasePath, { force: true })]);
        expect(secondRun).toEqual({
          status: 0,
          stdout: "RELAYED",
          stderr: "keiko-linux-gateway:error:cleanup-failed",
          launcherDiagnostics: "",
        });

        const missingTarget = requireWrapped(
          planIsolatedRun(
            {
              ...plan(firstGateway.port, firstGateway.port),
              command: join(process.cwd(), "missing-linux-gateway-proof-target"),
            },
            availability,
            "linux",
          ),
        );
        const failed = await runChild(missingTarget.command, missingTarget.args, env, true);
        expect(failed.status).toBe(1);
        expect(failed.launcherDiagnostics).toBe("keiko-linux-gateway:error:internal-failure");
        expect(failed.stderr).not.toContain("keiko-linux-gateway:error:");
        expect(await readdir(launcherTemp)).toEqual([]);
      } finally {
        await Promise.all([
          close(firstGateway.server),
          close(secondGateway.server),
          close(hostile.server),
          close(externalHostService.server),
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
