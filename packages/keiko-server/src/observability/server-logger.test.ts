import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REDACTED_KEY } from "./log-redaction.js";
import {
  LOG_FAILURE_NOTICE_WINDOW_MS,
  SERVER_LOG_LEVEL_ENV,
  createBufferedServerLogSink,
  errorKindOf,
  resetServerLogFailureNotices,
} from "./server-log.js";
import type { ServerLogEvent, ServerLogSink } from "./server-log.js";
import {
  createServerLogger,
  getServerLogger,
  nullServerLogger,
  resetServerLogger,
  setServerLogger,
  startLogTimer,
} from "./server-logger.js";

function throwingSink(): ServerLogSink {
  return {
    write(_event: ServerLogEvent): void {
      throw new Error("the sink is broken");
    },
  };
}

describe("server logger levels", () => {
  it("emits at or above the threshold and suppresses below it", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "warn" });
    logger.debug({ category: "indexing", op: "a" });
    logger.info({ category: "indexing", op: "b" });
    logger.warn({ category: "indexing", op: "c" });
    logger.error({ category: "indexing", op: "d" });
    expect(sink.events.map((event) => event.op)).toStrictEqual(["c", "d"]);
    expect(sink.events.map((event) => event.level)).toStrictEqual(["warn", "error"]);
  });

  it("reports which levels are enabled so a hot path can skip its own work", () => {
    const logger = createServerLogger({ sink: createBufferedServerLogSink(), level: "info" });
    expect(logger.isLevelEnabled("debug")).toBe(false);
    expect(logger.isLevelEnabled("info")).toBe(true);
    expect(logger.level).toBe("info");
  });

  it("never evaluates a suppressed event source — the gate runs before the thunk", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "info" });
    const build = vi.fn(() => ({ category: "indexing", op: "window" }) as const);
    logger.debug(build);
    expect(build).not.toHaveBeenCalled();
    logger.info(build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(sink.events).toHaveLength(1);
  });

  it("emits nothing at all from the null logger", () => {
    const logger = nullServerLogger();
    expect(logger.isLevelEnabled("error")).toBe(false);
    expect(() => {
      logger.error({ category: "gateway", op: "x" });
    }).not.toThrow();
  });

  it("routes log(level, event) to the same gate as the named methods", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "warn" });
    logger.log("info", { category: "search", op: "suppressed" });
    logger.log("error", { category: "search", op: "kept" });
    expect(sink.events.map((event) => event.op)).toStrictEqual(["kept"]);
  });
});

describe("server logger bound context", () => {
  it("merges the bound context into every event so callers name it once", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "debug" }).child({
      correlationId: "req-42",
      capsuleIdDigest: "9f2c1b0e",
    });
    logger.info({ category: "indexing", op: "indexing.job.started", extra: { sourceCount: 3 } });

    expect(sink.events[0]).toMatchObject({
      correlationId: "req-42",
      op: "indexing.job.started",
      extra: { capsuleIdDigest: "9f2c1b0e", sourceCount: 3 },
    });
  });

  it("composes child bindings, with the deepest binding winning", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "debug" })
      .child({ correlationId: "req-1", jobId: "job-a", lane: "generic" })
      .child({ correlationId: "req-2", jobId: "job-b" });
    logger.info({ category: "indexing", op: "x" });

    expect(sink.events[0]).toMatchObject({
      correlationId: "req-2",
      extra: { jobId: "job-b", lane: "generic" },
    });
  });

  it("lets the event override the binding, and never mutates the parent logger", () => {
    const sink = createBufferedServerLogSink();
    const parent = createServerLogger({ sink, level: "debug" }).child({ jobId: "job-a" });
    const child = parent.child({ jobId: "job-b" });
    child.info({ category: "indexing", op: "child" });
    parent.info({ category: "indexing", op: "parent" });
    parent.info({ category: "indexing", op: "explicit", extra: { jobId: "job-c" } });

    expect(sink.events.map((event) => event.extra?.jobId)).toStrictEqual([
      "job-b",
      "job-a",
      "job-c",
    ]);
  });

  it("lifts a bound category onto the envelope and lets the event override it", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "debug" }).child({ category: "indexing" });
    logger.info({ op: "bound" });
    logger.info({ category: "gateway", op: "overridden" });
    expect(sink.events.map((event) => event.category)).toStrictEqual(["indexing", "gateway"]);
    // The lifted keys must not also appear as ordinary fields.
    expect(sink.events[0]?.extra).toBeUndefined();
  });

  it("lifts a bound parentCorrelationId onto the envelope, like correlationId", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "debug" }).child({
      correlationId: "job-child-1",
      parentCorrelationId: "req-parent-1",
    });
    logger.info({ category: "indexing", op: "job.spawned" });

    expect(sink.events[0]).toMatchObject({
      correlationId: "job-child-1",
      parentCorrelationId: "req-parent-1",
    });
    // The lifted keys must not also appear as ordinary fields.
    expect(sink.events[0]?.extra).toBeUndefined();
  });

  it("lets an explicit event parentCorrelationId override the bound one", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "debug" }).child({
      parentCorrelationId: "req-parent-bound",
    });
    logger.info({ category: "indexing", op: "x", parentCorrelationId: "req-parent-explicit" });

    expect(sink.events[0]?.parentCorrelationId).toBe("req-parent-explicit");
  });

  it("ignores an unrecognised bound category rather than inventing one", () => {
    const sink = createBufferedServerLogSink();
    createServerLogger({ sink, level: "debug" }).child({ category: "made-up" }).info({ op: "x" });
    expect(sink.events[0]?.category).toBe("diagnostic");
  });

  it("redacts bound context exactly like any other field", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "debug" }).child({
      apiKey: ["sk", "proj", "abcdef0123456789"].join("-"),
    });
    logger.info({ category: "gateway", op: "call" });
    expect(sink.lines()[0]).toContain(REDACTED_KEY);
    expect(sink.lines()[0]).not.toContain("sk-proj-");
  });

  it("accepts a context at construction time", () => {
    const sink = createBufferedServerLogSink();
    createServerLogger({ sink, level: "debug", context: { correlationId: "req-9" } }).info({
      category: "http",
      op: "x",
    });
    expect(sink.events[0]?.correlationId).toBe("req-9");
  });
});

// Every test in this suite provokes a logging failure, and a failure now produces a throttled
// stderr notice. Silencing it keeps the run's output clean; the tests that assert on the notice
// take the same spy back.
function silenceStderr(): void {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
}

function stderrNotice(call: unknown): Record<string, unknown> {
  return JSON.parse(String(call)) as Record<string, unknown>;
}

describe("server logger failure isolation", () => {
  beforeEach(() => {
    silenceStderr();
    resetServerLogFailureNotices();
  });

  afterEach(() => {
    resetServerLogFailureNotices();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never propagates a sink failure to the operation being logged", () => {
    const logger = createServerLogger({ sink: throwingSink(), level: "debug" });
    expect(() => {
      logger.error({ category: "gateway", op: "x" });
      logger.info({ category: "gateway", op: "y" });
    }).not.toThrow();
  });

  it("never propagates a failure raised while building the event", () => {
    const sink = createBufferedServerLogSink();
    const logger = createServerLogger({ sink, level: "debug" });
    expect(() => {
      logger.debug((): never => {
        throw new Error("field assembly failed");
      });
    }).not.toThrow();
    expect(sink.events).toHaveLength(0);
  });

  it("keeps working after a sink failure", () => {
    let failures = 0;
    const events: ServerLogEvent[] = [];
    const flaky: ServerLogSink = {
      write(event: ServerLogEvent): void {
        failures += 1;
        if (failures === 1) throw new Error("transient");
        events.push(event);
      },
    };
    const logger = createServerLogger({ sink: flaky, level: "debug" });
    logger.info({ category: "http", op: "first" });
    logger.info({ category: "http", op: "second" });
    expect(events.map((event) => event.op)).toStrictEqual(["second"]);
  });

  // The defect this suite pins from the other side: isolation was implemented as DISCARDING, so a
  // log broken by a full disk or a permission change was indistinguishable from a quiet system —
  // the exact silence the activity log exists to end.
  it("reports a sink failure on stderr, naming the op and correlation id", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createServerLogger({ sink: throwingSink(), level: "debug" }).child({
      correlationId: "job-4f2a",
    });
    logger.error({ category: "gateway", op: "gateway.chat.failed" });

    expect(stderr).toHaveBeenCalledTimes(1);
    const notice = stderrNotice(stderr.mock.calls[0]?.[0]);
    expect(notice).toMatchObject({
      level: "error",
      category: "diagnostic",
      op: "server-log.write-failed",
      errorKind: "Error",
      failedOp: "gateway.chat.failed",
      correlationId: "job-4f2a",
    });
    // Body-free like every other line: the thrown message is classified, never carried.
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain("the sink is broken");
  });

  it("reports a failure raised while building the event, with no op to name", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createServerLogger({ sink: createBufferedServerLogSink(), level: "debug" });
    logger.debug((): never => {
      throw new TypeError("field assembly failed");
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    const notice = stderrNotice(stderr.mock.calls[0]?.[0]);
    expect(notice).toMatchObject({ op: "server-log.write-failed", errorKind: "TypeError" });
    // The event never existed, so there is nothing honest to say about which op failed.
    expect(notice.failedOp).toBeUndefined();
  });

  it("throttles the notice to one per window and reports how many it suppressed", () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createServerLogger({ sink: throwingSink(), level: "debug" });
    for (let index = 0; index < 5; index += 1) {
      logger.info({ category: "indexing", op: "indexing.document.persisted" });
    }
    // A per-item loop over a broken descriptor must not turn one flood into another.
    expect(stderr).toHaveBeenCalledTimes(1);

    // The throttle hides repetition, never scale: the next notice carries the count it swallowed.
    vi.advanceTimersByTime(LOG_FAILURE_NOTICE_WINDOW_MS);
    logger.info({ category: "indexing", op: "indexing.document.persisted" });
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderrNotice(stderr.mock.calls[0]?.[0]).suppressedNotices).toBeUndefined();
    expect(stderrNotice(stderr.mock.calls[1]?.[0]).suppressedNotices).toBe(4);
  });
});

describe("server logger helpers", () => {
  it("measures a non-negative monotonic elapsed duration", () => {
    const elapsed = startLogTimer();
    const first = elapsed();
    const second = elapsed();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("classifies a thrown value without ever reading its message", () => {
    const coded = Object.assign(new Error("connection to https://host refused"), {
      code: "ECONNREFUSED",
    });
    expect(errorKindOf(coded)).toBe("ECONNREFUSED");
    expect(errorKindOf(new TypeError("the document body was ..."))).toBe("TypeError");
    expect(errorKindOf(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("AbortError");
    // A message-shaped `code` is refused by the identifier pattern rather than logged.
    expect(
      errorKindOf(Object.assign(new Error("x"), { code: "the request body was rejected" })),
    ).toBe("Error");
    expect(errorKindOf("a raw string error")).toBe("unknown");
    expect(errorKindOf(undefined)).toBe("unknown");
    expect(errorKindOf(null)).toBe("unknown");
    expect(errorKindOf({})).toBe("unknown");
  });
});

describe("process-wide server logger", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-process-logger-"));
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetServerLogger();
  });

  afterEach(() => {
    // The process-wide slot is shared mutable state; every suite must hand it back empty.
    resetServerLogger();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("writes nothing when no state directory is configured", () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    expect(() => {
      getServerLogger().error({ category: "indexing", op: "x" });
    }).not.toThrow();
  });

  it("writes to <stateDir>/logs/server.log when the CLI configured one", () => {
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    getServerLogger().warn({ category: "indexing", op: "indexing.job.skipped" });
    const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
    expect(raw).toContain("indexing.job.skipped");
    expect(raw).toContain('"level":"warn"');
  });

  it("returns the same instance until it is reset", () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    expect(getServerLogger()).toBe(getServerLogger());
    resetServerLogger();
    const replacement = createServerLogger({ sink: createBufferedServerLogSink() });
    setServerLogger(replacement);
    expect(getServerLogger()).toBe(replacement);
  });
});
