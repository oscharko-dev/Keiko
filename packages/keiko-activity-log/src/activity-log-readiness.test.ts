// Diagnostic readiness (#3532): evaluated before the server accepts work, persisted through the
// observable production append path, and exposed on /api/health as a closed, body-free block.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordActivityLogLoss,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  checkActivityLogReadiness,
  currentActivityLogReadiness,
  refreshActivityLogReadiness,
  resetActivityLogReadinessForTests,
} from "./activity-log-readiness.js";
import { resetServerLogFailureNotices, type ActivityLogStoreHealth } from "./server-log.js";
import { resetServerLogger } from "./server-logger.js";

// A stub of the store's own health snapshot type — readiness has no parallel shape to fake.
function healthyStorage(overrides: Partial<ActivityLogStoreHealth> = {}): ActivityLogStoreHealth {
  return {
    writable: true,
    usedBytes: 0,
    budgetBytes: 1_000,
    pinQuotaBytes: 100,
    pinnedBytes: 0,
    freeBytes: 1_000_000_000,
    activeSegments: 1,
    sealedSegments: 0,
    legacyFiles: 0,
    orphanedSegments: 0,
    pressure: "none",
    pressureState: "none",
    recoveredSegments: 0,
    ...overrides,
  };
}

function readinessLines(stateDir: string): readonly string[] {
  return persistedActivityLogLines(readPersistedActivityLog(stateDir), "activity-log.readiness");
}

describe("diagnostic readiness", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-readiness-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "info");
    resetServerLogger();
    resetActivityLogReadinessForTests();
    resetActivityLogLossCountersForTests();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    resetServerLogger();
    resetServerLogFailureNotices();
    resetActivityLogReadinessForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("is ready after a real synced write probe and persists the startup line", () => {
    const snapshot = checkActivityLogReadiness({ stateDir });
    expect(snapshot).toEqual({
      readiness: "ready",
      reasons: [],
      writer: "production-file",
      lostEvents: 0,
    });
    const [line] = readinessLines(stateDir);
    expect(expectActivityLogProof("activity-log.readiness.startup-line", line ?? "")).toMatchObject(
      {
        readiness: "ready",
        reasons: [],
        writer: "production-file",
        trigger: "startup",
        lostEvents: 0,
        completeness: "complete",
      },
    );
  });

  it("reports level-silent as degraded while still persisting the mandatory readiness line", () => {
    vi.stubEnv("KEIKO_LOG_LEVEL", "silent");
    const snapshot = checkActivityLogReadiness({ stateDir, env: { KEIKO_LOG_LEVEL: "silent" } });
    expect(snapshot).toMatchObject({ readiness: "degraded", reasons: ["level-silent"] });
    expect(readinessLines(stateDir)).toHaveLength(1);
  });

  it("is unavailable with sink-unwritable when the probe write cannot be persisted", () => {
    const persist = vi.fn(() => false);
    const snapshot = checkActivityLogReadiness({ stateDir, persist });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({ readiness: "unavailable", reasons: ["sink-unwritable"] });
    expect(currentActivityLogReadiness().readiness).toBe("unavailable");
  });

  it.each([
    ["low-disk-space", "elevated", "storage-pressure"],
    ["retention-blocked", "elevated", "storage-pressure"],
    ["backpressure", "elevated", "storage-pressure"],
    ["disk-full", "critical", "storage-pressure"],
    ["budget-exceeded", "critical", "budget-exceeded"],
  ] as const)(
    "maps the store's %s pressure onto the closed readiness reason",
    (pressureState, pressure, reason) => {
      const snapshot = checkActivityLogReadiness({
        stateDir,
        storageHealth: () => healthyStorage({ pressure, pressureState }),
      });
      expect(snapshot).toMatchObject({ readiness: "degraded", reasons: [reason] });
    },
  );

  it("reads the real store health for the checked directory", () => {
    const snapshot = checkActivityLogReadiness({ stateDir });
    expect(snapshot.reasons).not.toContain("budget-exceeded");
    expect(snapshot.readiness).toBe("ready");
  });

  it("treats an unwritable storage report as an unavailable sink", () => {
    const snapshot = checkActivityLogReadiness({
      stateDir,
      storageHealth: () => healthyStorage({ writable: false }),
    });
    expect(snapshot).toMatchObject({ readiness: "unavailable", reasons: ["sink-unwritable"] });
  });

  // Review 4050605306: a throwing storage check froze the last "ready" snapshot.
  it("reduces a throwing storage check to storage-check-failed instead of keeping a stale ready", () => {
    checkActivityLogReadiness({ stateDir });
    expect(currentActivityLogReadiness().readiness).toBe("ready");
    const failing = (): ActivityLogStoreHealth => {
      throw new Error(`EACCES: permission denied, scandir '${join(stateDir, "logs")}'`);
    };
    const next = refreshActivityLogReadiness({ stateDir, storageHealth: failing });
    expect(next).toMatchObject({ readiness: "degraded", reasons: ["storage-check-failed"] });
    expect(currentActivityLogReadiness()).toMatchObject({
      readiness: "degraded",
      reasons: ["storage-check-failed"],
    });
    const transition = readinessLines(stateDir).at(-1) ?? "";
    expect(
      expectActivityLogProof("activity-log.readiness.transition-line", transition),
    ).toMatchObject({ readiness: "degraded", reasons: ["storage-check-failed"] });
    expect(transition).not.toContain(stateDir);
  });

  it("reports an unwired port when the process logger writes to another directory", () => {
    const other = join(stateDir, "elsewhere");
    const snapshot = checkActivityLogReadiness({ stateDir: other, persist: () => true });
    expect(snapshot.reasons).toContain("port-unwired");
    const inspected = checkActivityLogReadiness({
      stateDir: other,
      persist: () => true,
      scope: "directory",
    });
    expect(inspected.reasons).not.toContain("port-unwired");
  });

  it("inspects another directory through the production path without touching process readiness", () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    resetServerLogger();
    const inspected = join(stateDir, "inspected");
    mkdirSync(inspected, { mode: 0o700 });
    const snapshot = checkActivityLogReadiness({ stateDir: inspected, scope: "directory" });
    expect(snapshot).toMatchObject({ readiness: "ready", writer: "production-file" });
    expect(readinessLines(inspected)).toHaveLength(1);
    // The process itself still runs under the explicit test writer.
    expect(currentActivityLogReadiness().writer).toBe("test-injected");
  });

  it("logs a transition when a counted persistence failure arrives after startup", () => {
    checkActivityLogReadiness({ stateDir });
    expect(refreshActivityLogReadiness({ stateDir }).readiness).toBe("ready");
    recordActivityLogLoss("logger-write-failed");
    const degraded = refreshActivityLogReadiness({ stateDir });
    expect(degraded).toMatchObject({ readiness: "degraded", reasons: ["sink-unwritable"] });
    const transition = readinessLines(stateDir).at(-1) ?? "";
    expect(
      expectActivityLogProof("activity-log.readiness.transition-line", transition),
    ).toMatchObject({ readiness: "degraded", trigger: "transition", reasons: ["sink-unwritable"] });
    // Unchanged conditions write nothing further.
    const before = readinessLines(stateDir).length;
    expect(refreshActivityLogReadiness({ stateDir }).readiness).toBe("ready");
    expect(readinessLines(stateDir)).toHaveLength(before + 1);
    refreshActivityLogReadiness({ stateDir });
    expect(readinessLines(stateDir)).toHaveLength(before + 1);
  });

  it("reports an injected test writer as such, without a write probe", () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    resetServerLogger();
    const persist = vi.fn(() => true);
    const snapshot = checkActivityLogReadiness({ persist });
    expect(snapshot).toEqual({
      readiness: "ready",
      reasons: [],
      writer: "test-injected",
      lostEvents: 0,
    });
    expect(persist).not.toHaveBeenCalled();
  });
});
