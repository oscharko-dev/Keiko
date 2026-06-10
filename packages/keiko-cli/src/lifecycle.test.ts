import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { runLifecycleCli } from "./lifecycle.js";
import type { CliIo } from "./runner.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runLifecycleCli", () => {
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

  it("starts the packaged UI through the compiled CLI entry and records runtime state", async () => {
    const root = makeRoot();
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn() } as unknown as ChildProcess;

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
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
        isProcessAlive: () => true,
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining(["ui", "--port", "4321", "--host", "127.0.0.1"]),
    );
    expect(spawned[0]?.opts.env).toMatchObject({
      KEIKO_STATE_DIR: join(root, ".keiko-test"),
    });
    expect(readFileSync(join(root, ".keiko-test", "ui.pid"), "utf8")).toBe("12345\n");
    expect(existsSync(join(root, ".keiko-test", "ui.log"))).toBe(true);
    expect(c.out()).toContain("Keiko UI running");
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

  it("restarts an already-running UI when the health version is stale", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n", "utf8");
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 67890, unref: vi.fn() } as unknown as ChildProcess;
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
        fetchImpl: () =>
          Promise.resolve(Response.json({ status: "ok", version: "0.1.2" }, { status: 200 })),
        isProcessAlive: (pid) => (pid === 12345 ? oldProcessAlive : true),
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

  it("returns a usage error for invalid ports", async () => {
    const root = makeRoot();
    const c = makeIo();

    const code = await runLifecycleCli("start", ["--port", "99999"], c.io, {}, { cwd: root });

    expect(code).toBe(2);
    expect(c.err().toLowerCase()).toContain("usage");
  });
});
