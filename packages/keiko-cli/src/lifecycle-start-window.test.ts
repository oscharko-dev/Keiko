// #4358: `keiko start` gave the UI process 20 seconds and ended it otherwise. On Windows the first
// start after an installation needs minutes of code loading under the virus scanner, so a healthy,
// busy process was ended every time. The window now bounds SILENCE: it restarts with every sign of
// life the UI process records, and a process that goes quiet is still ended one window later.
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import { runLifecycleCli, type LifecycleCliDeps } from "./lifecycle.js";
import type { CliIo } from "./runner.js";
import { readPidRecord } from "./state-paths.js";
import type { UiStartupSign } from "./ui-startup-progress.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const PID = 24_690;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-start-window-")));
  roots.push(root);
  return root;
}

interface Start {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** Seconds on the launcher's clock when the command returned. */
  readonly endedAtSeconds: number;
  readonly killed: boolean;
  readonly events: SecurityLogEvent[];
}

interface Scenario {
  /** The UI process's sign of life at `seconds` on the launcher's clock. */
  readonly sign: (seconds: number) => UiStartupSign | undefined;
  /** The second from which the health check answers; never when omitted. */
  readonly healthyFromSeconds?: number;
  readonly startTimeoutSeconds?: number;
}

/**
 * Runs `keiko start` on a simulated clock that only the launcher's own sleeps advance. The UI
 * process is alive until it is signalled, and its health check answers from a given second.
 */
async function start(scenario: Scenario): Promise<Start> {
  const root = makeRoot();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let out = "";
  let err = "";
  const io: CliIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };
  let killed = false;
  const events: SecurityLogEvent[] = [];
  const child = { pid: PID, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
  const healthy = (): boolean =>
    scenario.healthyFromSeconds !== undefined && now >= scenario.healthyFromSeconds * 1_000;
  const deps: LifecycleCliDeps = {
    cwd: root,
    spawnFn: () => child,
    fetchImpl: () =>
      healthy()
        ? Promise.resolve(
            Response.json({
              status: "ok",
              version: KEIKO_PRODUCT_VERSION,
              launchId: readPidRecord(join(root, ".keiko", "ui.pid"))?.launchId,
            }),
          )
        : Promise.reject(new Error("connection refused")),
    isProcessAlive: () => !killed,
    killProcess: () => {
      killed = true;
    },
    isPortAvailable: () => Promise.resolve(true),
    openExternal: vi.fn(() => Promise.resolve()),
    // POSIX semantics on every host: on Windows the stop path would run a real taskkill.
    platform: () => "linux",
    verifyLaunchIdentity: () => true,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    readStartupSign: () => scenario.sign(now / 1_000),
    securityLogSink: { write: (event): void => void events.push(event) },
  };
  const code = await runLifecycleCli(
    "start",
    [
      "--port",
      "4391",
      "--no-open",
      "--start-timeout",
      String(scenario.startTimeoutSeconds ?? 20),
      "--stop-timeout",
      "1",
    ],
    io,
    {},
    deps,
  );
  return { code, out, err, endedAtSeconds: now / 1_000, killed, events };
}

/** A UI process that records work every second until `untilSeconds`, then nothing more. */
function workingUntil(untilSeconds: number): Scenario["sign"] {
  return (seconds) => ({
    token: String(Math.floor(Math.min(seconds, untilSeconds))),
    horizonMs: 0,
  });
}

function healthEvent(events: readonly SecurityLogEvent[]): SecurityLogEvent | undefined {
  return events.find((event) => event.op === "cli.lifecycle.health");
}

describe("keiko start waits on a UI process that shows life", () => {
  it("reports a UI healthy that needed 208 s to load, far past the 20 s window", async () => {
    const result = await start({ sign: workingUntil(Infinity), healthyFromSeconds: 208 });
    expect(result.code).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.out).toContain("Keiko UI running on http://127.0.0.1:4391");
    expect(result.err).toBe("");
    expect(result.endedAtSeconds).toBeGreaterThanOrEqual(208);
    expect(result.endedAtSeconds).toBeLessThan(211);
    // Said once, not on every extension.
    expect(result.out.split("Keiko is still starting.")).toHaveLength(2);
    const health = healthEvent(result.events);
    expect(health).toMatchObject({ level: "info", extra: { outcome: "healthy" } });
    const persisted = expectActivityLogProof(
      "cli.lifecycle.health.decision",
      formatActivityLogProofLine(health ?? {}),
    );
    expect(persisted.lifeSigns).toBeGreaterThan(150);
  });

  it("ends a UI process one window after its last sign of life", async () => {
    const result = await start({ sign: workingUntil(60) });
    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.err).toContain("UI did not become healthy (health-timeout)");
    // Last record at 60 s, window 20 s; the teardown adds at most the 1 s stop window.
    expect(result.endedAtSeconds).toBeGreaterThanOrEqual(80);
    expect(result.endedAtSeconds).toBeLessThan(83);
    expect(healthEvent(result.events)).toMatchObject({
      level: "warn",
      errorKind: "timeout",
      extra: { outcome: "health-timeout" },
    });
  });

  it("keeps the unchanged 20 s window for a UI process that never shows life", async () => {
    const result = await start({ sign: () => undefined });
    expect(result.code).toBe(1);
    expect(result.endedAtSeconds).toBeGreaterThanOrEqual(20);
    expect(result.endedAtSeconds).toBeLessThan(23);
    expect(result.out).not.toContain("still starting");
    expect(healthEvent(result.events)?.extra).toMatchObject({ lifeSigns: 0 });
  });

  it("waits out the bound a blocking step announced, then ends a process that stays silent", async () => {
    const announced: UiStartupSign = { token: "1", horizonMs: 70_000 };
    const result = await start({ sign: () => announced });
    expect(result.code).toBe(1);
    expect(result.endedAtSeconds).toBeGreaterThanOrEqual(70);
    expect(result.endedAtSeconds).toBeLessThan(73);
  });

  it("answers a UI that turns healthy inside an announced blocking step", async () => {
    const announced: UiStartupSign = { token: "1", horizonMs: 70_000 };
    const result = await start({ sign: () => announced, healthyFromSeconds: 45 });
    expect(result.code).toBe(0);
    expect(result.killed).toBe(false);
  });

  it("never lets a record shorten the window", async () => {
    // A record that announces nothing arrives late in the window: the start still gets 20 s from it.
    const result = await start({
      sign: (seconds) => (seconds >= 19 ? { token: "late", horizonMs: 0 } : undefined),
      healthyFromSeconds: 35,
    });
    expect(result.code).toBe(0);
  });

  it("ends a UI process that shows life for fifteen minutes without ever becoming healthy", async () => {
    const result = await start({ sign: workingUntil(Infinity) });
    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.endedAtSeconds).toBeGreaterThanOrEqual(900);
    expect(result.endedAtSeconds).toBeLessThan(903);
  });

  it("lets an explicit longer --start-timeout raise that ceiling", async () => {
    const result = await start({
      sign: workingUntil(Infinity),
      healthyFromSeconds: 1_000,
      startTimeoutSeconds: 1_200,
    });
    expect(result.code).toBe(0);
  });
});

describe("keiko start from a directory it cannot write to", () => {
  // Mode bits do not make a directory read-only on Windows, and root ignores them.
  const unwritableDirectoryAvailable = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!unwritableDirectoryAvailable)(
    "names the state directory and the remedy instead of a failed spawn",
    async () => {
      const root = makeRoot();
      // The working directory cannot be written to, like `C:\Windows\System32` for a person
      // without administrator rights: `.keiko` cannot be created in it.
      chmodSync(root, 0o555);
      let err = "";
      const spawnFn = vi.fn();
      const events: SecurityLogEvent[] = [];
      try {
        const code = await runLifecycleCli(
          "start",
          ["--port", "4392", "--no-open"],
          {
            out: () => undefined,
            err: (text) => {
              err += text;
            },
          },
          {},
          {
            cwd: root,
            spawnFn,
            isPortAvailable: () => Promise.resolve(true),
            isProcessAlive: () => false,
            platform: () => "linux",
            securityLogSink: { write: (event): void => void events.push(event) },
          },
        );
        expect(code).toBe(1);
      } finally {
        chmodSync(root, 0o755);
      }
      expect(spawnFn).not.toHaveBeenCalled();
      expect(err).toContain(
        "cannot create the Keiko state directory in the current working directory (EACCES)",
      );
      expect(err).toContain("pass --state-dir");
      expect(err).not.toContain("failed to spawn the UI process");
      // The cause is a class, never the path-bearing error text.
      expect(err).not.toContain(root);
      expect(healthEvent(events)).toMatchObject({
        level: "warn",
        errorKind: "permission-denied",
        extra: { outcome: "state-dir-unavailable" },
      });
    },
  );
});
