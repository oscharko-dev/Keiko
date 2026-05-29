import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUiArgs, runUiCli, waitForShutdown, type UiCliDeps } from "../../src/cli/ui.js";
import { DEFAULT_UI_PORT } from "../../src/ui/index.js";
import type { CliIo } from "../../src/cli/runner.js";

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    out,
    err,
  };
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
  it("defaults the port to 4319", () => {
    expect(parseUiArgs([])).toEqual({
      port: DEFAULT_UI_PORT,
      evidenceDir: undefined,
      config: undefined,
    });
  });

  it("parses a valid --port", () => {
    expect(parseUiArgs(["--port", "5000"])?.port).toBe(5000);
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
    const parsed = parseUiArgs(["--evidence-dir", "/e", "--config", "/c.json"]);
    expect(parsed?.evidenceDir).toBe("/e");
    expect(parsed?.config).toBe("/c.json");
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
