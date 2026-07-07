import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLiveCspSource,
  parseUiArgs,
  runUiCli,
  waitForShutdown,
  type UiCliArgs,
  type UiCliDeps,
} from "./ui.js";
import { DEFAULT_UI_PORT, extractInlineScriptHashes } from "@oscharko-dev/keiko-server";
import type { UiHandlerDeps } from "@oscharko-dev/keiko-server";
import type { CliIo } from "./runner.js";

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    out,
    err,
  };
}

function expectParsed(args: readonly string[]): UiCliArgs {
  const parsed = parseUiArgs(args);
  if (parsed === null || parsed === "help") {
    throw new Error(`expected parsed ui args for ${args.join(" ")}`);
  }
  return parsed;
}

// A fake server that records its listen call without binding a socket.
function fakeServer(record: { port?: number }): Server {
  return {
    listen(port: number, _host: string, cb: () => void): Server {
      record.port = port;
      cb();
      return this as unknown as Server;
    },
    once(): Server {
      return this as unknown as Server;
    },
  } as unknown as Server;
}

function expectSingleHandlerDeps(captured: readonly UiHandlerDeps[]): UiHandlerDeps {
  expect(captured).toHaveLength(1);
  const handlerDeps = captured[0];
  if (handlerDeps === undefined) {
    throw new Error("expected captured handler deps");
  }
  return handlerDeps;
}

describe("parseUiArgs", () => {
  it("defaults the port to 1983", () => {
    expect(parseUiArgs([])).toEqual({
      port: DEFAULT_UI_PORT,
      evidenceDir: undefined,
      config: undefined,
      uiDbPath: undefined,
    });
  });

  it("parses a valid --port", () => {
    expect(expectParsed(["--port", "5000"]).port).toBe(5000);
  });

  it("returns help for --help without interpreting adjacent flags", () => {
    expect(parseUiArgs(["--help", "--port", "5000"])).toBe("help");
    expect(parseUiArgs(["-h"])).toBe("help");
  });

  it("rejects unknown flags instead of ignoring them", () => {
    expect(parseUiArgs(["--no-open"])).toBeNull();
    expect(parseUiArgs(["--port", "5000", "--unknown"])).toBeNull();
  });

  it("rejects a non-numeric --port", () => {
    expect(parseUiArgs(["--port", "abc"])).toBeNull();
  });

  it("rejects an out-of-range --port", () => {
    expect(parseUiArgs(["--port", "70000"])).toBeNull();
  });

  it("rejects a --port flag with no value", () => {
    expect(parseUiArgs(["--port"])).toBeNull();
  });

  it("accepts --host 127.0.0.1 and localhost", () => {
    expect(parseUiArgs(["--host", "127.0.0.1"])).not.toBeNull();
    expect(parseUiArgs(["--host", "localhost"])).not.toBeNull();
  });

  it("rejects a non-loopback --host", () => {
    expect(parseUiArgs(["--host", "0.0.0.0"])).toBeNull();
    expect(parseUiArgs(["--host", "example.com"])).toBeNull();
  });

  it("captures --evidence-dir and --config", () => {
    const parsed = expectParsed(["--evidence-dir", "/e", "--config", "/c.json"]);
    expect(parsed.evidenceDir).toBe("/e");
    expect(parsed.config).toBe("/c.json");
  });

  it("captures --ui-db", () => {
    const parsed = expectParsed(["--ui-db", "/tmp/keiko-ui.db"]);
    expect(parsed.uiDbPath).toBe("/tmp/keiko-ui.db");
  });

  it("rejects --ui-db without a value", () => {
    expect(parseUiArgs(["--ui-db"])).toBeNull();
  });

  it("rejects --ui-db with a flag-shaped value", () => {
    expect(parseUiArgs(["--ui-db", "--port"])).toBeNull();
  });
});

describe("runUiCli", () => {
  let staticRoot: string;

  beforeEach(async () => {
    staticRoot = await mkdtemp(join(tmpdir(), "keiko-ui-cli-"));
    await writeFile(join(staticRoot, "index.html"), "<html></html>", "utf8");
  });

  afterEach(async () => {
    await rm(staticRoot, { recursive: true, force: true });
  });

  it("returns 2 and prints usage on a bad flag", async () => {
    const { io, err } = captureIo();
    const code = await runUiCli(["--host", "0.0.0.0"], io, {});
    expect(code).toBe(2);
    expect(err.join("")).toContain("Usage:");
  });

  it("prints help and exits before sqlite re-exec or server startup", async () => {
    const { io, out, err } = captureIo();
    let spawned = 0;
    const code = await runUiCli(
      ["--help", "--port", "1996"],
      io,
      {},
      {
        currentExecArgv: () => [],
        sqliteProbe: () => false,
        spawnFn: () => {
          spawned += 1;
          throw new Error("help must not re-exec");
        },
      },
    );

    expect(code).toBe(0);
    expect(out.join("")).toContain("keiko ui");
    expect(out.join("")).toContain("--port PORT");
    expect(err.join("")).toBe("");
    expect(spawned).toBe(0);
  });

  it("fails fast when --ui-db is relative", async () => {
    const { io, err } = captureIo();
    const code = await runUiCli(["--ui-db", ".keiko/ui.db"], io, {}, { staticRoot });
    expect(code).toBe(2);
    expect(err.join("")).toContain("UI database path must be absolute");
  });

  it("fails fast when --ui-db is inside the current workspace", async () => {
    const { io, err } = captureIo();
    const nested = join(process.cwd(), ".keiko-test-ui", "ui.db");
    const code = await runUiCli(["--ui-db", nested], io, {}, { staticRoot });
    expect(code).toBe(2);
    expect(err.join("")).toContain("UI database path must not be inside the current workspace");
  });

  it("returns 1 with a clear error when the static export is missing", async () => {
    const { io, err } = captureIo();
    const deps: UiCliDeps = { staticRoot: join(staticRoot, "does-not-exist") };
    const code = await runUiCli([], io, {}, deps);
    expect(code).toBe(1);
    expect(err.join("")).toContain("build:ui");
  });

  it("prefers the built workspace checkout over a stale inherited global static root", async () => {
    const { io, out } = captureIo();
    const cwd = await mkdtemp(join(tmpdir(), "keiko-ui-cli-checkout-"));
    const localStaticRoot = join(cwd, "dist", "ui", "static");
    const localCliRoot = join(cwd, "dist", "cli");
    const captured: { staticRoot?: string } = {};
    try {
      await writeFile(join(cwd, "package.json"), '{"name":"@oscharko-dev/keiko"}\n', "utf8");
      await mkdir(localStaticRoot, { recursive: true });
      await mkdir(localCliRoot, { recursive: true });
      await writeFile(join(localStaticRoot, "index.html"), "<html></html>", { encoding: "utf8" });
      await writeFile(join(localCliRoot, "index.js"), "#!/usr/bin/env node\n", {
        encoding: "utf8",
      });
      const code = await runUiCli(
        [],
        io,
        { KEIKO_UI_STATIC_ROOT: "/opt/old-keiko/dist/ui/static" },
        {
          cwd,
          hashesFile: join(staticRoot, "csp-hashes.json"),
          createServer: ({ staticRoot: resolvedStaticRoot }) => {
            captured.staticRoot = resolvedStaticRoot;
            return fakeServer({});
          },
        },
      );
      expect(code).toBe(0);
      expect(captured.staticRoot).toBe(localStaticRoot);
      expect(out.join("")).toContain("http://127.0.0.1:1983");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-execs through the built workspace checkout instead of a stale parent bin", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(tmpdir(), "keiko-ui-cli-reexec-"));
    const localStaticRoot = join(cwd, "dist", "ui", "static");
    const localCliEntry = join(cwd, "dist", "cli", "index.js");
    const spawned: { command: string; args: readonly string[] }[] = [];
    try {
      await writeFile(join(cwd, "package.json"), '{"name":"@oscharko-dev/keiko"}\n', "utf8");
      await mkdir(localStaticRoot, { recursive: true });
      await mkdir(join(cwd, "dist", "cli"), { recursive: true });
      await writeFile(join(localStaticRoot, "index.html"), "<html></html>", { encoding: "utf8" });
      await writeFile(localCliEntry, "#!/usr/bin/env node\n", { encoding: "utf8" });
      const code = await runUiCli(
        [],
        io,
        {},
        {
          cwd,
          currentExecArgv: () => [],
          sqliteProbe: () => false,
          spawnFn: (command, args) => {
            spawned.push({ command, args });
            const child = new EventEmitter() as EventEmitter & { kill: () => void };
            child.kill = (): void => undefined;
            queueMicrotask(() => child.emit("exit", 0, null));
            return child as never;
          },
        },
      );
      expect(code).toBe(0);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.args).toContain(localCliEntry);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("starts the server, listens on the parsed port, and prints the URL", async () => {
    const { io, out } = captureIo();
    const record: { port?: number; csp?: string } = {};
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      createServer: ({ csp }) => {
        record.csp = csp;
        return fakeServer(record);
      },
    };
    const code = await runUiCli(["--port", "4399"], io, {}, deps);
    expect(code).toBe(0);
    expect(record.port).toBe(4399);
    expect(record.csp).toContain("script-src");
    expect(out.join("")).toContain("http://127.0.0.1:4399");
  });

  it("defaults UI and memory state to the workspace-local .keiko runtime root", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(tmpdir(), "keiko-ui-cli-state-"));
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, {}, deps);
      expect(code).toBe(0);
      expect(captured[0]?.uiDbPath).toBe(join(cwd, ".keiko", "ui", "keiko-ui.db"));
      expect(captured[0]?.env.KEIKO_STATE_DIR).toBe(join(cwd, ".keiko"));
      expect(captured[0]?.env.KEIKO_MEMORY_DIR).toBe(join(cwd, ".keiko", "memory"));
      expect(captured[0]?.preferredProjectPath).toBe(cwd);
      expect(captured[0]?.store.listProjects().map((project) => project.path)).toEqual([cwd]);
      captured[0]?.store.close();
      captured[0]?.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("registers the launch cwd as a project before the server starts", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(tmpdir(), "keiko-ui-cli-launch-project-"));
    await writeFile(join(cwd, "package.json"), '{"name":"sandbox"}\n', "utf8");
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, {}, deps);
      expect(code).toBe(0);
      expect(captured[0]?.store.listProjects().map((project) => project.path)).toContain(cwd);
      captured[0]?.store.close();
      captured[0]?.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves explicit state overrides while defaulting missing runtime paths", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(tmpdir(), "keiko-ui-cli-state-override-"));
    const stateDir = join(cwd, "state");
    const uiDbPath = join(cwd, ".keiko", "ui", "custom-ui.db");
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli(["--ui-db", uiDbPath], io, { KEIKO_STATE_DIR: stateDir }, deps);
      expect(code).toBe(0);
      expect(captured[0]?.uiDbPath).toBe(uiDbPath);
      expect(captured[0]?.env.KEIKO_STATE_DIR).toBe(stateDir);
      expect(captured[0]?.env.KEIKO_UI_DATA_DIR).toBeUndefined();
      expect(captured[0]?.env.KEIKO_MEMORY_DIR).toBe(join(stateDir, "memory"));
      captured[0]?.store.close();
      captured[0]?.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not load trusted KEIKO_* runtime values from a repo-local .env", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(tmpdir(), "keiko-ui-cli-dotenv-"));
    const configPath = join(cwd, "gateway.json");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: [{ modelId: "example-chat-model", baseUrl: "", apiKey: "" }],
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".env"),
      [
        `KEIKO_CONFIG_FILE=${configPath}`,
        "KEIKO_MODEL_EXAMPLE_CHAT_MODEL_BASE_URL=https://models.example.invalid/openai/v1",
        "KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY=fake-test-key",
        "KEIKO_EVIDENCE_DIR=/tmp/keiko-attacker-evidence",
        "NPM_TOKEN=must-not-be-loaded",
        "FIGMA_ACCESS_TOKEN=figd_test_allowlisted",
      ].join("\n"),
      "utf8",
    );
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, {}, deps);
      expect(code).toBe(0);
      const handlerDeps = expectSingleHandlerDeps(captured);
      expect(handlerDeps.configPresent).toBe(false);
      expect(handlerDeps.config).toBeUndefined();
      expect(handlerDeps.env.KEIKO_CONFIG_FILE).toBeUndefined();
      expect(handlerDeps.env.KEIKO_MODEL_EXAMPLE_CHAT_MODEL_BASE_URL).toBeUndefined();
      expect(handlerDeps.env.KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY).toBeUndefined();
      expect(handlerDeps.env.KEIKO_EVIDENCE_DIR).toBeUndefined();
      expect(handlerDeps.env.NPM_TOKEN).toBeUndefined();
      // FIGMA_ACCESS_TOKEN remains the only repo-local .env exception (#751 connector contract).
      expect(handlerDeps.env.FIGMA_ACCESS_TOKEN).toBe("figd_test_allowlisted");
      handlerDeps.store.close();
      handlerDeps.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("createLiveCspSource", () => {
  it("reloads the CSP when csp-hashes.json changes after startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keiko-ui-csp-live-"));
    const staticRoot = join(dir, "static");
    const hashesFile = join(dir, "csp-hashes.json");
    const { io } = captureIo();
    try {
      await mkdir(staticRoot, { recursive: true });
      const html = "<html><body><script>window.__TEST__='new';</script></body></html>";
      await writeFile(join(staticRoot, "index.html"), html, "utf8");
      const [expectedHash] = extractInlineScriptHashes([html]);
      await writeFile(hashesFile, JSON.stringify(["'sha256-old'"]), "utf8");
      const runtime = await createLiveCspSource(staticRoot, hashesFile, io);
      expect(expectedHash).toBeDefined();
      if (expectedHash === undefined) throw new Error("expected inline script hash");
      expect(runtime.csp()).toContain(expectedHash);
      expect(runtime.csp()).not.toContain("'sha256-old'");
      await writeFile(hashesFile, JSON.stringify(["'sha256-new'"]), "utf8");
      await sleep(700);
      expect(runtime.csp()).toContain(expectedHash);
      expect(runtime.csp()).not.toContain("'sha256-new'");
      runtime.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runUiCli — node:sqlite re-exec guard (ADR-0013 D2)", () => {
  function fakeChild(exit: number): EventEmitter & { kill: () => void } {
    const emitter = new EventEmitter() as EventEmitter & { kill: () => void };
    emitter.kill = (): void => {
      /* no-op */
    };
    queueMicrotask(() => {
      emitter.emit("exit", exit, null);
    });
    return emitter;
  }

  it("re-execs and propagates the child exit code when sqlite is unavailable", async () => {
    const { io } = captureIo();
    const spawnCalls: {
      command: string;
      args: readonly string[];
      opts: import("node:child_process").SpawnOptions;
    }[] = [];
    const code = await runUiCli(
      [],
      io,
      {},
      {
        currentExecArgv: () => [],
        sqliteProbe: () => false,
        spawnFn: (cmd: string, args: readonly string[], opts) => {
          spawnCalls.push({ command: cmd, args, opts });
          return fakeChild(7) as unknown as import("node:child_process").ChildProcess;
        },
      },
    );
    expect(code).toBe(7);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args[0]).toBe("--experimental-sqlite");
    expect(spawnCalls[0]?.opts.argv0).toBe("Keiko");
  });

  // An async spawn-level failure (EMFILE, revoked exec permission) previously threw
  // the unlistened 'error' event and crashed the guard with a raw stack; it must
  // resolve to a clean non-zero exit instead.
  it("re-exec resolves 1 (instead of crashing) when the child emits error", async () => {
    const { io } = captureIo();
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = (): void => {
      /* no-op */
    };
    queueMicrotask(() => {
      child.emit("error", new Error("spawn EMFILE"));
    });
    const code = await runUiCli(
      [],
      io,
      {},
      {
        currentExecArgv: () => [],
        sqliteProbe: () => false,
        spawnFn: () => child as unknown as import("node:child_process").ChildProcess,
      },
    );
    expect(code).toBe(1);
    // The signal forwarders must be gone (no listener leak after the failure).
    expect(child.listenerCount("exit")).toBeGreaterThanOrEqual(0);
  });

  it("does not re-exec when sqlite is already importable", async () => {
    const { io, err } = captureIo();
    let spawned = 0;
    const code = await runUiCli(
      ["--host", "0.0.0.0"], // invalid → returns 2 after the (no-op) guard
      io,
      {},
      {
        currentExecArgv: () => [],
        sqliteProbe: () => true,
        spawnFn: () => {
          spawned += 1;
          return fakeChild(0) as unknown as import("node:child_process").ChildProcess;
        },
      },
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("Usage:");
    expect(spawned).toBe(0);
  });

  it("does not re-exec when an injected createServer is supplied (test path)", async () => {
    const { io } = captureIo();
    let spawned = 0;
    const record: { port?: number } = {};
    const dir = await mkdtemp(join(tmpdir(), "keiko-ui-cli-noexec-"));
    await writeFile(join(dir, "index.html"), "<html></html>", "utf8");
    try {
      const code = await runUiCli(
        ["--port", "4399"],
        io,
        {},
        {
          staticRoot: dir,
          hashesFile: join(dir, "csp-hashes.json"),
          createServer: () => fakeServer(record),
          currentExecArgv: () => [],
          sqliteProbe: () => false, // would normally trigger re-exec
          spawnFn: () => {
            spawned += 1;
            return fakeChild(0) as unknown as import("node:child_process").ChildProcess;
          },
        },
      );
      expect(code).toBe(0);
      expect(spawned).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not re-exec when --experimental-sqlite is already on NODE_OPTIONS", async () => {
    const { io } = captureIo();
    let spawned = 0;
    const code = await runUiCli(
      ["--host", "0.0.0.0"],
      io,
      { NODE_OPTIONS: "--experimental-sqlite" },
      {
        currentExecArgv: () => [],
        sqliteProbe: () => false,
        spawnFn: () => {
          spawned += 1;
          return fakeChild(0) as unknown as import("node:child_process").ChildProcess;
        },
      },
    );
    // alreadyFlagged short-circuits the guard → falls through to flag parsing → 2.
    expect(code).toBe(2);
    expect(spawned).toBe(0);
  });
});

describe("waitForShutdown", () => {
  it("resolves when the server emits close", async () => {
    const emitter = new EventEmitter();
    const server = emitter as unknown as Server;
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const promise = waitForShutdown(server);
    emitter.emit("close");
    await expect(promise).resolves.toBeUndefined();
    // Listeners added by waitForShutdown must be cleaned up after the close event.
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  // Emitting a real signal event would also invoke the test runner's own handlers,
  // so each signal test detaches every pre-existing listener and restores it after.
  function withIsolatedSignalListeners<T>(run: () => Promise<T>): Promise<T> {
    const priorSigint = process.rawListeners("SIGINT");
    const priorSigterm = process.rawListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    return run().finally(() => {
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      for (const listener of priorSigint) process.on("SIGINT", listener as () => void);
      for (const listener of priorSigterm) process.on("SIGTERM", listener as () => void);
    });
  }

  // Shutdown must be BOUNDED even with long-lived SSE streams open: server.close()
  // alone waits for in-flight responses forever, so after a signal the idle
  // keep-alive sockets are dropped immediately and any still-active connection is
  // force-terminated once the grace window passes. Reproduced hang before the fix:
  // one open SSE response kept SIGTERM from ever completing shutdown.
  it("force-closes lingering connections a bounded grace after a signal", async () => {
    await withIsolatedSignalListeners(async () => {
      vi.useFakeTimers();
      try {
        const emitter = new EventEmitter();
        const closeIdleConnections = vi.fn();
        const closeAllConnections = vi.fn();
        let closeCallback: (() => void) | undefined;
        const close = vi.fn((cb?: () => void) => {
          closeCallback = cb;
        });
        const server = Object.assign(emitter, {
          close,
          closeIdleConnections,
          closeAllConnections,
        }) as unknown as Server;

        const promise = waitForShutdown(server, 3_000);
        process.emit("SIGINT");

        // Idle sockets are dropped immediately; active ones get the grace window.
        expect(closeIdleConnections).toHaveBeenCalledTimes(1);
        expect(closeAllConnections).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2_999);
        expect(closeAllConnections).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(closeAllConnections).toHaveBeenCalledTimes(1);

        // Once the forced teardown lets close() finish, the promise settles.
        closeCallback?.();
        await expect(promise).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("skips the forced teardown when close completes within the grace window", async () => {
    await withIsolatedSignalListeners(async () => {
      vi.useFakeTimers();
      try {
        const emitter = new EventEmitter();
        const closeIdleConnections = vi.fn();
        const closeAllConnections = vi.fn();
        const close = vi.fn((cb?: () => void) => {
          cb?.();
        });
        const server = Object.assign(emitter, {
          close,
          closeIdleConnections,
          closeAllConnections,
        }) as unknown as Server;

        const promise = waitForShutdown(server, 3_000);
        process.emit("SIGTERM");
        await expect(promise).resolves.toBeUndefined();

        // The grace timer was cancelled — advancing time must not force-close.
        vi.advanceTimersByTime(10_000);
        expect(closeAllConnections).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
