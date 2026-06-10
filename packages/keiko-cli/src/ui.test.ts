import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUiArgs, runUiCli, waitForShutdown, type UiCliArgs, type UiCliDeps } from "./ui.js";
import { DEFAULT_UI_PORT } from "@oscharko-dev/keiko-server";
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

  it("starts the server, listens on the parsed port, and prints the URL", async () => {
    const { io, out } = captureIo();
    const record: { port?: number } = {};
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      createServer: () => fakeServer(record),
    };
    const code = await runUiCli(["--port", "4399"], io, {}, deps);
    expect(code).toBe(0);
    expect(record.port).toBe(4399);
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

  it("loads KEIKO_* values from local .env and ignores unrelated keys", async () => {
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
        "NPM_TOKEN=must-not-be-loaded",
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
      expect(captured[0]?.configPresent).toBe(true);
      expect(captured[0]?.config?.providers[0]?.modelId).toBe("example-chat-model");
      expect(captured[0]?.env.NPM_TOKEN).toBeUndefined();
      captured[0]?.store.close();
      captured[0]?.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
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
    const spawnCalls: { command: string; args: readonly string[] }[] = [];
    const code = await runUiCli(
      [],
      io,
      {},
      {
        currentExecArgv: () => [],
        sqliteProbe: () => false,
        spawnFn: (cmd: string, args: readonly string[]) => {
          spawnCalls.push({ command: cmd, args });
          return fakeChild(7) as unknown as import("node:child_process").ChildProcess;
        },
      },
    );
    expect(code).toBe(7);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args[0]).toBe("--experimental-sqlite");
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
});
