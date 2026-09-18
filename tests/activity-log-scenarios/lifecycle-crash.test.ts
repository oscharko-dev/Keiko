// Activity Log scenario matrix (#3532): the lifecycle/crash surface.
//
// Each scenario drives the production entry point with the real production file writer under a
// temporary KEIKO_STATE_DIR and reconstructs the persisted log through `keiko support analyze` to a
// complete report (tests/support/activity-log-scenario.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetInstalledProcessGuardsForTests,
  installProcessGuards,
  type ProcessGuardSink,
} from "../../packages/keiko-cli/src/process-guards.js";
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
});
