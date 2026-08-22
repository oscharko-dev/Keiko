import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_LOG_FIELD_COUNT, REDACTED_KEY, REDACTED_SHAPE } from "./log-redaction.js";
import {
  MAX_LOG_LINE_BYTES,
  SERVER_LOG_LEVEL_ENV,
  SERVER_LOG_SCHEMA_VERSION,
  closeFileServerLogSinks,
  createBufferedServerLogSink,
  createFileServerLogSink,
  errorKindOf,
  formatServerLogLine,
  reportServerLogFailure,
  resetServerLogFailureNotices,
  serverLogInstanceId,
  serverLogLineBytes,
  serverLogLineWithinCap,
} from "./server-log.js";
import type { ServerLogEvent } from "./server-log.js";
import { getServerLogger, resetServerLogger, shutdownServerLogging } from "./server-logger.js";

// A line the file holds, or `null` when those bytes are not a parseable record. Used by the
// short-write test, which is about exactly that distinction.
function readRawRecords(stateDir: string): (Record<string, unknown> | null)[] {
  const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
}

// Counters for the syscalls the sink's cost claim is actually about. The mock passes every call
// through to the real filesystem — it only counts — so every other test in this file keeps
// exercising real rotation, real appends and real permissions.
const fsCalls = vi.hoisted(() => ({
  linkErrorCode: null as string | null,
  rename: 0,
  open: 0,
  write: 0,
  close: 0,
  // `null` passes every write through untouched. A number is a byte budget: the descriptor accepts
  // that many more bytes and then reports 0, which is what a stalled descriptor reports and the
  // only way to produce a short write on a regular file.
  writeBudgetBytes: null as number | null,
}));

// The four-argument Buffer overload is the only one the module under test uses, and the only one
// the budget path has to understand. `Parameters<>` resolves to the string overload, so the
// forwarding path keeps it and the budget path names the shape it actually receives.
type BufferWriteArgs = readonly [fd: number, buffer: Buffer, offset: number, length: number];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      fsCalls.open += 1;
      return actual.openSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>): number => {
      fsCalls.write += 1;
      const budget = fsCalls.writeBudgetBytes;
      if (budget === null) return actual.writeSync(...args);
      const [fd, buffer, offset, length] = args as unknown as BufferWriteArgs;
      const allowed = Math.min(length, budget);
      fsCalls.writeBudgetBytes = budget - allowed;
      return allowed === 0 ? 0 : actual.writeSync(fd, buffer, offset, allowed);
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>): void => {
      fsCalls.close += 1;
      actual.closeSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>): void => {
      fsCalls.rename += 1;
      actual.renameSync(...args);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>): void => {
      const forced = fsCalls.linkErrorCode;
      if (forced === null) {
        actual.linkSync(...args);
        return;
      }
      const error: NodeJS.ErrnoException = new Error(`forced ${forced}`);
      error.code = forced;
      throw error;
    },
  };
});

const BURST_EVENT_COUNT = 2_000;

function readLines(stateDir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
  if (raw.trim() === "") return [];
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("server activity log", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-"));
    // Hermetic: the suite must not observe the developer's or the runner's own threshold.
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    fsCalls.writeBudgetBytes = null;
    fsCalls.linkErrorCode = null;
    fsCalls.rename = 0;
    // The failure notice is throttled process-wide, so a test that asserts on it must start from a
    // slate no earlier test can have used up.
    resetServerLogFailureNotices();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    // The file sink is a process-wide singleton per log directory, so a suite that leaves one
    // registered leaves its descriptor open too.
    closeFileServerLogSinks();
    fsCalls.writeBudgetBytes = null;
    fsCalls.linkErrorCode = null;
    fsCalls.rename = 0;
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes one JSON line per event into <stateDir>/logs/server.log", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "request", status: 200, durationMs: 42 });
    sink.write({
      category: "embedding",
      op: "batch",
      status: 500,
      errorKind: "http-error",
      extra: { items: 36 },
    });

    const lines = readLines(stateDir);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      category: "http",
      op: "request",
      status: 200,
      durationMs: 42,
    });
    expect(lines[1]).toMatchObject({
      category: "embedding",
      op: "batch",
      status: 500,
      errorKind: "http-error",
      items: 36,
    });
    expect(typeof lines[0]?.ts).toBe("string");
  });

  // Envelope v2 (#2902): every line the file sink writes carries a process/sequence identity an
  // agent joins a run across a rotated multi-day file on. This is the functional counterpart to the
  // spoofing test below — it proves the real values actually land on disk, not merely that a forged
  // one is stripped.
  it("stamps schemaVersion, pid, instanceId and seq on every file-sink line", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "one" });
    sink.write({ category: "http", op: "two" });
    const lines = readLines(stateDir);

    expect(lines[0]).toMatchObject({ schemaVersion: SERVER_LOG_SCHEMA_VERSION, pid: process.pid });
    expect(lines[0]?.instanceId).toBe(serverLogInstanceId());
    expect(String(lines[0]?.instanceId)).toMatch(/^[0-9a-f]{8}$/);
    // Monotonic PER PROCESS, not per file and not starting at a fixed value: the allocator is
    // shared by every ActiveLog this process ever resolves, so an earlier test's sink may already
    // have claimed numbers below this one — an absolute starting value is exactly what a
    // process-wide counter makes unstable to assert. What the contract actually promises is that
    // two lines written back to back by the SAME sink are exactly one apart, and carry the SAME
    // instanceId/pid — two different process lifetimes are told apart by instanceId, never pid
    // alone, since the OS reuses pids across restarts.
    expect(typeof lines[0]?.seq).toBe("number");
    expect(lines[1]?.seq).toBe((lines[0]?.seq as number) + 1);
    expect(lines[1]?.instanceId).toBe(lines[0]?.instanceId);
    expect(lines[1]?.pid).toBe(lines[0]?.pid);
  });

  // The reserved-field defense-in-depth this envelope depends on: `RESERVED_FIELD_NAMES` in
  // `log-redaction.ts` strips a same-named `extra` key before the real identity is ever applied, so
  // a caller (or a hostile upstream value merged into `extra`) cannot make its own line look like a
  // different process or a different position in the sequence.
  it("never lets extra spoof schemaVersion, pid, instanceId or seq", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({
      category: "http",
      op: "spoof-attempt",
      extra: { schemaVersion: 999, pid: -1, instanceId: "deadbeef", seq: 999_999, keep: 1 },
    });
    const lines = readLines(stateDir);

    expect(lines[0]).toMatchObject({
      schemaVersion: SERVER_LOG_SCHEMA_VERSION,
      pid: process.pid,
      keep: 1,
    });
    expect(lines[0]?.instanceId).toBe(serverLogInstanceId());
    expect(lines[0]?.pid).not.toBe(-1);
    expect(lines[0]?.instanceId).not.toBe("deadbeef");
    // The real, process-allocated value, never the forged one. `seq` is not pinned to 1 here: the
    // allocator is process-wide, so an earlier test's sink may already have advanced it — asserting
    // "not the forged value, and a genuine positive integer" is what still holds regardless.
    expect(lines[0]?.seq).not.toBe(999_999);
    expect(typeof lines[0]?.seq).toBe("number");
    expect(lines[0]?.seq as number).toBeGreaterThan(0);
  });

  // ADR-0173 D2's join key is `(pid, instanceId, seq)`, promised unique PROCESS-WIDE — not merely
  // within one log file. Before this fix `seq` lived on `ActiveLog`, one per resolved directory, so
  // two state directories in the very same process each started counting at 1 and could stamp an
  // identical tuple on two unrelated lines. A shared, module-scoped allocator is the only way two
  // independent `ActiveLog`s can still hand out non-overlapping numbers.
  it("shares one seq allocator across independent state directories, so seq never repeats", () => {
    const otherStateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-other-"));
    try {
      const sinkA = createFileServerLogSink(stateDir);
      const sinkB = createFileServerLogSink(otherStateDir);
      sinkA.write({ category: "http", op: "a1" });
      sinkB.write({ category: "http", op: "b1" });
      sinkA.write({ category: "http", op: "a2" });
      sinkB.write({ category: "http", op: "b2" });
      sinkB.close?.();

      const seqA = readLines(stateDir).map((line) => line.seq as number);
      const seqB = readLines(otherStateDir).map((line) => line.seq as number);

      // No duplicate anywhere across the two directories: a per-directory counter would let
      // seqA[0] and seqB[0] both be 1.
      const combined = [...seqA, ...seqB];
      expect(new Set(combined).size).toBe(combined.length);
      // Strictly increasing within each directory's own lines, even though the two sinks'
      // writes were interleaved and share one process-wide counter.
      expect(seqA[1]).toBeGreaterThan(seqA[0] ?? Number.POSITIVE_INFINITY);
      expect(seqB[1]).toBeGreaterThan(seqB[0] ?? Number.POSITIVE_INFINITY);
    } finally {
      rmSync(otherStateDir, { recursive: true, force: true });
    }
  });

  // The counter is claimed BEFORE the write is attempted (see `allocateServerLogSeq`), so a write
  // that throws still consumes a number. That number is never seen again — reusing it for the next
  // line would be silently worse than the gap it would hide. The gap is therefore the expected,
  // diagnosable outcome, not a bug: an agent reconstructing the run sees seq jump by two and knows
  // exactly one line failed to persist at that point, which is what the stderr failure notice
  // (asserted elsewhere) also reports.
  it("leaves a gap in seq for a write that throws, and keeps allocating correctly after", () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "http", op: "before-failure" });
    const before = readRawRecords(stateDir)[0]?.seq as number;

    // A zero-byte budget means the descriptor accepts NOTHING for this record: `writeAll` throws
    // on its first call before a single byte lands, so — unlike the short-write test below, which
    // corrupts a partial record — this record leaves no bytes behind at all. `readRawRecords`
    // filters the resulting blank line, which is why it (not `readLines`) is used here.
    //
    // The restore runs in `finally` so this shared fixture cannot leak a nonzero budget into a
    // later test if anything above throws before the plain reset would have run — belt-and-braces
    // alongside the file's own unconditional `afterEach` reset.
    fsCalls.writeBudgetBytes = 0;
    try {
      sink.write({ category: "http", op: "dropped" });
    } finally {
      fsCalls.writeBudgetBytes = null;
    }

    sink.write({ category: "http", op: "after-failure" });
    const records = readRawRecords(stateDir);

    // Only the two writes that actually landed are on disk; the failed one never appears.
    expect(records.map((record) => record?.op)).toStrictEqual(["before-failure", "after-failure"]);
    // The gap is exactly one seq wide: the failed write claimed `before + 1` and never persisted
    // it, so the next persisted line is `before + 2`, not `before + 1`.
    expect(records[1]?.seq).toBe(before + 2);
  });

  // Envelope v2 widens the category union to include process-lifecycle lines; this proves the sink
  // actually accepts and persists the new member rather than only the type system allowing it.
  it("accepts the process category alongside every existing one", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "process", op: "process.started" });
    expect(readLines(stateDir)[0]).toMatchObject({ category: "process", op: "process.started" });
  });

  it("stamps every line with a level, defaulting to info", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "request" });
    sink.write({ level: "error", category: "gateway", op: "transport-failed" });
    const lines = readLines(stateDir);
    expect(lines[0]).toMatchObject({ level: "info" });
    expect(lines[1]).toMatchObject({ level: "error" });
  });

  it("survives write failures without throwing", () => {
    // Point at a path that is a file, not a directory; the sink must fall back to a null
    // writer instead of crashing the server on startup.
    const filePath = join(stateDir, "not-a-dir");
    writeFileSync(filePath, "block");
    const sink = createFileServerLogSink(filePath);
    expect(() => {
      sink.write({ category: "http", op: "request" });
    }).not.toThrow();
  });

  it("never propagates a failure that appears after the sink was created", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "before" });
    // The log directory disappearing under a running server (an operator clearing state, a
    // container volume detaching) must degrade to dropped lines, never to a thrown request.
    rmSync(join(stateDir, "logs"), { recursive: true, force: true });
    expect(() => {
      sink.write({ category: "http", op: "after" });
      sink.write({ category: "http", op: "after-again" });
    }).not.toThrow();
  });

  it("rotates the current log to a dated file on the next day and prunes past seven", () => {
    // The clock is pinned BEFORE the sink exists: the ActiveLog takes its `currentDay` at
    // construction, so a sink built under the real clock would archive under the runner's date and
    // make the retained set depend on the day the suite happens to run.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const logsDir = join(stateDir, "logs");
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "day1" });
    // Eight pre-existing daily rotations. With the one this test's own boundary produces that is
    // nine, so pruning has to delete exactly the two oldest.
    for (const day of [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]) {
      writeFileSync(join(logsDir, `server-${day}.log`), "seed\n");
    }
    // Advance the clock to trigger rotation.
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    sink.write({ category: "http", op: "day2" });

    // The exact retained set, not an upper bound: `toBeLessThanOrEqual(7)` is also satisfied by a
    // prune that deletes every rolled file, which is the opposite defect from the one under test.
    const rolled = readdirSync(logsDir)
      .filter((name) => name.startsWith("server-"))
      .sort();
    expect(rolled).toStrictEqual([
      "server-2026-08-03.log",
      "server-2026-08-04.log",
      "server-2026-08-05.log",
      "server-2026-08-06.log",
      "server-2026-08-07.log",
      "server-2026-08-08.log",
      "server-2026-08-15.log",
    ]);
    // Yesterday's rolled file holds yesterday's line, not a fresh empty file.
    expect(readFileSync(join(logsDir, "server-2026-08-15.log"), "utf8")).toContain("day1");
    // The current log holds only the newest event.
    const current = readLines(stateDir);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ op: "day2" });
    sink.close?.();
  });

  // Requirement: rotation must be atomic ACROSS PROCESSES. Two Keiko processes on one state
  // directory both reach the UTC boundary; `renameSync` replaces its destination, so the second
  // one renamed its own fresh file over the archive the first had just written and the finished
  // day was gone. The in-process registry cannot see a second process by construction.
  it("never replaces an archive another process already wrote", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const logsDir = join(stateDir, "logs");
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "indexing", op: "our-day-20" });

    // A peer process wins the boundary: it archives the finished day and starts a fresh file. Our
    // sink still holds the descriptor for the archived inode, exactly as it would in production.
    renameSync(join(logsDir, "server.log"), join(logsDir, "server-2026-08-20.log"));
    writeFileSync(join(logsDir, "server.log"), `${JSON.stringify({ op: "peer-day-21" })}\n`);

    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    sink.write({ category: "indexing", op: "our-day-21" });

    // The peer's archive is untouched. Under the rename it holds `peer-day-21` and the whole of
    // 08-20 is unrecoverable.
    const archived = readFileSync(join(logsDir, "server-2026-08-20.log"), "utf8");
    expect(archived).toContain("our-day-20");
    expect(archived).not.toContain("peer-day-21");
    // And both processes' lines for the new day are in the new day's file.
    expect(readLines(stateDir).map((line) => line.op)).toStrictEqual(["peer-day-21", "our-day-21"]);
    sink.close?.();
  });

  it("bounds a stalled write to the line that stalled instead of corrupting the next one", () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "http", op: "first" });
    // The descriptor takes 10 bytes of the next line and then reports 0 — a short write that never
    // completes. The bytes it accepted cannot be recalled. Restored in `finally` so a failed
    // assertion above cannot leave the shared fixture's budget mutated for a later test.
    fsCalls.writeBudgetBytes = 10;
    try {
      expect(() => {
        sink.write({ category: "http", op: "stalled" });
      }).not.toThrow();
    } finally {
      fsCalls.writeBudgetBytes = null;
      fsCalls.linkErrorCode = null;
      fsCalls.rename = 0;
    }
    sink.write({ category: "http", op: "second" });

    const records = readRawRecords(stateDir);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ op: "first" });
    // The truncated bytes are their own line: one lost record, and only one.
    expect(records[1]).toBeNull();
    // The record written AFTER the stall is intact. Returning from the short write instead of
    // dropping the line glued this one onto the partial bytes and cost two records, not one.
    expect(records[2]).toMatchObject({ op: "second" });
  });

  it("announces a write failure on stderr instead of dropping the line in silence", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    // Restored in `finally` so a failed assertion below cannot leave the shared fixture's budget
    // mutated for a later test.
    fsCalls.writeBudgetBytes = 0;
    try {
      sink.write({
        category: "indexing",
        op: "indexing.document.persisted",
        correlationId: "job-7",
      });
    } finally {
      fsCalls.writeBudgetBytes = null;
      fsCalls.linkErrorCode = null;
      fsCalls.rename = 0;
    }

    expect(stderr).toHaveBeenCalledTimes(1);
    const notice = JSON.parse(String(stderr.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(notice).toMatchObject({
      level: "error",
      category: "diagnostic",
      op: "server-log.write-failed",
      failedOp: "indexing.document.persisted",
      correlationId: "job-7",
    });
    // Body-free, exactly like a log line: a classification, never the thrown message.
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain("accepted no bytes");
  });

  // Regression: when stderr itself cannot be written (a closed descriptor, a broken pipe, ...),
  // the notice must not vanish into an empty catch. It surfaces on the independent
  // `process.emitWarning` channel instead — Node dispatches the 'warning' event synchronously to
  // any listener even when stderr is gone. Fails before the fix: the write failure was swallowed
  // and no warning was ever emitted.
  it("warns via process.emitWarning when the stderr notice itself cannot be written", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("EPIPE: broken pipe");
    });
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      reportServerLogFailure(new Error("disk full"), {
        op: "indexing.persist",
        correlationId: "job-42",
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const calls: readonly (readonly unknown[])[] = warn.mock.calls;
      expect(calls[0]?.[1]).toMatchObject({ code: "KEIKO_LOG_NOTICE_FAILED" });
      const options = calls[0]?.[1] as { detail?: string } | undefined;
      expect(options?.detail).toContain("job-42");
      // Body-free: the thrown pipe error's own text must never reach the warning.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("broken pipe");
    } finally {
      warn.mockRestore();
    }
  });

  // Regression for ADR-0173 D2's accounting promise: a suppressed count otherwise surfaces only on
  // the NEXT unthrottled failure. Without a shutdown flush, a count with no further failure to
  // report it is silently lost the instant the notice state is cleared — exactly what a clean
  // process shutdown does.
  it("flushes an unreported suppressed count to stderr instead of losing it on shutdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00Z"));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    reportServerLogFailure(new Error("first"), { op: "indexing.persist" });
    expect(stderr).toHaveBeenCalledTimes(1);

    // Inside the one-minute throttle window: counted, not emitted.
    vi.setSystemTime(new Date("2026-08-21T00:00:10Z"));
    reportServerLogFailure(new Error("second"), { op: "indexing.persist" });
    expect(stderr).toHaveBeenCalledTimes(1);

    shutdownServerLogging();

    expect(stderr).toHaveBeenCalledTimes(2);
    const flushNotice = JSON.parse(String(stderr.mock.calls[1]?.[0])) as Record<string, unknown>;
    expect(flushNotice).toMatchObject({
      level: "error",
      category: "diagnostic",
      op: "server-log.write-failed",
      reason: "shutdown-flush",
      suppressedNotices: 1,
    });
  });

  it("closes the descriptor it holds and reopens on the next write", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "one" });
    sink.close?.();
    sink.write({ category: "http", op: "two" });
    expect(readLines(stateDir)).toHaveLength(2);
  });

  // Requirement 1, and the highest-consequence defect in this module: DATA LOSS at the UTC day
  // boundary. The CLI wires one file sink as `deps.activityLog` while `getServerLogger()` lazily
  // builds another for deep call sites. Two independent ActiveLogs each carry their own
  // `currentDay`, so both rotate: the first renames the finished day aside, the second renames the
  // FRESH file over that archive — and the whole previous day is gone. One sink per file, one
  // rotation state, whoever asks for it.
  it("shares one rotation state between every sink on the same file", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    // Two independent consumers, exactly as the CLI and the process logger ask for them.
    const cliSink = createFileServerLogSink(stateDir, { level: "debug" });
    const processSink = createFileServerLogSink(stateDir, { level: "debug" });
    cliSink.write({ category: "indexing", op: "before-midnight" });

    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    cliSink.write({ category: "indexing", op: "after-midnight-cli" });
    processSink.write({ category: "indexing", op: "after-midnight-process" });
    cliSink.close?.();

    // The finished day survives. With a second rotation state this file holds
    // `after-midnight-cli` instead — the day it was archived from having been destroyed.
    const rolled = readFileSync(join(stateDir, "logs", "server-2026-08-20.log"), "utf8");
    expect(rolled).toContain("before-midnight");
    expect(rolled).not.toContain("after-midnight");
    // And nothing written after the boundary was lost.
    expect(readLines(stateDir).map((line) => line.op)).toStrictEqual([
      "after-midnight-cli",
      "after-midnight-process",
    ]);
  });

  it("measures the line cap in bytes, because the write encodes UTF-8", () => {
    // A CJK line is three UTF-8 bytes per UTF-16 code unit. Judged by `String.length` this line
    // is comfortably inside the cap while being three times its stated size on disk.
    const multiByteLine = `${"文".repeat(MAX_LOG_LINE_BYTES - 1)}\n`;
    expect(multiByteLine.length).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    expect(serverLogLineBytes(multiByteLine)).toBeGreaterThan(MAX_LOG_LINE_BYTES);
    expect(serverLogLineWithinCap(multiByteLine)).toBe(false);
    // An ASCII line right at the cap still fits, so the fix did not simply tighten the cap.
    expect(serverLogLineWithinCap("a".repeat(MAX_LOG_LINE_BYTES))).toBe(true);
    expect(serverLogLineWithinCap("a".repeat(MAX_LOG_LINE_BYTES + 1))).toBe(false);
  });

  it("collects events in memory for tests via the buffered sink", () => {
    const sink = createBufferedServerLogSink();
    sink.write({ category: "gateway", op: "chat", status: 200 });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ category: "gateway", op: "chat", status: 200 });
  });

  it("exposes the redacted lines the file sink would write, and can be cleared", () => {
    const sink = createBufferedServerLogSink();
    sink.write({ category: "gateway", op: "chat", extra: { prompt: "hello there friend" } });
    expect(sink.lines()[0]).toContain(REDACTED_KEY);
    sink.clear();
    expect(sink.events).toHaveLength(0);
  });
});

describe("server activity log level threshold", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-level-"));
  });

  afterEach(() => {
    closeFileServerLogSinks();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("drops an event below the threshold and keeps everything at or above it", () => {
    const sink = createFileServerLogSink(stateDir, { level: "warn" });
    sink.write({ level: "debug", category: "indexing", op: "window" });
    sink.write({ level: "info", category: "indexing", op: "document" });
    sink.write({ level: "warn", category: "indexing", op: "skipped" });
    sink.write({ level: "error", category: "indexing", op: "breaker" });
    expect(readLines(stateDir).map((line) => line.op)).toStrictEqual(["skipped", "breaker"]);
  });

  it("writes nothing at all — not even the file — under a silent threshold", () => {
    const sink = createFileServerLogSink(stateDir, { level: "silent" });
    sink.write({ level: "error", category: "indexing", op: "breaker" });
    expect(existsSync(join(stateDir, "logs", "server.log"))).toBe(false);
  });

  it("defaults to info and reads KEIKO_LOG_LEVEL from the environment", () => {
    const defaulted = createFileServerLogSink(stateDir, { env: {} });
    defaulted.write({ level: "debug", category: "indexing", op: "suppressed" });
    defaulted.write({ level: "info", category: "indexing", op: "kept" });
    expect(readLines(stateDir).map((line) => line.op)).toStrictEqual(["kept"]);

    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    const verbose = createFileServerLogSink(stateDir);
    verbose.write({ level: "debug", category: "indexing", op: "now-kept" });
    expect(readLines(stateDir).map((line) => line.op)).toStrictEqual(["kept", "now-kept"]);
  });
});

describe("server activity log line format", () => {
  it("redacts every field the caller supplies through extra", () => {
    const line = formatServerLogLine({
      category: "embedding",
      op: "indexing.embedding.request",
      extra: {
        endpoint: "https://gateway.internal:8443",
        prompt: "the document body",
        apiKey: ["sk", "proj", "abcdef0123456789"].join("-"),
        inputCount: 36,
      },
    });
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record).toMatchObject({
      endpoint: "https://gateway.internal:8443",
      prompt: REDACTED_KEY,
      apiKey: REDACTED_KEY,
      inputCount: 36,
    });
  });

  it("redacts the envelope labels too, so op and errorKind cannot carry content", () => {
    const record = JSON.parse(
      formatServerLogLine({
        category: "http",
        op: "x".repeat(400),
        correlationId: "a\nb",
        errorKind: ["sk", "proj", "abcdef0123456789"].join("-"),
      }),
    ) as Record<string, unknown>;
    expect(String(record.op)).not.toContain("xxxx");
    expect(record.correlationId).toBe(REDACTED_SHAPE);
    expect(String(record.errorKind)).not.toContain("sk-proj-");
  });

  it("lets the envelope win over extra and lets extra fill a gap the envelope leaves", () => {
    const withEnvelope = JSON.parse(
      formatServerLogLine({
        category: "http",
        op: "request",
        status: 500,
        extra: { status: 200, durationMs: 17 },
      }),
    ) as Record<string, unknown>;
    expect(withEnvelope.status).toBe(500);
    expect(withEnvelope.durationMs).toBe(17);
  });

  it("drops a non-finite duration or status rather than writing null", () => {
    const record = JSON.parse(
      formatServerLogLine({
        category: "http",
        op: "request",
        durationMs: Number.NaN,
        status: Number.POSITIVE_INFINITY,
      }),
    ) as Record<string, unknown>;
    expect(record.durationMs).toBeUndefined();
    expect(record.status).toBeUndefined();
  });

  it("replaces a pathologically large line rather than writing it", () => {
    // The widest line the field guards themselves still allow: the maximum field count, each with
    // a long-but-legal name and a value that survives every value guard.
    const extra: Record<string, unknown> = {};
    for (let index = 0; index < MAX_LOG_FIELD_COUNT; index += 1) {
      extra[`field${String(index)}_${"n".repeat(48)}`] = "ab.".repeat(53);
    }
    const line = formatServerLogLine({ category: "indexing", op: "wide", extra });
    // Bytes, not UTF-16 code units. The replacement line is ASCII today so both counts agree, and
    // that is exactly why measuring the wrong one here would go unnoticed until a producer put
    // multi-byte text on the line the cap exists to bound.
    expect(serverLogLineBytes(line)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    expect(JSON.parse(line)).toMatchObject({ errorKind: "log-line-oversized" });
  });

  it("is a single line: the record always ends with exactly one newline", () => {
    const line = formatServerLogLine({ category: "http", op: "request" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toContain("\n");
  });

  // ADR-0173 D5 / g12: `parentCorrelationId` reuses `isValidCorrelationId`'s `SAFE_CORRELATION_ID`
  // shape guard rather than the generic string redaction `correlationId` gets, because it is
  // producer-suppliable like `correlationId` (not spoof-resistant) but is expected to always be a
  // correlation-id-shaped value — a malformed one is dropped outright, never written under a marker.
  it("writes a validly shaped parentCorrelationId straight through, like correlationId", () => {
    const record = JSON.parse(
      formatServerLogLine({
        category: "http",
        op: "job.spawned",
        correlationId: "job-123456",
        parentCorrelationId: "req-parent-789",
      }),
    ) as Record<string, unknown>;
    expect(record.parentCorrelationId).toBe("req-parent-789");
  });

  it("drops a parentCorrelationId that fails the SAFE_CORRELATION_ID shape guard", () => {
    const record = JSON.parse(
      formatServerLogLine({
        category: "http",
        op: "job.spawned",
        // Five characters: below SAFE_CORRELATION_ID's 8-character floor.
        parentCorrelationId: "short",
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain("parentCorrelationId");
  });
});

// Requirement 9. Nothing closed the descriptor the process-wide logger opened: `resetServerLogger`
// dropped the reference and the handle stayed open for the life of the process — and, in a test
// run, once more for every suite that touched the logger.
describe("server activity log descriptor lifecycle", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-lifecycle-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    // The process logger resolves its threshold from the environment, so without this the suite
    // asserts on lines a runner that exports KEIKO_LOG_LEVEL=warn would legitimately suppress.
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    // Start from a clean process-wide slot, then count only what this test does.
    resetServerLogger();
    fsCalls.open = 0;
    fsCalls.close = 0;
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("closes the descriptor the process logger opened, and stays usable after", () => {
    getServerLogger().info({ category: "diagnostic", op: "lifecycle.probe" });
    expect(fsCalls.open).toBe(1);
    expect(fsCalls.close).toBe(0);

    resetServerLogger();
    expect(fsCalls.close).toBe(1);

    // Closing releases an OS resource; it does not disable the log.
    getServerLogger().info({ category: "diagnostic", op: "lifecycle.after" });
    expect(readLines(stateDir).map((line) => line.op)).toStrictEqual([
      "lifecycle.probe",
      "lifecycle.after",
    ]);
  });
});

// Requirement 4. The sink is deliberately synchronous — see the module header for why a
// write-behind queue is the wrong shape for diagnosing a wedged process — so the cost has to be
// pinned rather than argued.
//
// It is pinned by COUNTING, not by timing. The property the module claims is structural: one
// descriptor for the life of the file, one `write(2)` per line, and not one byte of work for a
// line below the threshold. A wall-clock budget over 10,000 real filesystem writes measures the
// runner's disk and scheduler instead — it is exactly the "no wall-clock races in the suite" rule
// AGENTS.md states, and on a loaded CI lane it turns the required `ci` context red on a diff that
// never touched this file. Counters answer the same question deterministically, and answer it
// more precisely: a return to open/write/close per line moves `open` from 1 to N, and a quadratic
// format path shows up as a byte total that is not N x the line size.
describe("server activity log burst cost", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-burst-"));
    fsCalls.open = 0;
    fsCalls.write = 0;
    fsCalls.close = 0;
  });

  afterEach(() => {
    closeFileServerLogSinks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it(`holds one descriptor and issues one write per line across ${String(BURST_EVENT_COUNT)} events`, () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    const event: ServerLogEvent = {
      level: "info",
      category: "indexing",
      op: "indexing.document.batch",
      correlationId: "job-1f2e3d",
      durationMs: 12.5,
      extra: { batchIndex: 3, batchCount: 12, chunkCount: 36, vectorsPersistedForDocument: 24 },
    };
    for (let index = 0; index < BURST_EVENT_COUNT; index += 1) {
      sink.write(event);
    }

    // One open for the whole burst: an `appendFileSync`-style open/write/close per line would
    // make this BURST_EVENT_COUNT.
    expect(fsCalls.open).toBe(1);
    expect(fsCalls.close).toBe(0);
    // One `write(2)` per line. `writeAll` loops only on a short write, which a regular file does
    // not produce; a per-line open/write/close triple or a re-serialisation would exceed this.
    expect(fsCalls.write).toBe(BURST_EVENT_COUNT);

    sink.close?.();
    expect(fsCalls.close).toBe(1);

    // Linear output, not quadratic — but lines are no longer byte-identical now that the envelope
    // carries `seq`: its digit width grows at each power-of-ten boundary the burst crosses
    // (9 -> 10, 99 -> 100, 999 -> 1000), so the total is the SUM of each line's own width rather
    // than one width times the count. Summing through the production formatter itself — not
    // re-deriving its byte math here — is what keeps this pin honest: a future change to what the
    // identity envelope carries shows up here automatically, the same way the single-width version
    // did before `seq` existed.
    //
    // `seq` is process-wide (ADR-0173 D2), not scoped to this burst's own sink, so the first line
    // this burst wrote is NOT necessarily `1` — an earlier test in this file may already have
    // advanced the shared allocator. The starting point is read back off the actual first
    // persisted line instead of assumed, and the rest of the burst's numbers are derived from it:
    // the allocator is claimed once per write with nothing else writing to this sink concurrently,
    // so they are exactly consecutive.
    const lines = readLines(stateDir);
    const firstSeq = lines[0]?.seq as number;
    let expectedBytes = 0;
    for (let index = 0; index < BURST_EVENT_COUNT; index += 1) {
      expectedBytes += serverLogLineBytes(
        formatServerLogLine(event, undefined, {
          schemaVersion: SERVER_LOG_SCHEMA_VERSION,
          pid: process.pid,
          instanceId: serverLogInstanceId(),
          seq: firstSeq + index,
        }),
      );
    }
    expect(statSync(join(stateDir, "logs", "server.log")).size).toBe(expectedBytes);
    expect(lines).toHaveLength(BURST_EVENT_COUNT);
  });

  it(`does no work at all for ${String(BURST_EVENT_COUNT)} below-threshold events`, () => {
    const sink = createFileServerLogSink(stateDir, { level: "info" });
    let fieldReads = 0;
    const event: ServerLogEvent = {
      level: "debug",
      category: "indexing",
      op: "indexing.extract.window",
      get extra(): Record<string, unknown> {
        fieldReads += 1;
        throw new Error("the suppressed path must not read the fields");
      },
    };
    for (let index = 0; index < BURST_EVENT_COUNT; index += 1) {
      sink.write(event);
    }

    // The gate short-circuits before the event source is touched and before any syscall: the
    // getter that would have thrown was never reached, and not a byte was produced.
    expect(fieldReads).toBe(0);
    expect(fsCalls.open).toBe(0);
    expect(fsCalls.write).toBe(0);
    expect(existsSync(join(stateDir, "logs", "server.log"))).toBe(false);
  });
});

// The hard-link rotation exists to stop one process replacing another's finished archive. Its
// fallback to the destination-replacing rename must therefore be reachable ONLY where hard links
// genuinely do not exist — never on a permission or I/O failure, where the safe outcome is to keep
// appending rather than to overwrite a peer's day.
describe("rotation fallback is narrow", () => {
  // This block sits outside the file's shared hooks, so it owns its own cleanup. Without it the
  // fake clock, the forced link errno and the registered sinks leak into whatever suite is added
  // below — a failure for a reason unrelated to its own subject.
  afterEach(() => {
    fsCalls.linkErrorCode = null;
    closeFileServerLogSinks();
    vi.useRealTimers();
  });

  // The hard-link rotation exists so one process cannot replace another's finished archive. Its
  // fallback to the destination-replacing rename must be reachable ONLY where hard links genuinely
  // do not exist. On a permission or I/O failure the safe outcome is to keep appending: one file
  // growing is a nuisance, overwriting a peer's day is data loss.
  //
  // The discriminating observation is whether the ARCHIVE APPEARS. With the broad fallback an
  // EACCES link failure fell through to the guarded rename, which succeeds when no peer archive
  // exists yet and therefore creates the file. With the narrowing it is never attempted.
  function rotateAcrossBoundary(linkErrorCode: string): readonly string[] {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const dir = mkdtempSync(join(tmpdir(), "keiko-rot-"));
    const sink = createFileServerLogSink(dir, { level: "debug" });
    sink.write({ category: "indexing", op: "ours" });
    fsCalls.linkErrorCode = linkErrorCode;
    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    sink.write({ category: "indexing", op: "next-day" });
    fsCalls.linkErrorCode = null;
    const files = readdirSync(join(dir, "logs")).sort();
    sink.close?.();
    rmSync(dir, { recursive: true, force: true });
    return files;
  }

  it.each(["EACCES", "EMLINK", "EIO"])(
    "does not fall back to the replacing rename when link fails with %s",
    (code) => {
      expect(rotateAcrossBoundary(code)).toStrictEqual(["server.log"]);
    },
  );

  it("still rotates on a filesystem that genuinely has no hard links", () => {
    expect(rotateAcrossBoundary("EPERM")).toStrictEqual(["server-2026-08-20.log", "server.log"]);
  });
});

// ADR-0173 D11: `errorKindOf` delegates to `error-classification.ts`'s hardened reflection helpers
// (`safeProperty`/`machineToken`/`contentFreeErrorClass`) instead of a plain-cast regex reader with
// no try/catch of its own. `server-logger.test.ts` already pins the full code-first/name-fallback/
// unknown-floor contract this rewrite must reproduce exactly; this suite covers the ONE thing that
// contract could not exercise before the rewrite — a `code` accessor that THROWS on read, which the
// old plain-cast reader had no way to survive.
describe("errorKindOf (ADR-0173 D11 hardened reflection)", () => {
  it("degrades to the class instead of crashing when the `code` accessor throws", () => {
    const hostile = new Error("placeholder");
    Object.defineProperty(hostile, "code", {
      get(): never {
        throw new Error("hostile code accessor");
      },
    });
    expect(() => errorKindOf(hostile)).not.toThrow();
    expect(errorKindOf(hostile)).toBe("Error");
  });

  it("degrades to the class instead of crashing when the `code` property is a throwing proxy", () => {
    const hostile = new Proxy(new Error("placeholder"), {
      get(target, property, receiver): unknown {
        if (property === "code") throw new Error("hostile trap");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => errorKindOf(hostile)).not.toThrow();
    expect(errorKindOf(hostile)).toBe("Error");
  });

  // The rewrite's `instanceof Error` gate (added only to keep the `errorKindOf({})` floor below)
  // over-corrected: it also discarded a `code`/`name` carried by a THROWN VALUE THAT IS NOT AN
  // `Error` INSTANCE AT ALL — a plain object, which the pre-rewrite reader (any object, not only
  // `Error`) classified correctly. `code` still wins over `name` for a non-`Error` object, exactly
  // as it does for an `Error`.
  it("still reads `code`/`name` off a thrown value that is not an `Error` instance", () => {
    expect(errorKindOf({ code: "SQLITE_BUSY" })).toBe("SQLITE_BUSY");
    expect(errorKindOf({ code: "not an identifier", name: "TransportFailure" })).toBe(
      "TransportFailure",
    );
  });

  it("still floors a code-less, name-less non-`Error` object to `unknown`", () => {
    expect(errorKindOf({})).toBe("unknown");
    expect(errorKindOf({ irrelevant: true })).toBe("unknown");
  });
});
