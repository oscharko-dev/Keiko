import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The memory-vault path guard refuses any ancestor symlink, so macOS `os.tmpdir()`
// (which sits under `/var/folders/...` → `/private/var/...`) must be resolved once
// before every mkdtemp call whose result flows into a KEIKO_*_DIR.
const REAL_TMPDIR = realpathSync(tmpdir());
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLiveCspSource,
  parseUiArgs,
  runUiCli,
  startProcessHeartbeat,
  waitForShutdown,
  type UiCliArgs,
  type UiCliDeps,
} from "./ui.js";
import { DEFAULT_UI_PORT, UI_HOST } from "@oscharko-dev/keiko-contracts";
import { extractInlineScriptHashes } from "@oscharko-dev/keiko-server";
import type { ServerLogEvent, ServerLogSink, UiHandlerDeps } from "@oscharko-dev/keiko-server";
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

function closeHandlerDeps(handlerDeps: UiHandlerDeps | undefined): void {
  handlerDeps?.store.close();
  handlerDeps?.memoryVault?.close();
}

// A `ServerLogSink` that records every event in memory and counts `close()` calls, so a test
// can assert on the process-lifecycle log lines without touching the filesystem or loading the
// real `createFileServerLogSink`/`closeFileServerLogSinks` machinery.
interface RecordingSink extends ServerLogSink {
  readonly events: ServerLogEvent[];
  closeCallCount: number;
}

function createRecordingSink(): RecordingSink {
  const events: ServerLogEvent[] = [];
  const sink: RecordingSink = {
    events,
    closeCallCount: 0,
    write(event: ServerLogEvent): void {
      events.push(event);
    },
    close(): void {
      sink.closeCallCount += 1;
    },
  };
  return sink;
}

function extraOf(event: ServerLogEvent | undefined): Readonly<Record<string, unknown>> {
  return event?.extra ?? {};
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
    staticRoot = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-"));
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
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-checkout-"));
    const localStaticRoot = join(cwd, "dist", "ui", "static");
    const localCliRoot = join(cwd, "dist", "cli");
    const captured: { staticRoot?: string; handlerDeps?: UiHandlerDeps } = {};
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
          createServer: ({ staticRoot: resolvedStaticRoot, handlerDeps }) => {
            captured.staticRoot = resolvedStaticRoot;
            captured.handlerDeps = handlerDeps;
            return fakeServer({});
          },
        },
      );
      expect(code).toBe(0);
      expect(captured.staticRoot).toBe(localStaticRoot);
      expect(out.join("")).toContain("http://127.0.0.1:1983");
    } finally {
      closeHandlerDeps(captured.handlerDeps);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-execs through the built workspace checkout instead of a stale parent bin", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-reexec-"));
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
    let handlerDeps: UiHandlerDeps | undefined;
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd: staticRoot,
      createServer: ({ csp, handlerDeps: createdHandlerDeps }) => {
        record.csp = csp;
        handlerDeps = createdHandlerDeps;
        return fakeServer(record);
      },
    };
    try {
      const code = await runUiCli(["--port", "4399"], io, {}, deps);
      expect(code).toBe(0);
      expect(record.port).toBe(4399);
      expect(record.csp).toContain("script-src");
      expect(out.join("")).toContain("http://127.0.0.1:4399");
    } finally {
      closeHandlerDeps(handlerDeps);
    }
  });

  // Regression pin (KEIKO-0439): runUiCli built a live CspSource + file watcher, then handed the
  // server a value that was evaluated ONCE at startup. The watcher mutated `current`, nobody ever
  // read it again, and the server kept serving the stale Content-Security-Policy header after any
  // rebuild — the browser blocked the new inline scripts and the UI went blank until restart.
  // The server side already accepts a cspProvider callback; the CLI must forward the accessor,
  // not the snapshot.
  it("forwards a live cspProvider to createUiServer", async () => {
    const { io } = captureIo();
    interface CapturedCspDeps {
      csp?: string;
      cspProvider?: (() => string | Promise<string>) | undefined;
    }
    const captured: CapturedCspDeps = {};
    let handlerDeps: UiHandlerDeps | undefined;
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd: staticRoot,
      createServer: ({ csp, cspProvider, handlerDeps: createdHandlerDeps }) => {
        captured.csp = csp;
        captured.cspProvider = cspProvider;
        handlerDeps = createdHandlerDeps;
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli(["--port", "4399"], io, {}, deps);
      expect(code).toBe(0);
      // The compatibility snapshot is still passed too — server.ts keeps `csp` as a fallback.
      expect(captured.csp).toContain("script-src");
      // The load-bearing check: the provider callback was passed through.
      expect(typeof captured.cspProvider).toBe("function");
      const live = captured.cspProvider === undefined ? undefined : await captured.cspProvider();
      expect(live).toContain("script-src");
    } finally {
      closeHandlerDeps(handlerDeps);
    }
  });

  it("defaults UI and memory state to the workspace-local .keiko runtime root", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-state-"));
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
      expect(captured[0]?.env.KEIKO_EVIDENCE_DIR).toBe(join(cwd, ".keiko", "evidence"));
      expect(captured[0]?.preferredProjectPath).toBe(cwd);
      expect(captured[0]?.store.listProjects().map((project) => project.path)).toEqual([cwd]);
      captured[0]?.store.close();
      captured[0]?.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // The activity-log sink mkdirs `<stateDir>/logs` the moment it is CONSTRUCTED. Two things
  // therefore have to hold on the injected-server path: the state directory comes from the CLI's
  // own resolution (launch cwd + the effective env, NOT `process.env`), and no sink is built at
  // all — otherwise a unit test writes a log directory outside its fixture, wherever the process
  // happens to be running.
  it("resolves the state directory from the launch cwd and opens no log file under an injected server", async () => {
    const { io, err } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-state-relative-"));
    const processStateDir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-process-state-"));
    vi.stubEnv("KEIKO_STATE_DIR", processStateDir);
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
      const code = await runUiCli([], io, { KEIKO_STATE_DIR: ".keiko/runtime" }, deps);
      expect(err.join("")).toBe("");
      expect(code).toBe(0);
      // Relative, so it resolves against the launch cwd — not against the process working
      // directory and not against a bare `.keiko`.
      expect(captured[0]?.env.KEIKO_STATE_DIR).toBe(join(cwd, ".keiko", "runtime"));
      expect(existsSync(join(processStateDir, "logs"))).toBe(false);
      expect(existsSync(join(cwd, ".keiko", "runtime", "logs"))).toBe(false);
      captured[0]?.store.close();
      captured[0]?.memoryVault?.close();
    } finally {
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
      await rm(processStateDir, { recursive: true, force: true });
    }
  });

  it("registers the launch cwd as a project before the server starts", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-launch-project-"));
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
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-state-override-"));
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
      expect(captured[0]?.env.KEIKO_EVIDENCE_DIR).toBe(join(stateDir, "evidence"));
      captured[0]?.store.close();
      captured[0]?.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("propagates the resolved --evidence-dir into the child env instead of leaving it unset", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-evidence-flag-"));
    const evidenceDir = join(cwd, "custom-evidence");
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
      const code = await runUiCli(["--evidence-dir", evidenceDir], io, {}, deps);
      expect(code).toBe(0);
      const handlerDeps = expectSingleHandlerDeps(captured);
      // The explicit flag is passed straight through to `buildUiHandlerDeps`, and the derived env
      // must carry the SAME resolved directory rather than leaving `KEIKO_EVIDENCE_DIR` unset next
      // to it — otherwise a child process that reads `KEIKO_EVIDENCE_DIR` directly, rather than
      // re-deriving `EvidenceStore`'s own precedence, would fall back to its own default and see a
      // different directory than the one the CLI actually resolved.
      expect(handlerDeps.env.KEIKO_EVIDENCE_DIR).toBe(evidenceDir);
      handlerDeps.store.close();
      handlerDeps.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves a relative --evidence-dir against cwd before propagating it to the child env", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-evidence-relative-"));
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
      const code = await runUiCli(["--evidence-dir", "relative-evidence"], io, {}, deps);
      expect(code).toBe(0);
      const handlerDeps = expectSingleHandlerDeps(captured);
      expect(handlerDeps.env.KEIKO_EVIDENCE_DIR).toBe(join(cwd, "relative-evidence"));
      handlerDeps.store.close();
      handlerDeps.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // No --evidence-dir flag: the else-if guard must leave an already-set KEIKO_EVIDENCE_DIR alone,
  // the same way it always has, rather than overwriting it with the `<stateDir>/evidence` default.
  it("keeps an already-set KEIKO_EVIDENCE_DIR when --evidence-dir is absent", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-evidence-preset-"));
    const presetEvidenceDir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-evidence-preset-env-"));
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
      const code = await runUiCli([], io, { KEIKO_EVIDENCE_DIR: presetEvidenceDir }, deps);
      expect(code).toBe(0);
      const handlerDeps = expectSingleHandlerDeps(captured);
      expect(handlerDeps.env.KEIKO_EVIDENCE_DIR).toBe(presetEvidenceDir);
      handlerDeps.store.close();
      handlerDeps.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(presetEvidenceDir, { recursive: true, force: true });
    }
  });

  it("does not load trusted KEIKO_* runtime values from a repo-local .env", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-dotenv-"));
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
      // The attacker's injected path must not survive — `withDefaultLocalRuntimeStateEnv` fills
      // the gap with the SAME safe `<stateDir>/evidence` default it would use had the .env file
      // never mentioned the variable at all, never with the value the .env file supplied.
      expect(handlerDeps.env.KEIKO_EVIDENCE_DIR).toBe(join(cwd, ".keiko", "evidence"));
      expect(handlerDeps.env.NPM_TOKEN).toBeUndefined();
      // FIGMA_ACCESS_TOKEN remains the only repo-local .env exception (#751 connector contract).
      expect(handlerDeps.env.FIGMA_ACCESS_TOKEN).toBe("figd_test_allowlisted");
      handlerDeps.store.close();
      handlerDeps.memoryVault?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // `deps.activityLog` is the seam: injecting a recording sink alongside the fake `createServer`
  // exercises `process.started` without ever building the real file sink or loading the real
  // HTTP server graph (the same "must not load the real server module graph" rule the other
  // injected-server tests in this suite already hold to).
  it("writes process.started with the documented envelope and fields", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-process-started-"));
    const sink = createRecordingSink();
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      activityLog: sink,
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, { KEIKO_LOG_LEVEL: "debug" }, deps);
      expect(code).toBe(0);
      const started = sink.events.find((event) => event.op === "process.started");
      expect(started).toBeDefined();
      expect(started?.category).toBe("process");
      expect(started?.level).toBe("info");
      const extra = extraOf(started);
      expect(extra.nodeVersion).toBe(process.version);
      expect(extra.platform).toBe(process.platform);
      expect(extra.arch).toBe(process.arch);
      expect(typeof extra.productVersion).toBe("string");
      expect(extra.host).toBe(UI_HOST);
      expect(extra.port).toBe(DEFAULT_UI_PORT);
      expect(extra.stateDirSource).toBe("default");
      expect(extra.logLevel).toBe("debug");
      // Neither is computable without loading the real server module graph (`installMode`) or a
      // resolved gateway config (`gatewayProviderCount`, and no `--config` was given here) — both
      // are correctly absent on the injected-server path, never a fabricated placeholder value.
      expect(extra.installMode).toBeUndefined();
      expect(extra.gatewayProviderCount).toBeUndefined();
      // The injected-server path never blocks on `waitForShutdown`, so no heartbeat is scheduled
      // and the sink is never closed — `runUiCli` resolving at all already proves that.
      expect(sink.events.some((event) => event.op === "process.heartbeat")).toBe(false);
      expect(sink.closeCallCount).toBe(0);
      closeHandlerDeps(captured[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // `reportProcessStarted` runs the install-mode probe AFTER `listen()` has already succeeded and
  // the CLI has already printed the listening URL — a probe failure (a permission error, an
  // unreadable parent directory) must never abort a launch whose server is already up.
  it("omits installMode and records installModeErrorKind when the install-mode probe throws", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-install-mode-probe-"));
    const sink = createRecordingSink();
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      activityLog: sink,
      installModeProbe: () => Promise.reject(new Error("install-mode probe boom")),
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, {}, deps);
      expect(code).toBe(0);
      const started = sink.events.find((event) => event.op === "process.started");
      expect(started).toBeDefined();
      const extra = extraOf(started);
      expect(extra.installMode).toBeUndefined();
      // The class only — the raw message must never reach the line (it is foreign free text).
      expect(extra.installModeErrorKind).toBe("Error");
      expect(JSON.stringify(started)).not.toContain("install-mode probe boom");
      closeHandlerDeps(captured[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // The class-only fallback (`typeof error` rather than `error.name`) for a probe that rejects
  // with something other than an Error — still recorded, never swallowed.
  it("records installModeErrorKind as the thrown value's typeof when the probe rejects a non-Error", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-install-mode-probe-nonerror-"));
    const sink = createRecordingSink();
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      activityLog: sink,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- pinning the non-Error fallback
      installModeProbe: () => Promise.reject("install-mode probe boom"),
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, {}, deps);
      expect(code).toBe(0);
      const started = sink.events.find((event) => event.op === "process.started");
      const extra = extraOf(started);
      expect(extra.installMode).toBeUndefined();
      expect(extra.installModeErrorKind).toBe("string");
      expect(JSON.stringify(started)).not.toContain("install-mode probe boom");
      closeHandlerDeps(captured[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records installMode when the injected install-mode probe resolves a value", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-install-mode-probe-resolved-"));
    const sink = createRecordingSink();
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      activityLog: sink,
      installModeProbe: () => Promise.resolve("package-manager"),
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, {}, deps);
      expect(code).toBe(0);
      const started = sink.events.find((event) => event.op === "process.started");
      const extra = extraOf(started);
      expect(extra.installMode).toBe("package-manager");
      expect(extra.installModeErrorKind).toBeUndefined();
      closeHandlerDeps(captured[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records gatewayProviderCount on process.started when a gateway config resolves providers", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-gateway-provider-count-"));
    const configPath = join(cwd, "gateway.json");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://models.example.invalid/v1",
            apiKey: "k",
          },
        ],
      }),
      "utf8",
    );
    const sink = createRecordingSink();
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      activityLog: sink,
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli(["--config", configPath], io, {}, deps);
      expect(code).toBe(0);
      const handlerDeps = expectSingleHandlerDeps(captured);
      expect(handlerDeps.config?.providers.length).toBe(1);
      const started = sink.events.find((event) => event.op === "process.started");
      expect(extraOf(started).gatewayProviderCount).toBe(1);
      closeHandlerDeps(captured[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("labels process.started's stateDirSource as env-override when KEIKO_STATE_DIR is set", async () => {
    const { io } = captureIo();
    const cwd = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-process-started-env-"));
    // Outside `cwd` entirely: `assertUiDbOutsideProject` (keiko-server store/paths.ts) refuses a
    // default UI database path nested inside the launch project unless the intervening directory
    // is the recognised runtime-state root name, which a differently-named override is not.
    const stateDir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-process-started-env-state-"));
    const sink = createRecordingSink();
    const captured: UiHandlerDeps[] = [];
    const deps: UiCliDeps = {
      staticRoot,
      hashesFile: join(staticRoot, "csp-hashes.json"),
      cwd,
      activityLog: sink,
      createServer: ({ handlerDeps }) => {
        captured.push(handlerDeps);
        return fakeServer({});
      },
    };
    try {
      const code = await runUiCli([], io, { KEIKO_STATE_DIR: stateDir }, deps);
      expect(code).toBe(0);
      const started = sink.events.find((event) => event.op === "process.started");
      expect(extraOf(started).stateDirSource).toBe("env-override");
      closeHandlerDeps(captured[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("createLiveCspSource", () => {
  // Regression pin (KEIKO-0439): the original assertions were identical before and after the
  // watcher was supposed to fire — both reads landed in the runtime-hash fallback branch of
  // loadCspMaterial because the stored hash list never matched the runtime hashes, so the test
  // could not detect a broken reload. Rewrite BOTH the static export's inline script AND the
  // csp-hashes.json to a mutually-matching new hash, wait past the 500ms watch interval, and
  // assert the header actually changed from the old hash to the new one.
  it("reloads the CSP when csp-hashes.json changes after startup", async () => {
    const dir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-csp-live-"));
    const staticRoot = join(dir, "static");
    const hashesFile = join(dir, "csp-hashes.json");
    const indexHtml = join(staticRoot, "index.html");
    const { io } = captureIo();
    try {
      await mkdir(staticRoot, { recursive: true });
      const initialHtml = "<html><body><script>window.__TEST__='before';</script></body></html>";
      await writeFile(indexHtml, initialHtml, "utf8");
      const [initialHash] = extractInlineScriptHashes([initialHtml]);
      expect(initialHash).toBeDefined();
      if (initialHash === undefined) throw new Error("expected initial inline script hash");
      // Match runtime + stored so loadCspMaterial's stored-hash branch (not the fallback) runs.
      await writeFile(hashesFile, JSON.stringify([initialHash]), "utf8");
      const runtime = await createLiveCspSource(staticRoot, hashesFile, io);
      expect(runtime.csp()).toContain(initialHash);

      // Rewrite BOTH the exported HTML and the stored hash list so they still match, but to a
      // different inline script → different hash. The watcher on csp-hashes.json fires reload(),
      // which re-reads static/index.html and recomputes the runtime hashes.
      const nextHtml = "<html><body><script>window.__TEST__='after';</script></body></html>";
      await writeFile(indexHtml, nextHtml, "utf8");
      const [nextHash] = extractInlineScriptHashes([nextHtml]);
      expect(nextHash).toBeDefined();
      if (nextHash === undefined) throw new Error("expected next inline script hash");
      expect(nextHash).not.toBe(initialHash);
      await writeFile(hashesFile, JSON.stringify([nextHash]), "utf8");
      await sleep(700);

      // The header must have actually changed — before/after assertions differ.
      expect(runtime.csp()).toContain(nextHash);
      expect(runtime.csp()).not.toContain(initialHash);
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

  // Regression pin (KEIKO-0443): the three "does not re-exec" tests below previously used the
  // invalid `["--host", "0.0.0.0"]` args, so parseUiArgsOrExit returned 2 *before* the sqlite
  // guard ran and neither `sqliteProbe`, the NODE_OPTIONS branch of `alreadyFlagged`, nor the
  // execArgv branch was ever exercised. They now pass valid args and stub `createServer` via the
  // same pattern as "does not re-exec when an injected createServer is supplied", so the guard
  // actually runs. `spawned === 0` is the load-bearing assertion.
  it("does not re-exec when sqlite is already importable", async () => {
    const { io } = captureIo();
    let spawned = 0;
    const record: { port?: number } = {};
    const dir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-noexec-probe-"));
    let handlerDeps: UiHandlerDeps | undefined;
    await writeFile(join(dir, "index.html"), "<html></html>", "utf8");
    try {
      const code = await runUiCli(
        ["--port", "4399"],
        io,
        {},
        {
          staticRoot: dir,
          hashesFile: join(dir, "csp-hashes.json"),
          cwd: dir,
          createServer: ({ handlerDeps: createdHandlerDeps }) => {
            handlerDeps = createdHandlerDeps;
            return fakeServer(record);
          },
          currentExecArgv: () => [],
          sqliteProbe: () => true,
          spawnFn: () => {
            spawned += 1;
            return fakeChild(0) as unknown as import("node:child_process").ChildProcess;
          },
        },
      );
      expect(code).toBe(0);
      expect(spawned).toBe(0);
    } finally {
      closeHandlerDeps(handlerDeps);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not re-exec when an injected createServer is supplied (test path)", async () => {
    const { io } = captureIo();
    let spawned = 0;
    const record: { port?: number } = {};
    const dir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-noexec-"));
    let handlerDeps: UiHandlerDeps | undefined;
    await writeFile(join(dir, "index.html"), "<html></html>", "utf8");
    try {
      const code = await runUiCli(
        ["--port", "4399"],
        io,
        {},
        {
          staticRoot: dir,
          hashesFile: join(dir, "csp-hashes.json"),
          cwd: dir,
          createServer: ({ handlerDeps: createdHandlerDeps }) => {
            handlerDeps = createdHandlerDeps;
            return fakeServer(record);
          },
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
      closeHandlerDeps(handlerDeps);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not re-exec when --experimental-sqlite is already on NODE_OPTIONS", async () => {
    const { io } = captureIo();
    let spawned = 0;
    const record: { port?: number } = {};
    const dir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-noexec-nodeopt-"));
    let handlerDeps: UiHandlerDeps | undefined;
    await writeFile(join(dir, "index.html"), "<html></html>", "utf8");
    try {
      const code = await runUiCli(
        ["--port", "4399"],
        io,
        { NODE_OPTIONS: "--experimental-sqlite" },
        {
          staticRoot: dir,
          hashesFile: join(dir, "csp-hashes.json"),
          cwd: dir,
          createServer: ({ handlerDeps: createdHandlerDeps }) => {
            handlerDeps = createdHandlerDeps;
            return fakeServer(record);
          },
          currentExecArgv: () => [],
          sqliteProbe: () => false,
          spawnFn: () => {
            spawned += 1;
            return fakeChild(0) as unknown as import("node:child_process").ChildProcess;
          },
        },
      );
      // alreadyFlagged short-circuits via the NODE_OPTIONS branch; server startup then proceeds.
      expect(code).toBe(0);
      expect(spawned).toBe(0);
    } finally {
      closeHandlerDeps(handlerDeps);
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Regression pin (KEIKO-0443): the execArgv branch of `alreadyFlagged` had zero coverage — every
  // pre-existing test set currentExecArgv to `() => []`. A regression that dropped the execArgv
  // check would go unnoticed by this suite even though it is the branch that stops the re-exec
  // guard from looping when the CLI is already inside the child.
  it("does not re-exec when --experimental-sqlite is already on currentExecArgv", async () => {
    const { io } = captureIo();
    let spawned = 0;
    const record: { port?: number } = {};
    const dir = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-cli-noexec-execargv-"));
    let handlerDeps: UiHandlerDeps | undefined;
    await writeFile(join(dir, "index.html"), "<html></html>", "utf8");
    try {
      const code = await runUiCli(
        ["--port", "4399"],
        io,
        {},
        {
          staticRoot: dir,
          hashesFile: join(dir, "csp-hashes.json"),
          cwd: dir,
          createServer: ({ handlerDeps: createdHandlerDeps }) => {
            handlerDeps = createdHandlerDeps;
            return fakeServer(record);
          },
          currentExecArgv: () => ["--experimental-sqlite"],
          sqliteProbe: () => false,
          spawnFn: () => {
            spawned += 1;
            return fakeChild(0) as unknown as import("node:child_process").ChildProcess;
          },
        },
      );
      expect(code).toBe(0);
      expect(spawned).toBe(0);
    } finally {
      closeHandlerDeps(handlerDeps);
      await rm(dir, { recursive: true, force: true });
    }
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

  // process.exiting must land on EVERY shutdown branch, before the sink is closed, carrying the
  // reason that branch actually took and the elapsed time since `startedAt` — and the heartbeat's
  // stop callback must fire on every one of them too, never only on the happy path.
  describe("process.exiting", () => {
    function fakeClosingServer(): {
      readonly server: Server;
      readonly emitter: EventEmitter;
    } {
      const emitter = new EventEmitter();
      const server = Object.assign(emitter, {
        close: vi.fn((cb?: () => void) => cb?.()),
        closeIdleConnections: vi.fn(),
        closeAllConnections: vi.fn(),
      }) as unknown as Server;
      return { server, emitter };
    }

    it("reports reason 'sigint', stops the heartbeat, and closes the sink", async () => {
      await withIsolatedSignalListeners(async () => {
        const { server } = fakeClosingServer();
        const sink = createRecordingSink();
        const onShutdown = vi.fn();
        const startedAt = Date.now() - 5_000;
        const promise = waitForShutdown(server, 3_000, {
          activityLog: sink,
          startedAt,
          onShutdown,
        });
        process.emit("SIGINT");
        await expect(promise).resolves.toBeUndefined();
        expect(onShutdown).toHaveBeenCalledTimes(1);
        const exiting = sink.events.find((event) => event.op === "process.exiting");
        expect(exiting?.category).toBe("process");
        const extra = extraOf(exiting);
        expect(extra.reason).toBe("sigint");
        expect(extra.uptimeMs).toBeGreaterThanOrEqual(5_000);
        expect(sink.closeCallCount).toBe(1);
      });
    });

    it("reports reason 'sigterm'", async () => {
      await withIsolatedSignalListeners(async () => {
        const { server } = fakeClosingServer();
        const sink = createRecordingSink();
        const onShutdown = vi.fn();
        const promise = waitForShutdown(server, 3_000, {
          activityLog: sink,
          startedAt: Date.now(),
          onShutdown,
        });
        process.emit("SIGTERM");
        await expect(promise).resolves.toBeUndefined();
        expect(onShutdown).toHaveBeenCalledTimes(1);
        const exiting = sink.events.find((event) => event.op === "process.exiting");
        expect(extraOf(exiting).reason).toBe("sigterm");
        expect(sink.closeCallCount).toBe(1);
      });
    });

    it("reports reason 'server-close' when the server closes without a prior signal", async () => {
      await withIsolatedSignalListeners(async () => {
        const emitter = new EventEmitter();
        const server = emitter as unknown as Server;
        const sink = createRecordingSink();
        const onShutdown = vi.fn();
        const promise = waitForShutdown(server, 3_000, {
          activityLog: sink,
          startedAt: Date.now(),
          onShutdown,
        });
        emitter.emit("close");
        await expect(promise).resolves.toBeUndefined();
        expect(onShutdown).toHaveBeenCalledTimes(1);
        const exiting = sink.events.find((event) => event.op === "process.exiting");
        expect(extraOf(exiting).reason).toBe("server-close");
        expect(sink.closeCallCount).toBe(1);
      });
    });

    // A throwing onShutdown must not suppress the line — the doc comment on
    // WaitForShutdownActivity.onShutdown states this guarantee explicitly, and an unguarded call
    // would let the throw propagate out of the SIGINT listener itself, aborting shutdown before
    // the sink closes.
    it("still writes the line and closes the sink when onShutdown throws", async () => {
      await withIsolatedSignalListeners(async () => {
        const { server } = fakeClosingServer();
        const sink = createRecordingSink();
        const onShutdown = vi.fn(() => {
          throw new Error("heartbeat teardown boom");
        });
        const promise = waitForShutdown(server, 3_000, {
          activityLog: sink,
          startedAt: Date.now(),
          onShutdown,
        });
        process.emit("SIGINT");
        await expect(promise).resolves.toBeUndefined();
        expect(onShutdown).toHaveBeenCalledTimes(1);
        const exiting = sink.events.find((event) => event.op === "process.exiting");
        expect(extraOf(exiting).reason).toBe("sigint");
        // The class only — the raw message must never reach the line (it is foreign free text).
        expect(extraOf(exiting).onShutdownErrorKind).toBe("Error");
        expect(JSON.stringify(exiting)).not.toContain("heartbeat teardown boom");
        expect(sink.closeCallCount).toBe(1);
      });
    });

    // The class-only fallback (`typeof error` rather than `error.name`) for an onShutdown that
    // throws something other than an Error — still recorded, never swallowed.
    it("records onShutdownErrorKind as the thrown value's typeof when onShutdown throws a non-Error", async () => {
      await withIsolatedSignalListeners(async () => {
        const { server } = fakeClosingServer();
        const sink = createRecordingSink();
        const onShutdown = vi.fn(() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- pinning the non-Error fallback
          throw "heartbeat teardown boom";
        });
        const promise = waitForShutdown(server, 3_000, {
          activityLog: sink,
          startedAt: Date.now(),
          onShutdown,
        });
        process.emit("SIGINT");
        await expect(promise).resolves.toBeUndefined();
        const exiting = sink.events.find((event) => event.op === "process.exiting");
        expect(extraOf(exiting).onShutdownErrorKind).toBe("string");
        expect(JSON.stringify(exiting)).not.toContain("heartbeat teardown boom");
      });
    });

    // `closeActivityLog` (threaded from `startUiServer`'s real-launch path) is the module's own
    // `closeFileServerLogSinks`, reached directly rather than through `activityLog.close?.()` —
    // when supplied, it must be the one actually called, not the sink's own `close`.
    it("calls closeActivityLog instead of activityLog.close() when both are supplied", async () => {
      await withIsolatedSignalListeners(async () => {
        const { server } = fakeClosingServer();
        const sink = createRecordingSink();
        const closeActivityLog = vi.fn();
        const promise = waitForShutdown(server, 3_000, {
          activityLog: sink,
          startedAt: Date.now(),
          closeActivityLog,
        });
        process.emit("SIGINT");
        await expect(promise).resolves.toBeUndefined();
        expect(closeActivityLog).toHaveBeenCalledTimes(1);
        expect(sink.closeCallCount).toBe(0);
      });
    });

    it("does nothing and never warns when no activity log was supplied and onShutdown succeeds", async () => {
      await withIsolatedSignalListeners(async () => {
        const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
        const { server } = fakeClosingServer();
        const onShutdown = vi.fn();
        const promise = waitForShutdown(server, 3_000, { onShutdown });
        process.emit("SIGINT");
        await expect(promise).resolves.toBeUndefined();
        expect(onShutdown).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    // No activity-log line can carry the failure kind on this path (no log in scope), so it must
    // still reach an operator on the independent process-warning channel — the same idiom
    // `knowledge-log.ts`'s dead-sink report uses — instead of vanishing with the shutdown path
    // that produced it (#2902 PR review).
    it("warns via process.emitWarning when onShutdown throws and no activity log is in scope", async () => {
      await withIsolatedSignalListeners(async () => {
        const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
        const { server } = fakeClosingServer();
        const onShutdown = vi.fn(() => {
          throw new Error("heartbeat teardown boom");
        });
        const promise = waitForShutdown(server, 3_000, { onShutdown });
        process.emit("SIGINT");
        await expect(promise).resolves.toBeUndefined();
        expect(onShutdown).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        const calls: readonly (readonly unknown[])[] = warn.mock.calls;
        expect(calls[0]?.[1]).toMatchObject({
          code: "KEIKO_SHUTDOWN_HOOK_FAILED",
          detail: "errorKind=Error",
        });
        // The class only — the raw message must never reach the warning (it is foreign free text).
        expect(JSON.stringify(warn.mock.calls)).not.toContain("heartbeat teardown boom");
      });
    });
  });
});

describe("startProcessHeartbeat", () => {
  // Proves the fix for the leak this work item's spec calls out by name: an unref()'d interval
  // that is never cleared would keep ticking (and, in production, keep writing lines) forever
  // past shutdown. `vi.getTimerCount()` dropping to zero after `stop()` is the direct assertion
  // that no interval survives.
  it("writes process.heartbeat while running and leaves no timer behind once stopped", () => {
    vi.useFakeTimers();
    try {
      const sink = createRecordingSink();
      const stop = startProcessHeartbeat(sink, 1_000);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1_000);
      const heartbeat = sink.events.find((event) => event.op === "process.heartbeat");
      expect(heartbeat).toBeDefined();
      expect(heartbeat?.category).toBe("process");
      const extra = extraOf(heartbeat);
      expect(typeof extra.rssBytes).toBe("number");
      expect(typeof extra.heapUsedBytes).toBe("number");
      expect(typeof extra.heapTotalBytes).toBe("number");
      expect(typeof extra.externalBytes).toBe("number");
      expect(typeof extra.eventLoopDelayP99Ms).toBe("number");
      stop();
      expect(vi.getTimerCount()).toBe(0);
      // A tick after `stop()` must not produce another line — the interval is really gone, not
      // merely unreferenced.
      const countAfterStop = sink.events.filter((event) => event.op === "process.heartbeat").length;
      vi.advanceTimersByTime(5_000);
      expect(sink.events.filter((event) => event.op === "process.heartbeat")).toHaveLength(
        countAfterStop,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // `monitorEventLoopDelay()` accumulates samples cumulatively until `reset()` is called (Node
  // docs), so each heartbeat must read the percentile and THEN reset the histogram — otherwise a
  // delay recorded during one interval keeps showing up in every later heartbeat's p99, long after
  // the event loop that caused it recovered. A deterministic histogram double injected through
  // `createHistogram` pins this without depending on real event-loop timing (#2902 PR review).
  it("scopes eventLoopDelayP99Ms to the interval since the previous heartbeat", () => {
    vi.useFakeTimers();
    try {
      let cumulativeNs = 0;
      let resetCount = 0;
      const histogram = {
        enable: vi.fn(),
        disable: vi.fn(),
        percentile: (): number => cumulativeNs,
        reset: (): void => {
          resetCount += 1;
          cumulativeNs = 0;
        },
      };
      const sink = createRecordingSink();
      const stop = startProcessHeartbeat(sink, 1_000, () => histogram);

      // A delay accumulates during the first interval only.
      cumulativeNs = 5_000_000; // 5ms, in the nanoseconds `percentile()` reports
      vi.advanceTimersByTime(1_000);
      const heartbeats = (): readonly ServerLogEvent[] =>
        sink.events.filter((event) => event.op === "process.heartbeat");
      expect(heartbeats()).toHaveLength(1);
      expect(extraOf(heartbeats()[0]).eventLoopDelayP99Ms).toBe(5);
      expect(resetCount).toBe(1);

      // No further delay is simulated before the second tick — a fix that resets the histogram
      // after reading it reports 0 here; a fix that never resets would still report 5, carrying
      // the first interval's delay into the second.
      vi.advanceTimersByTime(1_000);
      expect(heartbeats()).toHaveLength(2);
      expect(extraOf(heartbeats()[1]).eventLoopDelayP99Ms).toBe(0);
      expect(resetCount).toBe(2);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
