// The persisted loss summary (#3532): one registered, body-free line per changed heartbeat and one
// at exit; a failed summary write is counted and never retried through the path that failed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogLossCounters,
  recordActivityLogLoss,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import {
  persistActivityLogLossSummary,
  resetActivityLogLossSummaryForTests,
} from "./activity-log-loss-summary.js";
import { resetServerLogFailureNotices } from "./server-log.js";
import { resetServerLogger } from "./server-logger.js";

describe("Activity Log loss summary", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-loss-summary-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    resetServerLogger();
    resetActivityLogLossCountersForTests();
    resetActivityLogLossSummaryForTests();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    resetServerLogger();
    resetServerLogFailureNotices();
    resetActivityLogLossSummaryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function lossLines(): readonly string[] {
    return persistedActivityLogLines(readPersistedActivityLog(stateDir), "activity-log.loss");
  }

  it("writes nothing on a heartbeat while nothing was lost", () => {
    expect(persistActivityLogLossSummary("heartbeat")).toBe("unchanged");
  });

  it("persists every counted reason on the next heartbeat, and only once", () => {
    recordActivityLogLoss("client-rejected", 3);
    recordActivityLogLoss("port-sink-failed");
    expect(persistActivityLogLossSummary("heartbeat")).toBe("persisted");
    expect(persistActivityLogLossSummary("heartbeat")).toBe("unchanged");
    const [line] = lossLines();
    expect(expectActivityLogProof("activity-log.loss.heartbeat-summary", line ?? "")).toMatchObject(
      {
        level: "warn",
        errorKind: "unavailable",
        trigger: "heartbeat",
        totalLost: 4,
        clientRejected: 3,
        portSinkFailed: 1,
        completeness: "partial",
        loss: "event-dropped",
      },
    );
  });

  it("always persists the exit summary, proving a clean process lost nothing", () => {
    expect(persistActivityLogLossSummary("exit")).toBe("persisted");
    expect(
      expectActivityLogProof("activity-log.loss.exit-summary", lossLines()[0] ?? ""),
    ).toMatchObject({ trigger: "exit", totalLost: 0, completeness: "complete", loss: "none" });
  });

  it("counts a failed summary write without writing through the failed path again", () => {
    recordActivityLogLoss("collector-dropped", 2);
    const persist = vi.fn(() => false);
    expect(persistActivityLogLossSummary("exit", { persist })).toBe("failed");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(activityLogLossCounters()["summary-write-failed"]).toBe(1);
  });

  it("does not persist for an explicitly injected test writer", () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    resetServerLogger();
    const persist = vi.fn(() => true);
    expect(persistActivityLogLossSummary("exit", { persist })).toBe("no-writer");
    expect(persist).not.toHaveBeenCalled();
  });
});
