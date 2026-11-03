import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

type Phase = "fresh" | "tracked" | "legacy";
type Health = "matched" | "foreign" | "missing" | "invalid" | "late" | "exited" | "changed";
const roots: string[] = [];

interface HealthState {
  readonly root: string;
  readonly pidPath: string;
  readonly events: SecurityLogEvent[];
  launchId: string;
  alive: boolean;
  ownerMatches: boolean;
  now: number;
}

function healthResponse(state: HealthState, health: Health): Response {
  if (health === "late") state.now = 1_001;
  if (health === "exited") state.alive = false;
  if (health === "changed") state.ownerMatches = false;
  const selected =
    health === "foreign"
      ? "b".repeat(32)
      : health === "invalid"
        ? "invalid"
        : health === "missing"
          ? undefined
          : state.launchId;
  return Response.json({
    version: KEIKO_PRODUCT_VERSION,
    ...(selected === undefined ? {} : { launchId: selected }),
  });
}

function fixture(
  phase: Phase,
  health: Health,
): {
  root: string;
  pidPath: string;
  deps: LifecycleCliDeps;
  events: SecurityLogEvent[];
  spawned: ReturnType<typeof vi.fn>;
  killed: ReturnType<typeof vi.fn>;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-health-launch-"));
  roots.push(root);
  const state: HealthState = {
    root,
    pidPath: join(root, ".keiko", "ui.pid"),
    events: [],
    launchId: "a".repeat(32),
    alive: true,
    ownerMatches: true,
    now: 0,
  };
  vi.spyOn(performance, "now").mockImplementation(() => state.now);
  if (phase !== "fresh") {
    mkdirSync(join(root, ".keiko"), { mode: 0o700 });
    writeExclusivePidFile(state.pidPath, 44556, phase === "legacy" ? undefined : state.launchId);
  }
  const spawned = vi.fn<NonNullable<LifecycleCliDeps["spawnFn"]>>((_command, _args, options) => {
    const selected = options.env?.[KEIKO_UI_LAUNCH_ID_ENV];
    if (typeof selected !== "string") throw new TypeError("Missing produced launch identity");
    state.launchId = selected;
    return Object.assign(new EventEmitter(), {
      pid: 44556,
      unref: vi.fn(),
    }) as unknown as ChildProcess;
  });
  const killed = vi.fn(() => {
    state.alive = false;
  });
  const deps: LifecycleCliDeps = {
    cwd: root,
    spawnFn: spawned,
    killProcess: killed,
    isPortAvailable: () => Promise.resolve(true),
    isProcessAlive: () => state.alive,
    verifyLaunchIdentity: () => state.ownerMatches,
    securityLogSink: {
      write: (event): void => {
        state.events.push(event);
      },
    },
    sleep: (ms): Promise<void> => {
      state.now += ms;
      return Promise.resolve();
    },
    fetchImpl: () => Promise.resolve(healthResponse(state, health)),
  };
  return { root, pidPath: state.pidPath, deps, events: state.events, spawned, killed };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(deps: LifecycleCliDeps): Promise<number> {
  return runLifecycleCli(
    "start",
    ["--no-open", "--start-timeout", "1", "--stop-timeout", "1"],
    { out: vi.fn(), err: vi.fn() },
    {},
    deps,
  );
}

describe("UI startup launch-bound health admission", () => {
  it.each(["matched", "foreign", "missing", "invalid", "late"] as const)(
    "admits only a timely matching fresh launch: %s",
    async (health) => {
      const { deps, pidPath, killed, spawned } = fixture("fresh", health);
      expect(await start(deps)).toBe(health === "matched" ? 0 : 1);
      expect(spawned).toHaveBeenCalledTimes(1);
      expect(killed).toHaveBeenCalledTimes(health === "matched" ? 0 : 1);
      expect(existsSync(pidPath)).toBe(health === "matched");
    },
  );

  it.each(["matched", "foreign", "missing", "exited", "changed"] as const)(
    "keeps tracked ownership when the responder is %s",
    async (health) => {
      const { deps, pidPath, killed, spawned } = fixture("tracked", health);
      expect(await start(deps)).toBe(health === "matched" ? 0 : 1);
      expect(spawned).not.toHaveBeenCalled();
      expect(killed).not.toHaveBeenCalled();
      expect(existsSync(pidPath)).toBe(true);
    },
  );

  it("retains the legacy version-only read path without replacing its process", async () => {
    const { deps, pidPath, killed, spawned } = fixture("legacy", "missing");
    expect(await start(deps)).toBe(0);
    expect(killed).not.toHaveBeenCalled();
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(true);
  });

  it("records the actual start decision through the registered body-free formatter", async () => {
    const { deps, events } = fixture("fresh", "matched");
    expect(await start(deps)).toBe(0);
    const decisions = events.filter((event) => event.op === "cli.lifecycle.health");
    expect(decisions).toHaveLength(1);
    const event = decisions[0];
    if (event === undefined) throw new Error("Missing actual health decision");
    expect(
      expectActivityLogProof("cli.lifecycle.health.decision", formatActivityLogProofLine(event)),
    ).toMatchObject({ phase: "start", outcome: "healthy", launchBound: true });
    expect(Object.keys(event.extra ?? {}).sort()).toEqual([
      "completeness",
      "launchBound",
      "loss",
      "outcome",
      "phase",
    ]);
  });
});
