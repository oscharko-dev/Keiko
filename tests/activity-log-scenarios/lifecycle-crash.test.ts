// Activity Log scenario matrix (#3532): the lifecycle/crash surface.
//
// Each scenario drives the production entry point with the real production file writer under a
// temporary KEIKO_STATE_DIR and reconstructs the persisted log through `keiko support analyze` to a
// complete report (tests/support/activity-log-scenario.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetInstalledProcessGuardsForTests,
  installProcessGuards,
  type ProcessGuardSink,
} from "../../packages/keiko-cli/src/process-guards.js";
import { readPersistedActivityLog } from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

type FatalListener = (reason: unknown) => void;

function installGuards(sink: ProcessGuardSink): {
  readonly uncaught: FatalListener | undefined;
  readonly cleanup: () => void;
} {
  const onSpy = vi.spyOn(process, "on");
  installProcessGuards(sink);
  const uncaught = onSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1] as
    FatalListener | undefined;
  const rejection = onSpy.mock.calls.find(([event]) => event === "unhandledRejection")?.[1] as
    FatalListener | undefined;
  return {
    uncaught,
    cleanup: (): void => {
      if (uncaught !== undefined) process.removeListener("uncaughtException", uncaught as never);
      if (rejection !== undefined) process.removeListener("unhandledRejection", rejection as never);
      onSpy.mockRestore();
    },
  };
}

describe("Activity Log scenario: lifecycle/crash", () => {
  let stateDir: string;

  // The fatal handler races the real diagnostics import against its crash bound; a warm module
  // cache keeps the scenario on the real classifier instead of its fallback.
  beforeAll(async () => {
    await import("@oscharko-dev/keiko-server");
  }, 60_000);

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-lifecycle-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  });

  afterEach(() => {
    _resetInstalledProcessGuardsForTests();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reconstructs an uncaught exception to a complete fatal lifecycle", async () => {
    const exit = vi.fn();
    const { uncaught, cleanup } = installGuards({ err: vi.fn(), exit });
    try {
      const startedAtMs = Date.now();
      uncaught?.(new TypeError("scenario-fault-injection"));
      await vi.waitFor(
        () => {
          expect(exit).toHaveBeenCalledWith(1);
        },
        { timeout: 15_000 },
      );
      const trace = expectActivityLogScenario("lifecycle-crash.crash", {
        stateDir,
        startedAtMs,
        expectedOps: ["process.fatal", "process.exiting"],
      });
      expect(trace.failureClasses).toEqual(
        expect.arrayContaining(["process-fatal", "process-shutdown"]),
      );
    } finally {
      cleanup();
    }
  });

  // Mutation fixtures: the same production trace with one causal event removed, or with an
  // unreadable line in it, must no longer pass as a complete scenario.
  it("goes red when a causal event is missing or the evidence is corrupt", async () => {
    const exit = vi.fn();
    const { uncaught, cleanup } = installGuards({ err: vi.fn(), exit });
    try {
      const startedAtMs = Date.now();
      uncaught?.(new TypeError("scenario-fault-injection"));
      await vi.waitFor(
        () => {
          expect(exit).toHaveBeenCalledWith(1);
        },
        { timeout: 15_000 },
      );
      const lines = readPersistedActivityLog(stateDir).split("\n").filter(Boolean);
      const withoutFatal = lines.filter((line) => !line.includes('"op":"process.fatal"'));
      expect(withoutFatal.length).toBe(lines.length - 1);
      expect(() =>
        expectActivityLogScenario("lifecycle-crash.crash", {
          stateDir: legacyLogCopy(withoutFatal),
          startedAtMs,
          expectedOps: ["process.fatal", "process.exiting"],
        }),
      ).toThrow(/process\.fatal persisted in causal order/u);
      expect(() =>
        expectActivityLogScenario("lifecycle-crash.crash", {
          stateDir: legacyLogCopy([...lines.slice(0, 1), "{not a record", ...lines.slice(1)]),
          startedAtMs,
          expectedOps: ["process.fatal", "process.exiting"],
        }),
      ).toThrow(/evidence integrity/u);
    } finally {
      cleanup();
    }
  });
});

const legacyCopies: string[] = [];

// A copy of mutated persisted lines as a legacy `server.log`, read back through the same
// production reader the scenario helper uses.
function legacyLogCopy(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-scenario-mutation-"));
  legacyCopies.push(dir);
  mkdirSync(join(dir, "logs"), { mode: 0o700 });
  writeFileSync(join(dir, "logs", "server.log"), `${lines.join("\n")}\n`, { mode: 0o600 });
  return dir;
}

afterAll(() => {
  for (const dir of legacyCopies.splice(0)) rmSync(dir, { recursive: true, force: true });
});
