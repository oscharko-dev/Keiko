import {
  existsSync,
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
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { STOP_SUPERSEDED_EXIT_CODE } from "./launch-order.js";
import { runLifecycleCli } from "./lifecycle.js";

// The folder launcher orders its starts and Stops through the lifecycle owner (ADR-0121 D9, owner
// review on PR #4464): `keiko start --launch-order` records when the start began to take its
// folder's lock, and `keiko stop --unless-launched-after` decides under the same lifecycle guard
// whether a start came after the Stop. No start can open Keiko between that check and the stop.

const TEST_LAUNCH_ID = "cd".repeat(16);
const PID = 23456;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type KillProcess = (pid: number, signal?: NodeJS.Signals | 0) => void;

interface Instance {
  readonly root: string;
  readonly events: SecurityLogEvent[];
  readonly killProcess: Mock<KillProcess>;
  alive: boolean;
}

// A folder whose state directory tracks one running Keiko of the current version.
function runningInstance(): Instance {
  const root = mkdtempSync(join(tmpdir(), "keiko-lifecycle-launch-order-"));
  roots.push(root);
  mkdirSync(join(root, ".keiko"), { recursive: true });
  writeFileSync(join(root, ".keiko", "ui.pid"), `${String(PID)}\n${TEST_LAUNCH_ID}\n`, "utf8");
  const instance: Instance = {
    root,
    events: [],
    alive: true,
    killProcess: vi.fn<KillProcess>((_pid, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") instance.alive = false;
    }),
  };
  return instance;
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function lifecycle(
  instance: Instance,
  command: "start" | "stop",
  args: readonly string[],
): Promise<Run> {
  let out = "";
  let err = "";
  const code = await runLifecycleCli(
    command,
    command === "start" ? ["--no-open", ...args] : args,
    {
      out: (text): void => {
        out += text;
      },
      err: (text): void => {
        err += text;
      },
    },
    {},
    {
      cwd: instance.root,
      platform: () => "linux",
      sleep: () => Promise.resolve(),
      isPortAvailable: () => Promise.resolve(true),
      openExternal: vi.fn(),
      fetchImpl: () =>
        Promise.resolve(
          Response.json({ status: "ok", version: SDK_VERSION, launchId: TEST_LAUNCH_ID }),
        ),
      isProcessAlive: () => instance.alive,
      killProcess: instance.killProcess,
      verifyLaunchIdentity: () => true,
      spawnFn: () => {
        throw new Error("a running Keiko is reused, never spawned again");
      },
      securityLogSink: { write: (event): void => void instance.events.push(event) },
    },
  );
  return { code, out, err };
}

function outcomes(instance: Instance): string[] {
  return instance.events
    .filter((event) => event.op === "cli.lifecycle.launch-order")
    .map((event) => `${String(event.extra?.command)}:${String(event.extra?.outcome)}`);
}

function recordPath(instance: Instance): string {
  return join(instance.root, ".keiko", "ui.launch-order");
}

describe("the folder launcher's start order at the lifecycle owner", () => {
  it("leaves Keiko open when a start that began after the Stop opened it", async () => {
    const instance = runningInstance();

    expect((await lifecycle(instance, "start", ["--launch-order", "300"])).code).toBe(0);
    const stopped = await lifecycle(instance, "stop", ["--unless-launched-after", "200"]);

    expect(stopped.code).toBe(STOP_SUPERSEDED_EXIT_CODE);
    expect(stopped.out).toContain("started again after this stop was requested");
    expect(instance.killProcess).not.toHaveBeenCalled();
    expect(instance.alive).toBe(true);
    expect(outcomes(instance)).toEqual(["start:recorded", "stop:superseded"]);
  });

  it("stops the Keiko of a start that began before the Stop and clears the order", async () => {
    const instance = runningInstance();

    await lifecycle(instance, "start", ["--launch-order", "100"]);
    const stopped = await lifecycle(instance, "stop", ["--unless-launched-after", "200"]);

    expect(stopped.code).toBe(0);
    expect(instance.alive).toBe(false);
    expect(existsSync(recordPath(instance))).toBe(false);
    expect(outcomes(instance)).toEqual(["start:recorded", "stop:proceeded"]);
  });

  it("keeps the later order when an earlier, slower start finishes last", async () => {
    // Two package folders share one data folder: the start that began first can finish last.
    const instance = runningInstance();

    await lifecycle(instance, "start", ["--launch-order", "300"]);
    await lifecycle(instance, "start", ["--launch-order", "100"]);
    const stopped = await lifecycle(instance, "stop", ["--unless-launched-after", "200"]);

    expect(readFileSync(recordPath(instance), "utf8")).toBe("300\n");
    expect(stopped.code).toBe(STOP_SUPERSEDED_EXIT_CODE);
    expect(outcomes(instance)).toEqual(["start:recorded", "start:kept", "stop:superseded"]);
  });

  it("treats a start that began exactly at the fence as one before the Stop", async () => {
    const instance = runningInstance();

    await lifecycle(instance, "start", ["--launch-order", "200"]);

    expect((await lifecycle(instance, "stop", ["--unless-launched-after", "200"])).code).toBe(0);
    expect(instance.alive).toBe(false);
  });

  it("stops nothing when the order of the last start cannot be read", async () => {
    const instance = runningInstance();
    writeFileSync(recordPath(instance), "not an order\n");

    const stopped = await lifecycle(instance, "stop", ["--unless-launched-after", "200"]);

    expect(stopped.code).toBe(1);
    expect(stopped.err).toContain("cannot be read");
    expect(instance.killProcess).not.toHaveBeenCalled();
    const line = instance.events.find((event) => event.op === "cli.lifecycle.launch-order");
    expect(line).toMatchObject({ level: "warn", errorKind: "unavailable" });
    expect(line?.extra).toMatchObject({ command: "stop", outcome: "unreadable" });
  });

  // A file symbolic link needs a privilege on Windows that a test account may lack.
  it.skipIf(process.platform === "win32")(
    "never replaces a record it cannot read, because it may hold a later order",
    async () => {
      // Independent audit on PR #4464: any read failure was taken for a malformed record and replaced
      // with the start's own, earlier order, so a stale Stop then stopped the newer start's Keiko.
      const instance = runningInstance();
      const later = join(instance.root, "later-order");
      writeFileSync(later, "900\n");
      symlinkSync(later, recordPath(instance));

      const started = await lifecycle(instance, "start", ["--launch-order", "300"]);

      expect(started.code).toBe(0);
      expect(started.err).toContain("could not be recorded");
      expect(lstatSync(recordPath(instance)).isSymbolicLink()).toBe(true);
      expect(readFileSync(later, "utf8")).toBe("900\n");
      const failed = instance.events.find((event) => event.op === "cli.lifecycle.launch-order");
      expect(failed).toMatchObject({ level: "warn", errorKind: "unavailable" });
      expect(failed?.extra).toMatchObject({ command: "start", outcome: "record-failed" });
      expect(typeof failed?.extra?.failureKind).toBe("string");
      expect(outcomes(instance)).toEqual(["start:record-failed"]);
    },
  );

  it("reports a malformed order at a start and replaces it with the start's own", async () => {
    const instance = runningInstance();
    writeFileSync(recordPath(instance), "not an order\n");

    expect((await lifecycle(instance, "start", ["--launch-order", "300"])).code).toBe(0);

    expect(readFileSync(recordPath(instance), "utf8")).toBe("300\n");
    const unreadable = instance.events.find(
      (event) => event.op === "cli.lifecycle.launch-order" && event.extra?.outcome === "unreadable",
    );
    expect(unreadable).toMatchObject({ level: "warn", errorKind: "unavailable" });
    expect(unreadable?.extra).toMatchObject({ command: "start" });
    expect(typeof unreadable?.extra?.failureKind).toBe("string");
    expect(outcomes(instance)).toEqual(["start:unreadable", "start:recorded"]);
  });

  it("lets a stop without a fence stop Keiko as before and clear the order", async () => {
    const instance = runningInstance();

    await lifecycle(instance, "start", ["--launch-order", "300"]);
    const stopped = await lifecycle(instance, "stop", []);

    expect(stopped.code).toBe(0);
    expect(instance.alive).toBe(false);
    expect(existsSync(recordPath(instance))).toBe(false);
  });

  it("clears the order when a fenced stop finds no Keiko running", async () => {
    const instance = runningInstance();
    await lifecycle(instance, "start", ["--launch-order", "300"]);
    instance.alive = false;

    const stopped = await lifecycle(instance, "stop", ["--unless-launched-after", "200"]);

    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain("not running");
    expect(existsSync(recordPath(instance))).toBe(false);
  });

  it("reports an order it cannot clear after a stop and still reports the stop", async () => {
    // Independent audit on PR #4464: removing the record threw after Keiko had stopped, so the
    // stop ended with "ownership remains uncertain" and exit code 1.
    const instance = runningInstance();
    instance.alive = false;
    mkdirSync(join(recordPath(instance), "held"), { recursive: true });

    const stopped = await lifecycle(instance, "stop", ["--unless-launched-after", "200"]);

    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain("not running");
    const failed = instance.events.find((event) => event.op === "cli.lifecycle.launch-order");
    expect(failed).toMatchObject({ level: "warn", errorKind: "unavailable" });
    expect(failed?.extra).toMatchObject({ command: "stop", outcome: "clear-failed" });
  });

  it("orders a start without the flag by the time its command began", async () => {
    // A standalone folder package start or a person's own `keiko start` uses the same data: a Stop
    // pressed before it began must leave the Keiko it opened open as well.
    const instance = runningInstance();
    const before = Date.now();

    expect((await lifecycle(instance, "start", [])).code).toBe(0);
    const order = Number(readFileSync(recordPath(instance), "utf8"));
    expect(order).toBeGreaterThanOrEqual(before);
    expect(order).toBeLessThanOrEqual(Date.now());
    expect(outcomes(instance)).toEqual(["start:recorded"]);

    const stopped = await lifecycle(instance, "stop", [
      "--unless-launched-after",
      String(before - 1),
    ]);
    expect(stopped.code).toBe(STOP_SUPERSEDED_EXIT_CODE);
    expect(instance.alive).toBe(true);
  });

  it.each([
    ["start", ["--unless-launched-after", "200"]],
    ["stop", ["--launch-order", "200"]],
    ["start", ["--launch-order", "1.5"]],
    ["start", ["--launch-order", "-1"]],
    ["stop", ["--unless-launched-after", "99999999999999999"]],
  ] as const)("refuses %s %j as a usage error", async (command, args) => {
    const instance = runningInstance();

    const run = await lifecycle(instance, command, args);

    expect(run.code).toBe(2);
    expect(run.err).toContain("Usage:");
    expect(instance.killProcess).not.toHaveBeenCalled();
    expect(existsSync(recordPath(instance))).toBe(false);
  });

  it("records only closed values, never an order", async () => {
    const instance = runningInstance();

    await lifecycle(instance, "start", ["--launch-order", "1731974400123"]);
    const line = formatActivityLogProofLine(
      instance.events.find((event) => event.op === "cli.lifecycle.launch-order") ?? {},
    );

    expect(line).not.toContain("1731974400123");
    expectActivityLogProof("cli.lifecycle.launch-order.outcome", line);
  });
});
