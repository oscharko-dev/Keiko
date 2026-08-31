import {
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODING_APP_SESSION_LAUNCHER_SECRET_ENV,
  CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS,
  decodeCodingAppSessionPairingFragment,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { computeLauncherPairingClaim } from "@oscharko-dev/keiko-server";
import {
  WindowsSystemBinaryMissingError,
  type SecurityLogEvent,
} from "@oscharko-dev/keiko-security";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { resolveExternalOpener, runLifecycleCli, safeKillProcess } from "./lifecycle.js";
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
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      now += 600;
      return now;
    });
    // #KEIKO-0437: cmdStart's unhealthy branch now runs the shared terminateAndConfirm
    // loop. Model the child as "SIGTERM-responsive" so the terminate loop exits at its
    // first liveness poll — realistic behavior for a child that received SIGTERM, and
    // keeps these tests bounded to the wait-for-health path they exist to exercise.
    let aliveCalls = 0;
    try {
      const code = await runLifecycleCli(
        "start",
        ["--port", String(port), "--start-timeout", "1", "--stop-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          spawnFn: () => child,
          isProcessAlive: () => {
            aliveCalls += 1;
            return aliveCalls === 1;
          },
          isPortAvailable: () => Promise.resolve(true),
          killProcess: vi.fn(),
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
        // #KEIKO-0330: --state-dir is now home-contained; treat the test root as home so the
        // ".keiko-test" fixture resolves inside the approved boundary.
        homedir: () => root,
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
    // #KEIKO-0285: the env override must be an ABSOLUTE, EXISTING file — the value is
    // validated through `absoluteExistingPath` (the same guard install-layout.ts applies)
    // instead of returned verbatim. Anchor the fixture to a real file inside the test root
    // so the "env override is honored when valid" behavior is exercised without conflating
    // it with the unvalidated pass-through that #KEIKO-0285 removed.
    //
    // KEIKO-0553: cliEntryPath now reads KEIKO_CLI_BIN_PATH from the caller-supplied
    // EnvSource only (no per-key process.env fallback). Pass the value through the env
    // argument rather than by stubbing process.env — that ambient value is the exact
    // leak the fix closes.
    const binPath = join(root, "published-keiko-bin.js");
    writeFileSync(binPath, "#!/usr/bin/env node\n", "utf8");
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      { KEIKO_CLI_BIN_PATH: binPath },
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
    expect(spawned[0]?.args[0]).toBe(binPath);
  });

  it("refuses a KEIKO_STATE_DIR that resolves outside the user's home with STATE_DIR_ESCAPE", async (ctx) => {
    // #KEIKO-0330 must-fail-before-fix: buildLifecycleOptions/resolveStateDir accepted a
    // planted KEIKO_STATE_DIR unconditionally and `keiko start` proceeded to mkdir it.
    // After the fix, the same F4 assertRealpathContained(home, resolved) launcher enforces
    // is applied here — a value resolving outside home refuses with STATE_DIR_ESCAPE and
    // never creates the directory.
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const escapeRoot = makeRoot();
    const escapeDir = join(escapeRoot, "keiko-escape");
    const c = makeIo();
    const spawnFn = vi.fn();

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      { KEIKO_STATE_DIR: escapeDir },
      {
        cwd: root,
        homedir: () => home,
        spawnFn,
        isProcessAlive: () => false,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("KEIKO_STATE_DIR");
    expect(c.err()).toContain("outside the user's home directory");
    expect(existsSync(escapeDir)).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("refuses a --state-dir that resolves outside the user's home with STATE_DIR_ESCAPE", async (ctx) => {
    // Same F4 guard applies to the explicit --state-dir flag: a CLI-injected value
    // that escapes home is refused the same way as the env-planted variant.
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const escapeRoot = makeRoot();
    const escapeDir = join(escapeRoot, "keiko-escape-arg");
    const c = makeIo();
    const spawnFn = vi.fn();

    const code = await runLifecycleCli(
      "start",
      ["--state-dir", escapeDir],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => home,
        spawnFn,
        isProcessAlive: () => false,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("--state-dir");
    expect(c.err()).toContain("outside the user's home directory");
    expect(existsSync(escapeDir)).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("refuses a KEIKO_CLI_BIN_PATH that is not absolute — falls back to the packaged entry", async () => {
    // #KEIKO-0285 must-fail-before-fix: cliEntryPath used to return
    // process.env.KEIKO_CLI_BIN_PATH verbatim, so a relative value was spawned as
    // the child script. After the fix, `absoluteExistingPath` refuses non-absolute
    // values and cliEntryPath falls through to the packaged import.meta.url entry.
    // The injected EnvSource is the primary source, matching the rest of this file's
    // `optionOrEnv` pattern.
    const root = makeRoot();
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      { KEIKO_CLI_BIN_PATH: "relative/bin.js" },
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
    // The relative value must never reach spawnFn as the child entry script.
    expect(spawned[0]?.args[0]).not.toBe("relative/bin.js");
    // The fallback entry lives under this package's dist and ends in `index.js`.
    expect(spawned[0]?.args[0]).toMatch(/index\.js$/u);
  });

  it("refuses a KEIKO_CLI_BIN_PATH absolute path that does not exist — falls back to the packaged entry", async () => {
    // #KEIKO-0285: `absoluteExistingPath` also requires `existsSync(value)`, so an
    // attacker-planted absolute path (wrapper script in a dev-container .env, an exported
    // env var in a parent shell) is refused before spawn instead of being executed by Node.
    const root = makeRoot();
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      { KEIKO_CLI_BIN_PATH: "/nonexistent/keiko-bin-planted.js" },
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
    expect(spawned[0]?.args[0]).not.toBe("/nonexistent/keiko-bin-planted.js");
    expect(spawned[0]?.args[0]).toMatch(/index\.js$/u);
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

  // #2478 (ADR-0141 W1.5): `keiko start --open` is the launcher-automatic pairing flow — the
  // spawned BFF inherits a process-scoped pairing secret, and the opened URL carries one
  // single-use attestation in the fragment whose HMAC claim verifies against that same secret.
  function expectPairedOpen(spawnedEnv: NodeJS.ProcessEnv | undefined, opened: string): void {
    const provisionedSecret = spawnedEnv?.[CODING_APP_SESSION_LAUNCHER_SECRET_ENV] ?? "";
    expect(provisionedSecret.length).toBeGreaterThanOrEqual(
      CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS,
    );
    expect(opened.startsWith("http://127.0.0.1:1983/#keiko-app-session=")).toBe(true);
    const attestation = decodeCodingAppSessionPairingFragment(
      opened.slice("http://127.0.0.1:1983/".length),
    );
    if (attestation === undefined) throw new Error("opened URL carried no valid attestation");
    expect(attestation.claim).toBe(
      computeLauncherPairingClaim(provisionedSecret, attestation.requestId, attestation.issuedAtMs),
    );
  }

  it("accepts --open, provisions the pairing secret, and opens a paired boot URL", async () => {
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const openExternal = vi.fn();
    const spawnedEnvs: (NodeJS.ProcessEnv | undefined)[] = [];

    const code = await runLifecycleCli(
      "start",
      ["--open"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: (_command, _args, opts) => {
          spawnedEnvs.push(opts.env);
          return child;
        },
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        openExternal,
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(c.err()).toBe("");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expectPairedOpen(spawnedEnvs[0], String(openExternal.mock.calls[0]?.[0]));
  });

  // #2478 (Qodo #2514 finding 1): a percent-encoded pairing fragment must never pass through
  // cmd.exe, whose %...% expansion corrupts the URL and leaves the opened window unpaired.
  it("opens Windows URLs through an encoded PowerShell command, never cmd start", () => {
    const url = "http://127.0.0.1:1983/#keiko-app-session=%7B%22requestId%22%3A%22r%22%7D";
    const win = resolveExternalOpener(url, "win32");
    expect(win.command).not.toBe("powershell.exe");
    expect(win.command.toLowerCase()).toMatch(
      /\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/u,
    );
    expect(win.args).not.toContain(url);
    const encoded = win.args.at(-1) ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(`Start-Process '${url}'`);
    expect(resolveExternalOpener(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(resolveExternalOpener(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });

  it("honors an operator-provisioned launcher secret for the spawned BFF", async () => {
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const provided = "operator".padEnd(CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS, "x");
    const spawnedEnvs: (NodeJS.ProcessEnv | undefined)[] = [];

    const code = await runLifecycleCli(
      "start",
      [],
      c.io,
      { [CODING_APP_SESSION_LAUNCHER_SECRET_ENV]: provided },
      {
        cwd: root,
        spawnFn: (_command, _args, opts) => {
          spawnedEnvs.push(opts.env);
          return child;
        },
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        openExternal: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(spawnedEnvs[0]?.[CODING_APP_SESSION_LAUNCHER_SECRET_ENV]).toBe(provided);
  });

  it("opens an unpaired URL for an already-running UI and says how to re-pair", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const openExternal = vi.fn();

    const code = await runLifecycleCli(
      "start",
      ["--open"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: vi.fn(),
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
    expect(c.out()).toContain("keiko restart --open");
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
    // #KEIKO-0437 update: cmdStart's unhealthy branch now runs the shared
    // terminateAndConfirm loop. Advance Date.now monotonically (so the terminate
    // window also exits) and model the child as SIGTERM-responsive so the loop
    // exits at its first liveness poll after SIGTERM.
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 24681, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ status: "ok", version: "0.0.0-wrong" }, { status: 200 })),
    );
    const killProcess = vi.fn();
    const nowSpy = vi.spyOn(performance, "now");
    let now = 0;
    nowSpy.mockImplementation(() => {
      now += 600;
      return now;
    });
    let aliveCalls = 0;

    try {
      const code = await runLifecycleCli(
        "start",
        ["--port", "4322", "--start-timeout", "1", "--stop-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          spawnFn: () => child,
          fetchImpl,
          isProcessAlive: () => {
            aliveCalls += 1;
            return aliveCalls === 1;
          },
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

  it.each([
    [
      "hostile root",
      { SystemRoot: String.raw`\\attacker\share` },
      undefined,
      "security",
      "security.windows-lifecycle-opener.system-root-refused",
      "WindowsSystemDirectoryError",
    ],
    [
      "missing PowerShell",
      {},
      (): void => {
        throw new WindowsSystemBinaryMissingError();
      },
      "diagnostic",
      "security.windows-lifecycle-opener.system-binary-missing",
      "WINDOWS_SYSTEM_BINARY_MISSING",
    ],
  ] as const)(
    "keeps start successful and logs a body-free Windows opener %s failure",
    async (_label, env, openExternal, category, op, errorKind) => {
      const root = makeRoot();
      const c = makeIo();
      const events: SecurityLogEvent[] = [];
      const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

      const code = await runLifecycleCli("start", ["--open"], c.io, env, {
        cwd: root,
        platform: () => "win32",
        spawnFn: () => child,
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        ...(openExternal === undefined ? {} : { openExternal }),
        securityLogSinkFactory: () => ({
          write: (event): void => {
            events.push(event);
          },
        }),
        sleep: () => Promise.resolve(),
      });

      expect(code).toBe(0);
      expect(c.err()).toContain("failed to open http://127.0.0.1:1983");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ category, op, errorKind });
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(JSON.stringify(events)).not.toContain("attacker");
    },
  );

  it("escalates stop to SIGKILL when the process misses the graceful deadline", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const killProcess = vi.fn();
    // terminateAndConfirm uses performance.now for a monotonic deadline (Codex thread
    // 3771011316); mock it so the graceful loop expires after one iteration.
    const nowSpy = vi.spyOn(performance, "now");
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
    // terminateAndConfirm uses performance.now for a monotonic deadline (Codex thread
    // 3771011316); mock it so the graceful loop expires after one iteration.
    const nowSpy = vi.spyOn(performance, "now");
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

  it("escalates to SIGKILL and keeps the pid file when the UI did not become healthy and SIGKILL fails", async () => {
    // #KEIKO-0437 must-fail-before-fix: cmdStart used to send a single SIGTERM and
    // unconditionally remove the pid file, orphaning the UI when it survived SIGTERM.
    // After the fix, the unhealthy branch runs the shared terminateAndConfirm helper
    // (SIGTERM -> poll -> SIGKILL -> re-poll) and only removes the pid file when the
    // process is confirmed dead. When it survives SIGKILL too, the pid file MUST
    // remain so `keiko stop` can still find and finish the orphan.
    const root = makeRoot();
    const c = makeIo();
    const child = { pid: 45678, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const killProcess = vi.fn();
    // isProcessAlive stays true forever: SIGTERM never terminates the child; SIGKILL
    // also fails to kill (simulates a stuck kernel or another user's process the
    // uninstaller cannot signal).
    const nowSpy = vi.spyOn(performance, "now");
    let now = 0;
    nowSpy.mockImplementation(() => {
      now += 600;
      return now;
    });

    try {
      const code = await runLifecycleCli(
        "start",
        ["--start-timeout", "1", "--stop-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          spawnFn: () => child,
          fetchImpl: () =>
            Promise.resolve(Response.json({ version: "0.0.0-wrong" }, { status: 200 })),
          isProcessAlive: () => true,
          isPortAvailable: () => Promise.resolve(true),
          killProcess,
          sleep: () => Promise.resolve(),
        },
      );

      expect(code).toBe(1);
      // SIGTERM AND SIGKILL were both attempted — no more single-SIGTERM-and-forget.
      expect(killProcess).toHaveBeenNthCalledWith(1, 45678, "SIGTERM");
      expect(killProcess).toHaveBeenNthCalledWith(2, 45678, "SIGKILL");
      // Pid file survives so `keiko stop` can still find and finish the orphan.
      expect(existsSync(join(root, ".keiko", "ui.pid"))).toBe(true);
      expect(c.err()).toContain("did not become healthy");
      expect(c.err()).toContain("did not exit under SIGKILL");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("on Windows stop writes ui.shutdown and never SIGTERMs when the process exits", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const killProcess = vi.fn();
    const killWindowsTree = vi.fn(() => "succeeded" as const);
    let probe = true;
    const code = await runLifecycleCli(
      "stop",
      ["--stop-timeout", "10"],
      c.io,
      {},
      {
        cwd: root,
        platform: () => "win32",
        isProcessAlive: () => {
          if (probe) {
            probe = false;
            return true;
          }
          expect(readFileSync(join(root, ".keiko", "ui.shutdown"), "utf8")).toBe("12345\n");
          return false;
        },
        killProcess,
        killWindowsTree,
        sleep: () => Promise.resolve(),
      },
    );
    expect(code).toBe(0);
    expect(killProcess).not.toHaveBeenCalled();
    expect(killWindowsTree).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".keiko", "ui.pid"))).toBe(false);
    expect(existsSync(join(root, ".keiko", "ui.shutdown"))).toBe(false);
    expect(c.out()).toContain("Keiko UI stopped");
    expect(c.out()).not.toContain("forced");
  });

  it("on Windows stop escalates with tree-kill before SIGKILL", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const killProcess = vi.fn();
    const killWindowsTree = vi.fn(() => "succeeded" as const);
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      const code = await runLifecycleCli(
        "stop",
        ["--stop-timeout", "1"],
        c.io,
        {},
        {
          cwd: root,
          platform: () => "win32",
          isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
          killProcess,
          killWindowsTree,
          sleep: () => Promise.resolve(),
        },
      );
      expect(code).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
    expect(killProcess).not.toHaveBeenCalledWith(12345, "SIGTERM");
    expect(killWindowsTree).toHaveBeenCalledWith(12345, expect.any(Object));
    expect(killProcess).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(killWindowsTree.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      killProcess.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(c.err()).toContain("terminating the process tree");
    expect(c.out()).toContain("stopped (forced)");
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

// KEIKO-0886: <stateDir>/ui.log and <stateDir>/ui.pid must refuse to write through a
// pre-planted symlink so a state-dir actor cannot re-point them at any user-writable
// path. Skipped on Windows: NTFS symlink semantics differ and the fallback lstat
// refusal is exercised via cross-platform code review, not test.
describe("keiko start — refuses symlinked ui.log and ui.pid (KEIKO-0886)", () => {
  it("refuses to open a pre-planted symlinked ui.log without corrupting the target file", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const decoy = join(root, "victim-file.txt");
    const original = "unchanged\n";
    writeFileSync(decoy, original, "utf8");
    // Plant ui.log as a symlink pointing at the decoy.
    symlinkSync(decoy, join(stateDir, "ui.log"));

    const c = makeIo();
    const spawned: unknown[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const code = await runLifecycleCli(
      "start",
      ["--state-dir", ".keiko"],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => root,
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

    // The symlinked-log branch fails the start with a spawn-fail message (openUiLogStdio
    // throws before spawn runs) and never writes through the symlink.
    expect(code).toBe(1);
    // The decoy file is byte-identical before and after the attempt.
    expect(readFileSync(decoy, "utf8")).toBe(original);
    // The symlink itself is still a symlink (not replaced with a real file).
    expect(lstatSync(join(stateDir, "ui.log")).isSymbolicLink()).toBe(true);
  });

  // #2906 review (comment 3863185744): readPid had NO symlink guard at all (unlike the write
  // side's assertNotSymlink) -- readFileSync always follows a symlink. A symlinked ui.pid pointing
  // at an unrelated pid file would have `keiko stop` read THAT file's number and feed it straight
  // to isProcessAlive/process.kill, letting a state-dir actor steer a real signal at an
  // attacker-chosen process. Deterministic (no race needed): the pre-fix code follows a symlink
  // regardless of when it was planted, so a plain pre-planted one already proves the gap.
  it("refuses to follow a symlinked ui.pid on stop, so it never signals the symlink's target", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // A decoy pid file naming a real, unrelated process id an attacker wants signaled.
    const decoyPidFile = join(root, "decoy-target.pid");
    writeFileSync(decoyPidFile, "999999\n", "utf8");
    symlinkSync(decoyPidFile, join(stateDir, "ui.pid"));

    const c = makeIo();
    const killProcess = vi.fn();
    const code = await runLifecycleCli(
      "stop",
      [],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => root,
        isProcessAlive: () => true,
        killProcess,
        sleep: () => Promise.resolve(),
      },
    );

    // The symlink must never be followed: nothing gets signalled, and stop reports "not running"
    // (the fail-safe outcome for an unreadable/refused pid file) rather than treating the decoy's
    // pid as the real one.
    expect(killProcess).not.toHaveBeenCalled();
    expect(code).toBe(0);
    expect(c.out()).toContain("not running");
    // The symlink itself is what gets cleaned up; its target is never read or touched.
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(false);
    expect(readFileSync(decoyPidFile, "utf8")).toBe("999999\n");
  });

  // #2906 review (comment 3865159294): O_NOFOLLOW rejects only a SYMLINK at the final path
  // component; a HARD LINK is a plain directory entry pointing at a real, non-symlink inode, so
  // O_NOFOLLOW has nothing to object to. The pre-fix write path opened with O_TRUNC, which
  // overwrote whatever inode `ui.pid` currently named -- including a hard-linked victim file --
  // before fstat ever ran to reject it (the reviewer reproduced this: "an injected spawnFn
  // hardlink made keiko start return success after replacing the victim content with the PID").
  // Deterministic, no real race needed: the hardlink is planted from INSIDE the injected spawnFn
  // callback, which cmdStart invokes after runningPid's stale-file cleanup has already run but
  // strictly before writePid ever opens the path -- exactly reproducing the reviewer's repro
  // technique without relying on real filesystem timing.
  it("detects a hard-linked ui.pid at write time and never corrupts the hardlink's target file", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const victim = join(root, "victim-file.txt");
    const original = "unchanged\n";
    writeFileSync(victim, original, "utf8");

    const c = makeIo();
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const code = await runLifecycleCli(
      "start",
      ["--state-dir", ".keiko"],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => root,
        spawnFn: () => {
          linkSync(victim, join(stateDir, "ui.pid"));
          return child;
        },
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    // The victim file's content is byte-identical before and after: the write path never wrote
    // through the hard-linked inode.
    expect(readFileSync(victim, "utf8")).toBe(original);
    // `keiko start` self-heals per the reviewer's "unlink+recreate" instruction: it unlinks the
    // hostile name and creates a brand-new, single-link inode there instead of refusing outright,
    // so the command still succeeds and the real pid is published safely.
    expect(code).toBe(0);
    expect(readFileSync(join(stateDir, "ui.pid"), "utf8")).toBe("12345\n");
    expect(lstatSync(join(stateDir, "ui.pid")).nlink).toBe(1);
  });
});

// #2906 round 3 (comment 3865329050): O_NOFOLLOW refuses only a SYMLINK at the final path
// component. A hard link to another user's file has no symlink component (the syscall that
// blocks symlinks has nothing to object to), so it would receive every byte of the child's
// stdout/stderr; a FIFO can block the O_WRONLY open indefinitely before any post-open validation
// could ever run; a directory (or other non-regular entry) is accepted outright. The fix opens
// O_NONBLOCK (so a FIFO's open() fails fast instead of hanging) and fstat-verifies the OPENED
// descriptor is a regular, single-link file before it is ever handed to the child.
describe("keiko start — refuses a hard-linked/FIFO/non-regular ui.log (comment 3865329050)", () => {
  it("detects a hard-linked ui.log and never writes through the hardlink's target file", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const victim = join(root, "victim-log.txt");
    const original = "unchanged\n";
    writeFileSync(victim, original, "utf8");
    // Pre-plant the hard link BEFORE start runs: unlike ui.pid (written after spawn succeeds),
    // ui.log is opened by openUiLogStdio BEFORE spawnFn is ever invoked, so there is no
    // "inside spawnFn" window to plant it in — it must already be there.
    linkSync(victim, join(stateDir, "ui.log"));

    const c = makeIo();
    const spawned: unknown[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const code = await runLifecycleCli(
      "start",
      ["--state-dir", ".keiko"],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => root,
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

    // The refusal happens before spawn: no child process is ever launched, and the victim
    // file's content is byte-identical before and after.
    expect(spawned).toEqual([]);
    expect(code).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe(original);
    // The hard link itself is left in place — never unlinked, unlike the pid file's
    // unlink-and-recreate self-heal (ui.log has no such self-heal path).
    expect(lstatSync(join(stateDir, "ui.log")).nlink).toBeGreaterThan(1);
  });

  it("refuses a FIFO planted at ui.log without hanging (O_NONBLOCK)", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [join(stateDir, "ui.log")]);

    const c = makeIo();
    const spawned: unknown[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const code = await runLifecycleCli(
      "start",
      ["--state-dir", ".keiko"],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => root,
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

    // A blocking open() with no reader present would hang this test forever; reaching this
    // assertion at all proves the open failed fast instead. No child is ever launched.
    expect(spawned).toEqual([]);
    expect(code).toBe(1);
  }, 10_000);

  it("refuses a directory planted at ui.log", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, "ui.log"));

    const c = makeIo();
    const spawned: unknown[] = [];
    const child = { pid: 12345, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    const code = await runLifecycleCli(
      "start",
      ["--state-dir", ".keiko"],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => root,
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

    expect(spawned).toEqual([]);
    expect(code).toBe(1);
    // The directory is left exactly as planted — never removed or written into.
    expect(lstatSync(join(stateDir, "ui.log")).isDirectory()).toBe(true);
  });
});
