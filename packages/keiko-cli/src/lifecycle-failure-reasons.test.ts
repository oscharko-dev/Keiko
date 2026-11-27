import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { runLifecycleCli } from "./lifecycle.js";
import type { LaunchFailureReason } from "./launch-failure-note.js";

// #4358: every way `keiko start` can end non-zero records one closed reason for the caller (the
// portable launch turns it into the launcher's failure note and one activity-log line). Each row of
// the exit-path table is one test: the exit code, the reason recorded, the person-readable text on
// the command's stream and, where the path has its own event, that line.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-failure-reasons-"));
  roots.push(root);
  return root;
}

function makeIo(): {
  readonly io: { out: (text: string) => void; err: (text: string) => void };
  readonly out: () => string;
  readonly err: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (text): void => void out.push(text),
      err: (text): void => void err.push(text),
    },
    out: (): string => out.join(""),
    err: (): string => err.join(""),
  };
}

interface Outcome {
  readonly code: number;
  readonly reasons: LaunchFailureReason[];
  readonly err: string;
  readonly events: SecurityLogEvent[];
}

async function start(
  root: string,
  args: readonly string[],
  deps: Partial<Parameters<typeof runLifecycleCli>[4]>,
  env: Record<string, string> = {},
): Promise<Outcome> {
  const c = makeIo();
  const reasons: LaunchFailureReason[] = [];
  const events: SecurityLogEvent[] = [];
  const code = await runLifecycleCli("start", args, c.io, env, {
    cwd: root,
    isPortAvailable: () => Promise.resolve(true),
    sleep: () => Promise.resolve(),
    platform: () => "linux",
    openExternal: vi.fn(),
    securityLogSink: { write: (event): void => void events.push(event) },
    recordFailure: (reason): void => void reasons.push(reason),
    ...deps,
  });
  return { code, reasons, err: c.err(), events };
}

describe("the launcher's failure note stays with the launch", () => {
  it("is not handed to the long-running UI process", async () => {
    let childEnv: NodeJS.ProcessEnv | undefined;

    await start(
      makeRoot(),
      [],
      {
        spawnFn: (_command, _args, options) => {
          childEnv = options.env;
          throw new Error("stop after the environment was captured");
        },
      },
      {
        KEIKO_PORTABLE_UI_LAUNCH: "1",
        KEIKO_PORTABLE_FAILURE_NOTE: "/tmp/keiko-launch-note-4711.txt",
      },
    );

    expect(childEnv).toBeDefined();
    expect(childEnv?.KEIKO_PORTABLE_FAILURE_NOTE).toBeUndefined();
    // the double-click marker keeps its existing reach
    expect(childEnv?.KEIKO_PORTABLE_UI_LAUNCH).toBe("1");
  });
});

describe("every non-zero exit of a start records its closed reason", () => {
  it("port-in-use: the port is taken", async () => {
    const result = await start(makeRoot(), [], {
      isPortAvailable: () => Promise.resolve(false),
      spawnFn: () => {
        throw new Error("must not spawn");
      },
    });

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["port-in-use"]);
    expect(result.err).toContain("is already in use");
  });

  it("stale-shutdown-request: a stale shutdown request cannot be cleared", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko", "ui.shutdown"), { recursive: true });

    const result = await start(root, [], {});

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["stale-shutdown-request"]);
    expect(result.err).toContain("failed to clear a stale shutdown request");
  });

  it("state-dir-in-start-folder: the state directory lies inside the start folder", async () => {
    const root = makeRoot();
    const result = await start(
      root,
      [],
      {
        homedir: () => root,
        spawnFn: () => {
          throw new Error("must not spawn");
        },
      },
      { KEIKO_STATE_DIR: join(root, "data") },
    );

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["state-dir-in-start-folder"]);
    expect(result.err).toContain("inside the folder Keiko starts from");
  });

  it("state-dir-in-start-folder: a KEIKO_UI_DATA_DIR inside the start folder", async () => {
    const root = makeRoot();
    const result = await start(
      root,
      [],
      {
        homedir: () => root,
        spawnFn: () => {
          throw new Error("must not spawn");
        },
      },
      { KEIKO_UI_DATA_DIR: join(root, "ui") },
    );

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["state-dir-in-start-folder"]);
    expect(result.err).toContain("KEIKO_UI_DATA_DIR lies inside the folder Keiko starts from");
  });

  it("state-dir: a relative KEIKO_UI_DATA_DIR the UI process would refuse", async () => {
    const root = makeRoot();
    const result = await start(
      root,
      [],
      {
        homedir: () => root,
        spawnFn: () => {
          throw new Error("must not spawn");
        },
      },
      { KEIKO_UI_DATA_DIR: "ui" },
    );

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["state-dir"]);
    expect(result.err).toContain("KEIKO_UI_DATA_DIR must be an absolute path without NUL bytes");
  });

  it("state-dir-in-start-folder: a restart records the refusal before stopping anything", async () => {
    const root = makeRoot();
    const reasons: LaunchFailureReason[] = [];
    const c = makeIo();
    const code = await runLifecycleCli(
      "restart",
      [],
      c.io,
      { KEIKO_STATE_DIR: join(root, "data") },
      {
        cwd: root,
        homedir: () => root,
        platform: () => "linux",
        recordFailure: (reason): void => void reasons.push(reason),
      },
    );

    expect(code).toBe(1);
    expect(reasons).toEqual(["state-dir-in-start-folder"]);
  });

  it("invalid-launch-id: the recovered launch identity is malformed", async () => {
    const encoded = Buffer.from(JSON.stringify({ launchId: "not-a-launch-id" }), "utf8").toString(
      "base64url",
    );

    const result = await start(makeRoot(), [], {}, { KEIKO_PORTABLE_RECOVERED_LAUNCH: encoded });

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["invalid-launch-id"]);
    expect(result.err).toContain("recovered portable launch identity is invalid");
  });

  it("spawn-refused: the UI process cannot be spawned", async () => {
    const result = await start(makeRoot(), [], {
      spawnFn: () => {
        throw new Error("spawn EACCES");
      },
    });

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["spawn-refused"]);
    expect(result.err).toContain("failed to spawn the UI process");
    // its own line, body-free: the outcome is closed and the path-bearing text is absent
    expect(result.events.map((event) => event.op)).toContain("cli.lifecycle.health");
    expect(JSON.stringify(result.events)).not.toContain("EACCES");
  });

  it("missing-child-pid: the spawned child has no pid", async () => {
    const child = { pid: undefined, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const result = await start(makeRoot(), [], { spawnFn: () => child });

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["missing-child-pid"]);
    expect(result.err).toContain("failed to spawn the UI process");
  });

  it("pid-publication: the pid cannot be published, and the child is killed", async () => {
    const root = makeRoot();
    const killProcess = vi.fn();
    const child = { pid: 24680, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const result = await start(root, [], {
      // something that is not a pid file takes the pid file's place between the spawn and the
      // publish: the exclusive create cannot succeed
      spawnFn: () => {
        mkdirSync(join(root, ".keiko", "ui.pid"), { recursive: true });
        return child;
      },
      killProcess,
    });

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["pid-publication"]);
    expect(result.err).toContain("failed to publish the UI process pid");
    expect(killProcess).toHaveBeenCalledWith(24680, "SIGKILL");
  });

  it("process-exited: the UI process ended before it was healthy", async () => {
    const child = { pid: 24680, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;

    const result = await start(makeRoot(), ["--start-timeout", "1"], {
      spawnFn: () => child,
      fetchImpl: () => Promise.reject(new Error("connection refused")),
      isProcessAlive: () => false,
      killProcess: vi.fn(),
    });

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["process-exited"]);
    // a plain sentence first, with what to do, then the technical outcome
    expect(result.err).toContain("Keiko stopped while it was starting.");
    expect(result.err).toContain("Wait a moment and open Keiko again");
    expect(result.err).toContain("UI did not become healthy (process-exited)");
  });

  it("health-timeout: the UI process never answered in time", async () => {
    const child = { pid: 24680, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    let alive = true;

    const result = await start(makeRoot(), ["--start-timeout", "1", "--stop-timeout", "1"], {
      spawnFn: () => child,
      fetchImpl: () => Promise.reject(new Error("connection refused")),
      isProcessAlive: () => alive,
      killProcess: (): void => {
        alive = false;
      },
    });

    expect(result.code).toBe(1);
    expect(result.reasons).toEqual(["health-timeout"]);
    // the sentence a clerk can act on (#4358): still starting or too slow, and what to do; the
    // technical outcome stays behind it
    expect(result.err).toContain("Keiko is still starting or took too long to start.");
    expect(result.err).toContain("Wait a moment and open Keiko again");
    expect(result.err).toContain("keiko support export");
    expect(result.err).toContain("UI did not become healthy (health-timeout)");
    expect(result.events.map((event) => event.op)).toContain("cli.lifecycle.health");
  });
});
