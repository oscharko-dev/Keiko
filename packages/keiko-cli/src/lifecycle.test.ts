import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { runLifecycleCli, safeKillProcess } from "./lifecycle.js";
import type { CliIo } from "./runner.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

async function withEnvVar<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[key];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = previous;
    }
  }
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-lifecycle-"));
  tempRoots.push(root);
  return root;
}

function childLogFds(opts: SpawnOptions): { readonly stdoutFd: number; readonly stderrFd: number } {
  expect(Array.isArray(opts.stdio)).toBe(true);
  const stdio = opts.stdio as readonly unknown[];
  expect(stdio[0]).toBe("ignore");
  expect(typeof stdio[1]).toBe("number");
  expect(typeof stdio[2]).toBe("number");
  return { stdoutFd: stdio[1] as number, stderrFd: stdio[2] as number };
}

function requireCapturedLogFds(
  logFds: { readonly stdoutFd: number; readonly stderrFd: number } | undefined,
): { readonly stdoutFd: number; readonly stderrFd: number } {
  expect(logFds).toBeDefined();
  if (logFds === undefined) {
    throw new Error("Expected child log file descriptors to be captured");
  }
  return logFds;
}

async function withHealthServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  try {
    return await run(address.port);
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
  }
}

async function expectNativeHealthStartFailure(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<void> {
  await withHealthServer(handler, async (port) => {
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 600;
      return now;
    });
    try {
      const code = await runLifecycleCli(
        "start",
        ["--port", String(port), "--start-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          spawnFn: () => child,
          isProcessAlive: () => true,
          isPortAvailable: () => Promise.resolve(true),
          sleep: () => Promise.resolve(),
        },
      );
      expect(code).toBe(1);
      expect(c.err()).toContain("UI did not become healthy");
    } finally {
      nowSpy.mockRestore();
    }
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runLifecycleCli", () => {
  it("uses the bounded native HTTP health probe instead of fetch", async () => {
    const root = makeRoot();
    const c = makeIo();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: SDK_VERSION }));
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not run"));
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    try {
      const code = await runLifecycleCli(
        "start",
        ["--port", String(address.port)],
        c.io,
        {},
        {
          cwd: root,
          spawnFn: () => child,
          isProcessAlive: () => true,
          isPortAvailable: () => Promise.resolve(true),
        },
      );
      expect(code).toBe(0);
      expect(c.out()).toContain("Keiko UI running on");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    }
  });

  it("fails closed when the native HTTP health probe returns an HTTP error", async () => {
    await expectNativeHealthStartFailure((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: SDK_VERSION }));
    });
  });

  it("fails closed when the native HTTP health probe returns malformed JSON", async () => {
    await expectNativeHealthStartFailure((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not-json");
    });
  });

  it("fails closed when the native HTTP health probe returns a different version", async () => {
    await expectNativeHealthStartFailure((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "0.0.0-wrong" }));
    });
  });

  it("fails closed when the native HTTP health probe response exceeds the size cap", async () => {
    await expectNativeHealthStartFailure((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "x".repeat(70 * 1024) }));
    });
  });

  it("fails closed when the native HTTP health probe times out", async () => {
    await expectNativeHealthStartFailure((_request, response) => {
      response.once("close", () => {
        response.destroy();
      });
    });
  });

  it("reports not running when no pid file exists", async () => {
    const root = makeRoot();
    const c = makeIo();

    const code = await runLifecycleCli("status", [], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(c.out()).toContain("not running");
    expect(c.err()).toBe("");
  });

  it("stops cleanly when no process is running", async () => {
    const root = makeRoot();
    const c = makeIo();

    const code = await runLifecycleCli("stop", [], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(c.out()).toContain("not running");
    expect(c.err()).toBe("");
  });

  it("prints lifecycle help without touching runtime state", async () => {
    const root = makeRoot();
    const c = makeIo();
    const spawnFn = vi.fn();

    const code = await runLifecycleCli("start", ["--help"], c.io, {}, { cwd: root, spawnFn });

    expect(code).toBe(0);
    expect(c.out()).toContain("keiko start");
    expect(c.out()).toContain("keiko status");
    expect(c.err()).toBe("");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("reports a live pid through status without probing health", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const fetchImpl = vi.fn();

    const code = await runLifecycleCli(
      "status",
      [],
      c.io,
      {},
      {
        cwd: root,
        fetchImpl,
        isProcessAlive: () => true,
      },
    );

    expect(code).toBe(0);
    expect(c.out()).toContain("Keiko UI is running on http://127.0.0.1:1983");
    expect(c.out()).toContain("pid 12345");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("starts the packaged UI through the compiled CLI entry and records runtime state", async () => {
    const root = makeRoot();
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await runLifecycleCli(
      "start",
      ["--port", "4321", "--state-dir", ".keiko-test"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: (command, args, opts) => {
          spawned.push({ command, args, opts });
          return child;
        },
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    const spawn = spawned[0];
    if (spawn === undefined) {
      throw new Error("Expected keiko start to spawn the UI process");
    }
    expect(spawn.args).toEqual(
      expect.arrayContaining(["ui", "--port", "4321", "--host", "127.0.0.1"]),
    );
    expect(spawn.opts.argv0).toBe("Keiko");
    expect(spawn.opts.env).toMatchObject({
      KEIKO_STATE_DIR: join(root, ".keiko-test"),
    });
    const logFds = childLogFds(spawn.opts);
    expect(logFds.stdoutFd).not.toBe(logFds.stderrFd);
    expect(() => fstatSync(logFds.stdoutFd)).toThrow();
    expect(() => fstatSync(logFds.stderrFd)).toThrow();
    expect(readFileSync(join(root, ".keiko-test", "ui.pid"), "utf8")).toBe("12345\n");
    expect(existsSync(join(root, ".keiko-test", "ui.log"))).toBe(true);
    expect(c.out()).toContain("Keiko UI running");
  });

  it("prefers the active published CLI entry when KEIKO_CLI_BIN_PATH is set", async () => {
    const root = makeRoot();
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await withEnvVar("KEIKO_CLI_BIN_PATH", "/tmp/fake-keiko-bin.js", async () =>
      runLifecycleCli(
        "start",
        [],
        c.io,
        {},
        {
          cwd: root,
          spawnFn: (command, args, opts) => {
            spawned.push({ command, args, opts });
            return child;
          },
          fetchImpl: () =>
            Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
          isProcessAlive: () => true,
          isPortAvailable: () => Promise.resolve(true),
          killProcess: vi.fn(),
          sleep: () => Promise.resolve(),
        },
      ),
    );

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args[0]).toBe("/tmp/fake-keiko-bin.js");
  });

  it("prefers the built workspace checkout over a stale inherited global bin", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "dist", "cli"), { recursive: true });
    mkdirSync(join(root, "dist", "ui", "static"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"@oscharko-dev/keiko"}\n', "utf8");
    writeFileSync(join(root, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");
    writeFileSync(join(root, "dist", "ui", "static", "index.html"), "<html></html>\n", "utf8");
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await withEnvVar(
      "KEIKO_CLI_BIN_PATH",
      "/opt/old-keiko/dist/cli/index.js",
      async () =>
        withEnvVar("KEIKO_UI_STATIC_ROOT", "/opt/old-keiko/dist/ui/static", async () =>
          runLifecycleCli(
            "start",
            [],
            c.io,
            {},
            {
              cwd: root,
              spawnFn: (command, args, opts) => {
                spawned.push({ command, args, opts });
                return child;
              },
              fetchImpl: () =>
                Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
              isProcessAlive: () => true,
              isPortAvailable: () => Promise.resolve(true),
              killProcess: vi.fn(),
              sleep: () => Promise.resolve(),
            },
          ),
        ),
    );

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args[0]).toBe(join(root, "dist", "cli", "index.js"));
    expect(spawned[0]?.opts.env).toMatchObject({
      KEIKO_CLI_BIN_PATH: join(root, "dist", "cli", "index.js"),
      KEIKO_UI_STATIC_ROOT: join(root, "dist", "ui", "static"),
    });
  });

  it("accepts --open and opens the UI URL after a healthy start", async () => {
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const openExternal = vi.fn();

    const code = await runLifecycleCli(
      "start",
      ["--open"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: () => child,
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        openExternal,
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:1983");
    expect(c.err()).toBe("");
  });

  it("keeps an already-running UI when the health version matches the installed package", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const spawnFn = vi.fn();

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      {},
      {
        cwd: root,
        spawnFn,
        fetchImpl: () =>
          Promise.resolve(Response.json({ status: "ok", version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(c.out()).toContain("already running");
  });

  it("reopens the browser for an already-running UI when --open is requested", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const spawnFn = vi.fn();
    const openExternal = vi.fn();

    const code = await runLifecycleCli(
      "start",
      ["--open"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn,
        fetchImpl: () =>
          Promise.resolve(Response.json({ status: "ok", version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        killProcess: vi.fn(),
        openExternal,
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:1983");
    expect(c.out()).toContain("already running");
  });

  it("restarts an already-running UI when the health version is stale", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 67890, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    let oldProcessAlive = true;
    const killProcess = vi.fn((pid: number) => {
      if (pid === 12345) oldProcessAlive = false;
    });

    const code = await runLifecycleCli(
      "start",
      ["--start-timeout", "1", "--stop-timeout", "1"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: (command, args, opts) => {
          spawned.push({ command, args, opts });
          return child;
        },
        fetchImpl: (() => {
          let probe = 0;
          return (): Promise<Response> => {
            probe += 1;
            // 1st probe = the stale existing process (triggers the restart); after the restart
            // the freshly-spawned child reports the current SDK version so waitForHealth succeeds.
            return Promise.resolve(
              Response.json(
                probe === 1
                  ? { status: "ok", version: "0.1.2" }
                  : { status: "ok", version: SDK_VERSION },
                { status: 200 },
              ),
            );
          };
        })(),
        isProcessAlive: (pid) => (pid === 12345 ? oldProcessAlive : true),
        isPortAvailable: () => Promise.resolve(true),
        killProcess,
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(c.out()).toContain("stale");
    expect(killProcess).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(spawned).toHaveLength(1);
    expect(readFileSync(join(root, ".keiko", "ui.pid"), "utf8")).toBe("67890\n");
  });

  it("restarts an existing process when health is reachable but does not expose a version", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const child = { pid: 67890, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    let oldProcessAlive = true;
    const killProcess = vi.fn((pid: number) => {
      if (pid === 12345) oldProcessAlive = false;
    });

    const code = await runLifecycleCli(
      "start",
      ["--start-timeout", "1", "--stop-timeout", "1"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: () => child,
        fetchImpl: (() => {
          let probe = 0;
          return (): Promise<Response> => {
            probe += 1;
            // 1st probe = existing process with no version field (triggers restart); the fresh
            // child after the restart reports the current SDK version so startup completes.
            return Promise.resolve(
              Response.json(
                probe === 1 ? { status: "ok" } : { status: "ok", version: SDK_VERSION },
                { status: 200 },
              ),
            );
          };
        })(),
        isProcessAlive: (pid) => (pid === 12345 ? oldProcessAlive : true),
        isPortAvailable: () => Promise.resolve(true),
        killProcess,
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(c.out()).toContain("health check did not return the current Keiko version");
    expect(killProcess).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(readFileSync(join(root, ".keiko", "ui.pid"), "utf8")).toBe("67890\n");
  });

  it("restarts an existing process when its health endpoint is unreachable", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const child = { pid: 67890, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    let oldProcessAlive = true;
    let fetchCalls = 0;
    const killProcess = vi.fn((pid: number) => {
      if (pid === 12345) oldProcessAlive = false;
    });

    const code = await runLifecycleCli(
      "start",
      ["--start-timeout", "1", "--stop-timeout", "1"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: () => child,
        fetchImpl: () => {
          fetchCalls += 1;
          return fetchCalls === 1
            ? Promise.reject(new Error("connection refused"))
            : Promise.resolve(
                Response.json({ status: "ok", version: SDK_VERSION }, { status: 200 }),
              );
        },
        isProcessAlive: (pid) => (pid === 12345 ? oldProcessAlive : true),
        isPortAvailable: () => Promise.resolve(true),
        killProcess,
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(c.out()).toContain("health check is unreachable");
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
    expect(killProcess).toHaveBeenCalledWith(12345, "SIGTERM");
  });

  it("returns a usage error for invalid ports", async () => {
    const root = makeRoot();
    const c = makeIo();

    const code = await runLifecycleCli("start", ["--port", "99999"], c.io, {}, { cwd: root });

    expect(code).toBe(2);
    expect(c.err().toLowerCase()).toContain("usage");
  });

  it("fails before spawning when the requested UI port is already occupied", async () => {
    const root = makeRoot();
    const c = makeIo();
    const spawnFn = vi.fn();

    const code = await runLifecycleCli(
      "start",
      ["--port", "4321"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn,
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(false),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".keiko", "ui.pid"))).toBe(false);
    expect(c.out()).toBe("");
    expect(c.err()).toContain("port 127.0.0.1:4321 is already in use");
    expect(c.err()).toContain("--port");
  });

  it("does not treat another process health response as a successful child start", async () => {
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 24680, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const killProcess = vi.fn();

    const code = await runLifecycleCli(
      "start",
      ["--port", "4321", "--start-timeout", "1"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: () => child,
        fetchImpl: () =>
          Promise.resolve(Response.json({ status: "ok", version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => false,
        isPortAvailable: () => Promise.resolve(true),
        killProcess,
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(1);
    expect(c.out()).toContain("Starting Keiko UI");
    expect(c.out()).not.toContain("Keiko UI running");
    expect(c.err()).toContain("UI did not become healthy");
    expect(killProcess).toHaveBeenCalledWith(24680, "SIGTERM");
    expect(existsSync(join(root, ".keiko", "ui.pid"))).toBe(false);
  });

  it("rejects a health response whose version does not match the installed SDK version", async () => {
    // RED reason: the old waitForHealth only checked response.ok and isProcessAlive; a
    // 200 with a mismatched version field caused it to return true (healthy) even though
    // the running process is a different version.  fetchImpl was also mutation-blind in
    // the sibling test (isProcessAlive:false short-circuits before the fetch).  After the
    // fix, waitForHealth delegates to probeHealth and checks health.version === SDK_VERSION,
    // so a wrong-version 200 keeps looping until the deadline and returns false.
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 24681, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ status: "ok", version: "0.0.0-wrong" }, { status: 200 })),
    );
    const killProcess = vi.fn();
    const nowSpy = vi.spyOn(Date, "now");
    // Call 1 sets deadline (0 + startTimeoutMs); call 2 is the first while-check (0 ≤ deadline →
    // enter the loop, run exactly one fetch); call 3+ exceeds the deadline so the loop exits after
    // that single wrong-version probe and waitForHealth returns false.
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000_000);

    try {
      const code = await runLifecycleCli(
        "start",
        ["--port", "4322", "--start-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          spawnFn: () => child,
          fetchImpl,
          isProcessAlive: () => true,
          isPortAvailable: () => Promise.resolve(true),
          killProcess,
          sleep: () => Promise.resolve(),
        },
      );

      // fetchImpl must have been called (the seam is exercised)
      expect(fetchImpl).toHaveBeenCalled();
      // A 200 with a mismatched version is not a healthy start
      expect(code).toBe(1);
      expect(c.err()).toContain("UI did not become healthy");
      expect(killProcess).toHaveBeenCalledWith(24681, "SIGTERM");
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A detached spawn can fail ASYNCHRONOUSLY after returning; without an 'error'
  // listener Node throws the event and `keiko start` crashed with a raw stack.
  it("surfaces an async child spawn error cleanly instead of crashing", async () => {
    const root = makeRoot();
    const c = makeIo();
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    Object.assign(child, { pid: 13579, unref: vi.fn() });

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      {},
      {
        cwd: root,
        // The async failure surfaces only after spawn returned (real EMFILE shape).
        spawnFn: () => {
          queueMicrotask(() => {
            child.emit("error", new Error("spawn EMFILE"));
          });
          return child;
        },
        // The failed child never becomes healthy and is not alive.
        fetchImpl: () => Promise.reject(new Error("connection refused")),
        isProcessAlive: () => false,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("failed to launch (spawn EMFILE)");
  });

  it("fails cleanly when the UI child process has no pid", async () => {
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: undefined, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: () => child,
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("failed to spawn");
    expect(existsSync(join(root, ".keiko", "ui.pid"))).toBe(false);
  });

  it("closes UI log descriptors when spawning the UI process throws", async () => {
    const root = makeRoot();
    const c = makeIo();
    let logFds: { readonly stdoutFd: number; readonly stderrFd: number } | undefined;

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: (_command, _args, opts) => {
          logFds = childLogFds(opts);
          throw new Error("spawn failed");
        },
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("failed to spawn");
    const capturedLogFds = requireCapturedLogFds(logFds);
    expect(capturedLogFds.stdoutFd).not.toBe(capturedLogFds.stderrFd);
    expect(() => fstatSync(capturedLogFds.stdoutFd)).toThrow();
    expect(() => fstatSync(capturedLogFds.stderrFd)).toThrow();
    expect(existsSync(join(root, ".keiko", "ui.pid"))).toBe(false);
  });

  it("keeps a healthy start successful when opening the browser fails", async () => {
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await runLifecycleCli(
      "start",
      ["--open"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: () => child,
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        openExternal: () => {
          throw new Error("no desktop opener");
        },
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(c.out()).toContain("Keiko UI running");
    expect(c.err()).toContain("failed to open http://127.0.0.1:1983");
  });

  it("escalates stop to SIGKILL when the process misses the graceful deadline", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const killProcess = vi.fn();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);

    try {
      const code = await runLifecycleCli(
        "stop",
        ["--stop-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
          killProcess,
          sleep: () => Promise.resolve(),
        },
      );

      expect(code).toBe(0);
      expect(killProcess).toHaveBeenNthCalledWith(1, 12345, "SIGTERM");
      expect(killProcess).toHaveBeenNthCalledWith(2, 12345, "SIGKILL");
      expect(c.err()).toContain("sending SIGKILL");
      expect(c.out()).toContain("stopped (forced)");
      expect(existsSync(join(root, ".keiko", "ui.pid"))).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns failure when the process is still alive after SIGKILL", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const killProcess = vi.fn();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);

    try {
      const code = await runLifecycleCli(
        "stop",
        ["--stop-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          isProcessAlive: () => true,
          killProcess,
          sleep: () => Promise.resolve(),
        },
      );

      expect(code).toBe(1);
      expect(killProcess).toHaveBeenNthCalledWith(1, 12345, "SIGTERM");
      expect(killProcess).toHaveBeenNthCalledWith(2, 12345, "SIGKILL");
      expect(c.err()).toContain("failed to stop pid 12345");
      expect(readFileSync(join(root, ".keiko", "ui.pid"), "utf8")).toBe("12345\n");
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("safeKillProcess (ESRCH-safe default killer)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockKillThrowing(code: string): void {
    vi.spyOn(process, "kill").mockImplementation((): never => {
      throw Object.assign(new Error(`kill ${code}`), { code });
    });
  }

  it("swallows ESRCH — the target already exited, which is the intended end state", () => {
    mockKillThrowing("ESRCH");
    expect(() => {
      safeKillProcess(4242, "SIGTERM");
    }).not.toThrow();
  });

  it("rethrows a non-ESRCH error (e.g. EPERM) so real kill failures still surface", () => {
    mockKillThrowing("EPERM");
    expect(() => {
      safeKillProcess(4242, "SIGKILL");
    }).toThrow(/EPERM/u);
  });

  it("delivers the signal when the process exists", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation((): true => true);
    safeKillProcess(4242, "SIGTERM");
    expect(spy).toHaveBeenCalledWith(4242, "SIGTERM");
  });
});
