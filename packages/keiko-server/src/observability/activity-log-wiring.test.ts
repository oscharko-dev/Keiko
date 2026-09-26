import {
  installActivityLogTestWriter,
  resetServerLogFailureNotices,
  resetServerLogger,
} from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

// Product-wide Activity Log wiring (#3532): the process logger never logs to nowhere in production,
// mandatory lifecycle/loss evidence survives any threshold, and every lost event is counted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { updateRuntimeActivityEvent } from "../update-runtime-activity.js";
import {
  activityLogLossSummaryEvent,
  activityLogWriterState,
  createActivityLogSink,
  createServerLogger,
  getServerLogger,
  isMandatoryActivityLogEvent,
  resolveRuntimeStateDir,
  setServerLogger,
} from "@oscharko-dev/keiko-activity-log";

function ordinaryEvent(): ReturnType<typeof updateRuntimeActivityEvent> {
  return updateRuntimeActivityEvent("request-ordinary-event", {
    eventId: "event-ordinary",
    type: "user-confirmed",
    occurredAt: "2026-09-18T00:00:00.000Z",
    status: "succeeded",
  });
}

function exitSummary(): ReturnType<typeof activityLogLossSummaryEvent> {
  return activityLogLossSummaryEvent(activityLogLossCounters(), "exit");
}

describe("process-wide Activity Log resolution", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-activity-wiring-"));
    resetServerLogger();
    resetActivityLogLossCountersForTests();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    installActivityLogTestWriter(true);
    resetServerLogger();
    resetServerLogFailureNotices();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves the CLI default state directory when KEIKO_STATE_DIR is unset", () => {
    installActivityLogTestWriter(false);
    vi.stubEnv("KEIKO_STATE_DIR", "");
    vi.spyOn(process, "cwd").mockReturnValue(root);

    getServerLogger().info(exitSummary());

    const stateDir = join(root, ".keiko");
    expect(activityLogWriterState()).toEqual({ writer: "production-file", stateDir });
    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "activity-log.loss",
    );
    expect(JSON.parse(line ?? "{}") as Record<string, unknown>).toMatchObject({
      op: "activity-log.loss",
      trigger: "exit",
      totalLost: 0,
      completeness: "complete",
      loss: "none",
    });
  });

  it("resolves a relative KEIKO_STATE_DIR against the working directory", () => {
    expect(resolveRuntimeStateDir({ KEIKO_STATE_DIR: "state" }, root)).toBe(join(root, "state"));
    expect(resolveRuntimeStateDir({ KEIKO_STATE_DIR: "" }, root)).toBe(join(root, ".keiko"));
    expect(resolveRuntimeStateDir({}, root)).toBe(join(root, ".keiko"));
  });

  it("reports an explicitly injected logger as a test writer unless declared production", () => {
    setServerLogger(createServerLogger({ sink: createBufferedServerLogSink() }));
    expect(activityLogWriterState().writer).toBe("test-injected");
    setServerLogger(
      createServerLogger({ sink: createBufferedServerLogSink() }),
      "production-file",
      root,
    );
    expect(activityLogWriterState()).toEqual({ writer: "production-file", stateDir: root });
  });

  it("rebuilds the process logger when KEIKO_STATE_DIR changes", () => {
    const first = join(root, "first");
    const second = join(root, "second");
    vi.stubEnv("KEIKO_STATE_DIR", first);
    getServerLogger().info(exitSummary());
    vi.stubEnv("KEIKO_STATE_DIR", second);
    getServerLogger().info(exitSummary());
    expect(
      persistedActivityLogLines(readPersistedActivityLog(first), "activity-log.loss"),
    ).toHaveLength(1);
    expect(
      persistedActivityLogLines(readPersistedActivityLog(second), "activity-log.loss"),
    ).toHaveLength(1);
  });
});

describe("mandatory evidence and the level threshold", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-mandatory-"));
    resetServerLogger();
    resetActivityLogLossCountersForTests();
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("classifies loss and lifecycle registrations as mandatory, nothing else", () => {
    expect(isMandatoryActivityLogEvent(exitSummary())).toBe(true);
    expect(isMandatoryActivityLogEvent(ordinaryEvent())).toBe(false);
    expect(isMandatoryActivityLogEvent({ category: "diagnostic", op: "activity-log.loss" })).toBe(
      false,
    );
  });

  it("keeps mandatory evidence when KEIKO_LOG_LEVEL=silent and drops everything else", () => {
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "silent");
    const build = vi.fn(ordinaryEvent);

    getServerLogger().info(ordinaryEvent());
    getServerLogger().info(build);
    getServerLogger().info(exitSummary());

    const raw = readPersistedActivityLog(stateDir);
    expect(persistedActivityLogLines(raw, "update.runtime.event")).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(persistedActivityLogLines(raw, "activity-log.loss")).toHaveLength(1);
  });

  it("gates the production sink like the logger, mandatory evidence included", () => {
    const sink = createActivityLogSink(stateDir, { level: "silent" });
    sink.write(ordinaryEvent());
    sink.write(exitSummary());
    sink.close?.();
    const raw = readPersistedActivityLog(stateDir);
    expect(persistedActivityLogLines(raw, "update.runtime.event")).toEqual([]);
    expect(persistedActivityLogLines(raw, "activity-log.loss")).toHaveLength(1);
  });
});

describe("loss accounting at the logger", () => {
  beforeEach(() => {
    resetActivityLogLossCountersForTests();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    resetServerLogFailureNotices();
  });

  afterEach(() => {
    resetServerLogFailureNotices();
    vi.restoreAllMocks();
  });

  it("counts a sink failure as a lost event and never throws", () => {
    const logger = createServerLogger({
      level: "debug",
      sink: {
        write(): void {
          throw new Error("disk full");
        },
      },
    });
    expect(() => {
      logger.info(ordinaryEvent());
    }).not.toThrow();
    expect(activityLogLossCounters()["logger-write-failed"]).toBe(1);
  });

  it("counts an event the persisted validation will refuse", () => {
    const logger = createServerLogger({ sink: createBufferedServerLogSink(), level: "debug" });
    logger.warn({ category: "indexing", op: "test.unregistered-operation" });
    logger.info(ordinaryEvent());
    expect(activityLogLossCounters()["schema-rejected"]).toBe(1);
  });

  it("counts a hostile event that throws inside the production sink adapter, never rethrowing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-sink-"));
    try {
      const sink = createActivityLogSink(stateDir, { level: "debug" });
      const hostile = new Proxy(ordinaryEvent(), {
        get(target, key, receiver): unknown {
          if (typeof key === "symbol") throw new Error("hostile accessor");
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      expect(() => {
        sink.write(hostile);
      }).not.toThrow();
      expect(activityLogLossCounters()["logger-write-failed"]).toBe(1);
      expect(isMandatoryActivityLogEvent(hostile)).toBe(false);
      sink.close?.();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
