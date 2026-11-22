// #4504: a second start must not restart a healthy Keiko that answers its health probe late. A
// tracked UI whose process is alive and whose launch identity is verified is busy, not stale, while
// its health does not answer; the start asks again a bounded number of times and never stops it for
// being slow. A different version and an older launch without a verifiable identity still restart.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { runLifecycleCli, type LifecycleCliDeps } from "./lifecycle.js";
import { KEIKO_UI_LAUNCH_ID_ENV, writeExclusivePidFile } from "./state-paths.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

type Answer = "down" | "current" | "old";

const roots: string[] = [];
const TRACKED_PID = 44556;
const LAUNCH_ID = "a".repeat(32);

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  answers: readonly Answer[],
  {
    launchBound = true,
    verify = (): boolean => true,
    commandLine = (): string | undefined => undefined,
  }: {
    readonly launchBound?: boolean;
    readonly verify?: () => boolean;
    readonly commandLine?: () => string | undefined;
  } = {},
): {
  deps: LifecycleCliDeps;
  events: SecurityLogEvent[];
  probes: () => number;
  killed: ReturnType<typeof vi.fn>;
  spawned: ReturnType<typeof vi.fn>;
  out: string[];
  err: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-busy-start-"));
  roots.push(root);
  mkdirSync(join(root, ".keiko"), { mode: 0o700 });
  writeExclusivePidFile(
    join(root, ".keiko", "ui.pid"),
    TRACKED_PID,
    launchBound ? LAUNCH_ID : undefined,
  );
  const events: SecurityLogEvent[] = [];
  let alive = true;
  let launchId = LAUNCH_ID;
  let probe = 0;
  const killed = vi.fn(() => {
    alive = false;
  });
  const spawned = vi.fn<NonNullable<LifecycleCliDeps["spawnFn"]>>((_command, _args, options) => {
    const selected = options.env?.[KEIKO_UI_LAUNCH_ID_ENV];
    if (typeof selected !== "string") throw new TypeError("Missing produced launch identity");
    launchId = selected;
    alive = true;
    return Object.assign(new EventEmitter(), {
      pid: 77889,
      unref: vi.fn(),
    }) as unknown as ChildProcess;
  });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const deps: LifecycleCliDeps = {
    cwd: root,
    spawnFn: spawned,
    killProcess: killed,
    isPortAvailable: () => Promise.resolve(true),
    isProcessAlive: () => alive,
    verifyLaunchIdentity: verify,
    readCommandLine: commandLine,
    platform: () => "linux",
    securityLogSink: {
      write: (event): void => {
        events.push(event);
      },
    },
    sleep: (ms): Promise<void> => {
      now += ms;
      return Promise.resolve();
    },
    fetchImpl: () => {
      const answer = answers[Math.min(probe, answers.length - 1)];
      probe += 1;
      if (answer === "down") return Promise.reject(new Error("health probe timed out"));
      return Promise.resolve(
        Response.json({
          status: "ok",
          version: answer === "old" ? "0.1.2" : KEIKO_PRODUCT_VERSION,
          launchId,
        }),
      );
    },
  };
  return { deps, events, probes: () => probe, killed, spawned, out: [], err: [] };
}

async function start(setup: ReturnType<typeof fixture>): Promise<number> {
  return runLifecycleCli(
    "start",
    ["--start-timeout", "5", "--stop-timeout", "1"],
    {
      out: (text: string) => setup.out.push(text),
      err: (text: string) => setup.err.push(text),
    },
    {},
    setup.deps,
  );
}

function trackedDecision(events: readonly SecurityLogEvent[]): Record<string, unknown> {
  const tracked = events.filter(
    (event) => event.op === "cli.lifecycle.health" && event.extra?.phase === "tracked",
  );
  expect(tracked).toHaveLength(1);
  const event = tracked[0];
  if (event === undefined) throw new Error("Missing the tracked health decision");
  return expectActivityLogProof("cli.lifecycle.health.decision", formatActivityLogProofLine(event));
}

describe("a second start while Keiko runs (#4504)", () => {
  it("keeps a verified, live UI whose health answers only after three probes went unanswered", async () => {
    const setup = fixture(["down", "down", "down", "current"]);
    expect(await start(setup)).toBe(0);
    expect(setup.out.join("")).toContain("already running");
    expect(setup.out.join("")).not.toContain("stale");
    expect(setup.killed).not.toHaveBeenCalled();
    expect(setup.spawned).not.toHaveBeenCalled();
    expect(setup.probes()).toBe(4);
    expect(trackedDecision(setup.events)).toMatchObject({
      phase: "tracked",
      outcome: "healthy",
      healthRetries: 3,
      launchBound: true,
    });
  });

  it("gives up after a bounded number of probes, says so plainly and leaves the UI running", async () => {
    const setup = fixture(["down"]);
    expect(await start(setup)).toBe(1);
    expect(setup.probes()).toBe(11);
    expect(setup.err.join("")).toContain(
      "did not answer its health check in time; it was left running",
    );
    expect(setup.out.join("")).not.toContain("already running");
    expect(setup.killed).not.toHaveBeenCalled();
    expect(setup.spawned).not.toHaveBeenCalled();
    expect(trackedDecision(setup.events)).toMatchObject({
      outcome: "busy",
      healthRetries: 10,
    });
  });

  it("never stops a busy, verified UI when one identity read fails, wherever that read falls", async () => {
    // Every position of one transient failed read, past the last read a start makes. A failed read
    // may end the wait early or retain ownership, but it must never reach the stop path.
    for (let failing = 1; failing <= 14; failing += 1) {
      let reads = 0;
      const setup = fixture(["down"], {
        verify: (): boolean => {
          reads += 1;
          return reads !== failing;
        },
      });
      expect(await start(setup)).toBe(1);
      expect(setup.killed, `failed read ${String(failing)}`).not.toHaveBeenCalled();
      expect(setup.spawned, `failed read ${String(failing)}`).not.toHaveBeenCalled();
      expect(setup.out.join(""), `failed read ${String(failing)}`).not.toContain("stale");
      expect(["busy", "identity-mismatch"]).toContain(trackedDecision(setup.events).outcome);
      vi.restoreAllMocks();
    }
  });

  it("still restarts a UI that answers with another version, and records why", async () => {
    const setup = fixture(["old", "current"]);
    expect(await start(setup)).toBe(0);
    expect(setup.out.join("")).toContain("is stale (running version 0.1.2 differs");
    expect(setup.killed).toHaveBeenCalledWith(TRACKED_PID, "SIGTERM");
    expect(setup.spawned).toHaveBeenCalledTimes(1);
    expect(trackedDecision(setup.events)).toMatchObject({
      outcome: "stale-version",
      healthRetries: 0,
    });
  });

  it("still restarts an older launch without a launch identity whose health does not answer", async () => {
    const setup = fixture(["down", "current"], { launchBound: false });
    await start(setup);
    // The decision is the restart; whether this fixture's stop then succeeds is the stop path's own
    // concern, covered in lifecycle.test.ts.
    expect(setup.out.join("")).toContain("is stale (health check is unreachable); restarting");
    expect(setup.probes()).toBeGreaterThanOrEqual(1);
    expect(trackedDecision(setup.events)).toMatchObject({
      outcome: "stale-unreachable",
      healthRetries: 0,
      launchBound: false,
    });
  });
});

// A Keiko that ended without its stop leaves its record, and the system may hand its process id to
// any later program (seen on Windows after a restart: the first start refused with "ownership is
// retained" until that program happened to exit).
describe("a record whose process id now names another program", () => {
  it("drops the record and starts Keiko when the other program's command line is readable", async () => {
    const setup = fixture(["down", "current"], {
      verify: (): boolean => false,
      commandLine: (): string => "C:\\Windows\\System32\\svchost.exe -k netsvcs -p",
    });
    expect(await start(setup)).toBe(0);
    expect(setup.out.join("")).toContain(
      `Keiko UI record is stale (pid ${String(TRACKED_PID)} now belongs to another program)`,
    );
    expect(setup.killed).not.toHaveBeenCalled();
    expect(setup.spawned).toHaveBeenCalledTimes(1);
    expect(trackedDecision(setup.events)).toMatchObject({
      phase: "tracked",
      outcome: "stale-foreign",
      launchBound: true,
    });
  });

  it("keeps the refusal while the process's command line cannot be read", async () => {
    const setup = fixture(["down"], { verify: (): boolean => false });
    expect(await start(setup)).toBe(1);
    expect(setup.err.join("")).toContain("ownership is retained");
    expect(setup.killed).not.toHaveBeenCalled();
    expect(setup.spawned).not.toHaveBeenCalled();
    expect(trackedDecision(setup.events)).toMatchObject({ outcome: "identity-mismatch" });
  });

  it("never reads its own launch identity on the command line as another program", async () => {
    const setup = fixture(["current"], {
      commandLine: (): string =>
        `node keiko ui --port 1983 --host 127.0.0.1 --launch-id ${LAUNCH_ID}`,
    });
    expect(await start(setup)).toBe(0);
    expect(setup.out.join("")).toContain("already running");
    expect(setup.spawned).not.toHaveBeenCalled();
    expect(trackedDecision(setup.events)).toMatchObject({ outcome: "healthy" });
  });

  it("keeps an older record without a launch identity on the existing restart path", async () => {
    const setup = fixture(["down", "current"], {
      launchBound: false,
      commandLine: (): string => "C:\\Windows\\explorer.exe",
    });
    await start(setup);
    expect(setup.out.join("")).not.toContain("belongs to another program");
    expect(trackedDecision(setup.events)).toMatchObject({ outcome: "stale-unreachable" });
  });
});
