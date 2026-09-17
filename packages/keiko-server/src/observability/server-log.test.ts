import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ActivityLogEventValidationError,
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";

import { MAX_LOG_FIELD_COUNT, REDACTED_KEY, REDACTED_SHAPE } from "./log-redaction.js";
import {
  MAX_LOG_LINE_BYTES,
  SERVER_LOG_LEVEL_ENV,
  SERVER_LOG_SCHEMA_VERSION,
  closeFileServerLogSinks,
  createBufferedServerLogSink,
  createFileServerLogSink,
  appendDurableServerLogBatch,
  errorKindOf,
  formatServerLogLine,
  formatRegisteredServerLogLine,
  reportServerLogFailure,
  resetServerLogFailureNotices,
  serverLogInstanceId,
  serverLogLineBytes,
  serverLogLineWithinCap,
} from "./server-log.js";
import type { ServerLogEvent, ServerLogIdentity } from "./server-log.js";
import { getServerLogger, resetServerLogger, shutdownServerLogging } from "./server-logger.js";

function testServerLogIdentity(seq = 1): ServerLogIdentity {
  const platform = new Set(["darwin", "linux", "win32"]).has(process.platform)
    ? process.platform
    : "other";
  const architecture = new Set(["arm64", "x64"]).has(process.arch) ? process.arch : "other";
  return {
    schemaVersion: SERVER_LOG_SCHEMA_VERSION,
    registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
    schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
    catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
    buildClass: "node-esm",
    releaseClass: KEIKO_PRODUCT_VERSION.includes("-") ? "prerelease" : "stable",
    platformClass: `${platform}-${architecture}`,
    productVersion: KEIKO_PRODUCT_VERSION,
    compatibilityState: "supported",
    writerCapability: "active",
    pid: process.pid,
    instanceId: serverLogInstanceId(),
    seq,
  };
}

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
// exercising real appends and real permissions.
const fsCalls = vi.hoisted(() => ({
  replaceAfterWrite: null as {
    readonly current: string;
    readonly op: string;
    readonly stale: string;
  } | null,
  open: 0,
  write: 0,
  close: 0,
  fsync: 0,
  failFsync: false,
  failOpenPath: null as string | null,
  failWriteOpOnce: null as string | null,
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
      if (String(args[0]) === fsCalls.failOpenPath) {
        throw Object.assign(new Error("forced open failure"), { code: "EIO" });
      }
      return actual.openSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>): number => {
      fsCalls.write += 1;
      const budget = fsCalls.writeBudgetBytes;
      const [fd, buffer, offset, length] = args as unknown as BufferWriteArgs;
      const writtenText = buffer.subarray(offset, offset + length).toString("utf8");
      if (
        fsCalls.failWriteOpOnce !== null &&
        writtenText.includes(`"op":"${fsCalls.failWriteOpOnce}"`)
      ) {
        fsCalls.failWriteOpOnce = null;
        return 0;
      }
      const allowed = budget === null ? length : Math.min(length, budget);
      if (budget !== null) fsCalls.writeBudgetBytes = budget - allowed;
      if (allowed === 0) return 0;
      const written = actual.writeSync(fd, buffer, offset, allowed);
      const replacement = fsCalls.replaceAfterWrite;
      const acceptedText = buffer.subarray(offset, offset + written).toString("utf8");
      if (replacement !== null && acceptedText.includes(`"op":"${replacement.op}"`)) {
        fsCalls.replaceAfterWrite = null;
        actual.renameSync(replacement.current, replacement.stale);
        actual.writeFileSync(replacement.current, "", { mode: 0o600 });
      }
      return written;
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>): void => {
      fsCalls.close += 1;
      actual.closeSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
      fsCalls.fsync += 1;
      if (fsCalls.failFsync)
        throw Object.assign(new Error("forced fsync failure"), { code: "EIO" });
      actual.fsyncSync(...args);
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

const FILESYSTEM_EVIDENCE_OPS: ReadonlySet<unknown> = new Set([
  "server-log.rotation",
  "server-log.safe-open",
]);

function readCallerLines(stateDir: string): Record<string, unknown>[] {
  return readLines(stateDir).filter((line) => !FILESYSTEM_EVIDENCE_OPS.has(line.op));
}

function readCallerRecords(stateDir: string): (Record<string, unknown> | null)[] {
  return readRawRecords(stateDir).filter(
    (record) => record === null || !FILESYSTEM_EVIDENCE_OPS.has(record.op),
  );
}

describe("server activity log", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-"));
    // Hermetic: the suite must not observe the developer's or the runner's own threshold.
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    fsCalls.writeBudgetBytes = null;
    fsCalls.replaceAfterWrite = null;
    fsCalls.fsync = 0;
    fsCalls.failFsync = false;
    fsCalls.failOpenPath = null;
    fsCalls.failWriteOpOnce = null;
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
    fsCalls.replaceAfterWrite = null;
    fsCalls.fsync = 0;
    fsCalls.failFsync = false;
    fsCalls.failOpenPath = null;
    fsCalls.failWriteOpOnce = null;
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("appends and fsyncs a durable batch through the existing active log", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "process", op: "before-batch" });
    const openCount = fsCalls.open;

    const result = appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: () => ({
        status: "append",
        events: [
          { category: "diagnostic", op: "batch-one" },
          { category: "diagnostic", op: "batch-complete" },
        ],
      }),
    });

    expect(result).toStrictEqual({ status: "appended", appendedCount: 2 });
    // Two additional opens pin the fixed state/log directory ancestors; one read-only descriptor
    // validates the current tail before inspection. The existing append descriptor is still reused.
    expect(fsCalls.open).toBe(openCount + 3);
    expect(fsCalls.fsync).toBe(1);
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "before-batch",
      "batch-one",
      "batch-complete",
    ]);
  });

  it("emits separate safe-open and deferred-rotation evidence for a durable batch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "process", op: "before-durable-boundary" });
    sink.close?.();

    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    const result = appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: () => ({
        status: "append",
        events: [
          {
            category: "diagnostic",
            op: "durable-after-boundary",
            extra: { domainStatus: "complete" },
          },
        ],
      }),
    });

    expect(result).toStrictEqual({ status: "appended", appendedCount: 1 });
    expect(readLines(stateDir).slice(-3)).toEqual([
      expect.objectContaining({
        op: "server-log.safe-open",
        correlationId: "unknown-correlation-id",
        persistenceStatus: "opened",
      }),
      expect.objectContaining({
        op: "server-log.rotation",
        correlationId: "unknown-correlation-id",
        persistenceStatus: "deferred",
        durabilityAssurance: "unchanged",
        retentionStatus: "deferred",
      }),
      expect.objectContaining({
        op: "durable-after-boundary",
        domainStatus: "complete",
      }),
    ]);
    expect(readLines(stateDir).at(-1)).not.toHaveProperty("persistenceStatus");
  });

  it("persists first-open evidence when a durable batch is already complete", () => {
    const result = appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: () => ({ status: "already-complete" }),
    });

    expect(result).toStrictEqual({ status: "already-complete" });
    expect(readLines(stateDir)).toEqual([
      expect.objectContaining({
        op: "server-log.safe-open",
        correlationId: "unknown-correlation-id",
        persistenceStatus: "opened",
        completeness: "complete",
        loss: "none",
      }),
    ]);
    expect(fsCalls.fsync).toBe(1);
  });

  it("persists boundary evidence before a durable inspection defers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "process", op: "before-deferred-inspection" });
    sink.close?.();

    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    const result = appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: () => ({ status: "deferred" }),
    });

    expect(result).toStrictEqual({ status: "inspection-deferred" });
    expect(readLines(stateDir).slice(-2)).toEqual([
      expect.objectContaining({
        op: "server-log.safe-open",
        correlationId: "unknown-correlation-id",
      }),
      expect.objectContaining({
        op: "server-log.rotation",
        correlationId: "unknown-correlation-id",
        persistenceStatus: "deferred",
        durabilityAssurance: "unchanged",
      }),
    ]);
    expect(fsCalls.fsync).toBe(1);
  });

  it("does not inspect or touch the log directory when a durable info batch is filtered", () => {
    const inspect = vi.fn(() => ({ status: "already-complete" as const }));

    expect(appendDurableServerLogBatch(stateDir, { level: "warn", inspect })).toStrictEqual({
      status: "deferred",
      reason: "level-filtered",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it("defers when the current log changes during durable batch inspection", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "process", op: "before-race" });

    const result = appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: (directory) => {
        appendFileSync(join(directory, "server.log"), "peer\n", "utf8");
        return {
          status: "append",
          events: [{ category: "diagnostic", op: "must-not-append" }],
        };
      },
    });

    expect(result).toStrictEqual({ status: "deferred", reason: "destination-mutated" });
    expect(readFileSync(join(stateDir, "logs", "server.log"), "utf8")).not.toContain(
      "must-not-append",
    );
  });

  it("reports uncertain durability and closes the active handle when batch fsync fails", () => {
    createFileServerLogSink(stateDir).write({ category: "process", op: "before-fsync-failure" });
    fsCalls.failFsync = true;

    expect(
      appendDurableServerLogBatch(stateDir, {
        level: "info",
        inspect: () => ({
          status: "append",
          events: [{ category: "diagnostic", op: "uncertain-batch" }],
        }),
      }),
    ).toStrictEqual({ status: "deferred", reason: "durability-uncertain" });
    expect(fsCalls.close).toBeGreaterThanOrEqual(3);
  });

  it("classifies a fresh safe-open evidence write failure before inspection", () => {
    fsCalls.writeBudgetBytes = 0;
    const inspect = vi.fn(() => ({ status: "already-complete" as const }));

    expect(appendDurableServerLogBatch(stateDir, { level: "info", inspect })).toStrictEqual({
      status: "deferred",
      reason: "append-failed",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("classifies fresh safe-open evidence with uncertain durability before inspection", () => {
    fsCalls.failFsync = true;
    const inspect = vi.fn(() => ({ status: "already-complete" as const }));

    expect(appendDurableServerLogBatch(stateDir, { level: "info", inspect })).toStrictEqual({
      status: "deferred",
      reason: "durability-uncertain",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("classifies a fresh safe-open pathname replacement before inspection", () => {
    const current = join(stateDir, "logs", "server.log");
    fsCalls.replaceAfterWrite = {
      current,
      stale: join(stateDir, "logs", "server-stale.log"),
      op: "server-log.safe-open",
    };
    const inspect = vi.fn(() => ({ status: "already-complete" as const }));

    expect(appendDurableServerLogBatch(stateDir, { level: "info", inspect })).toStrictEqual({
      status: "deferred",
      reason: "destination-mutated",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("terminates a partial record before a durable batch retry", () => {
    createFileServerLogSink(stateDir).write({ category: "process", op: "before-partial-batch" });
    fsCalls.writeBudgetBytes = 5;
    expect(
      appendDurableServerLogBatch(stateDir, {
        level: "info",
        inspect: () => ({
          status: "append",
          events: [{ category: "diagnostic", op: "interrupted-batch" }],
        }),
      }),
    ).toStrictEqual({ status: "deferred", reason: "append-failed" });

    fsCalls.writeBudgetBytes = null;
    expect(
      appendDurableServerLogBatch(stateDir, {
        level: "info",
        inspect: () => ({
          status: "append",
          events: [{ category: "diagnostic", op: "retry-batch" }],
        }),
      }),
    ).toStrictEqual({ status: "appended", appendedCount: 1 });
    const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("retry-batch");
  });

  it("terminates and syncs a partial current-file tail before fresh-process inspection", async () => {
    const logs = join(stateDir, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "server.log"), '{"interrupted":', "utf8");
    let inspected = false;
    vi.resetModules();
    const freshServerLog = await import("./server-log.js");

    try {
      const result = freshServerLog.appendDurableServerLogBatch(stateDir, {
        level: "info",
        inspect: (directory) => {
          inspected = true;
          const raw = readFileSync(join(directory, "server.log"), "utf8");
          expect(raw.startsWith('{"interrupted":\n')).toBe(true);
          expect(raw).toContain('"op":"server-log.safe-open"');
          return {
            status: "append",
            events: [{ category: "diagnostic", op: "fresh-process-retry" }],
          };
        },
      });

      expect(inspected).toBe(true);
      expect(result).toStrictEqual({ status: "appended", appendedCount: 1 });
      expect(readCallerRecords(stateDir)).toEqual([
        null,
        expect.objectContaining({ op: "fresh-process-retry" }),
      ]);
      expect(fsCalls.fsync).toBe(3);
    } finally {
      freshServerLog.closeFileServerLogSinks();
    }
  });

  it("does not inspect or truncate a partial tail when delimiter durability is uncertain", () => {
    const logs = join(stateDir, "logs");
    mkdirSync(logs);
    const interrupted = '{"interrupted":';
    writeFileSync(join(logs, "server.log"), interrupted, "utf8");
    fsCalls.failFsync = true;
    const inspect = vi.fn(() => ({ status: "already-complete" as const }));

    expect(appendDurableServerLogBatch(stateDir, { level: "info", inspect })).toStrictEqual({
      status: "deferred",
      reason: "destination-unsafe",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(readFileSync(join(logs, "server.log"), "utf8")).toBe(`${interrupted}\n`);
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

    const lines = readCallerLines(stateDir);
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

  it("emits separate body-free safe-open evidence and leaves the caller event unchanged", () => {
    createFileServerLogSink(stateDir).write({
      category: "http",
      op: "request",
      correlationId: "request-correlation-3528",
    });

    const lines = readLines(stateDir);
    expect(lines[0]).toMatchObject({
      category: "diagnostic",
      op: "server-log.safe-open",
      correlationId: "unknown-correlation-id",
      artifactClass: "activity-log",
      persistenceStatus: "opened",
      permissionAssurance: process.platform === "win32" ? "platform-inherited" : "verified-private",
      containmentAssurance:
        process.platform === "win32" ? "platform-inherited" : "private-root-guarded",
      completeness: "complete",
      loss: "none",
    });
    expect(lines[1]).toMatchObject({
      category: "http",
      op: "request",
      correlationId: "request-correlation-3528",
    });
    expect(lines[1]).not.toHaveProperty("artifactClass");
    expect(lines[1]).not.toHaveProperty("persistenceStatus");
    expect(JSON.stringify(lines[0])).not.toContain(stateDir);
  });

  // Envelope v2 (#2902): every line the file sink writes carries a process/sequence identity an
  // agent joins across the long-lived current file and any legacy archive. This is the functional
  // counterpart to the spoofing test below — it proves the real values actually land on disk, not
  // merely that a forged one is stripped.
  it("stamps registry, build, platform and writer identity on every file-sink line", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "one" });
    sink.write({ category: "http", op: "two" });
    const lines = readCallerLines(stateDir);

    expect(lines[0]).toMatchObject({
      schemaVersion: SERVER_LOG_SCHEMA_VERSION,
      registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
      schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
      catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
      buildClass: "node-esm",
      releaseClass: KEIKO_PRODUCT_VERSION.includes("-") ? "prerelease" : "stable",
      productVersion: KEIKO_PRODUCT_VERSION,
      compatibilityState: "supported",
      writerCapability: "active",
      pid: process.pid,
    });
    expect(String(lines[0]?.platformClass)).toMatch(
      /^(?:darwin|linux|win32|other)-(?:arm64|x64|other)$/u,
    );
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
  it("never lets extra spoof registry, runtime, writer or process identity", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({
      category: "http",
      op: "spoof-attempt",
      extra: {
        schemaVersion: 999,
        registryVersion: 999,
        schemaDigest: "0".repeat(64),
        catalogDigest: "0".repeat(64),
        buildClass: "hostile-build",
        releaseClass: "hostile-release",
        platformClass: "hostile-platform",
        productVersion: "999.999.999",
        compatibilityState: "corrupt",
        writerCapability: "unavailable",
        pid: -1,
        instanceId: "deadbeef",
        seq: 999_999,
        keep: 1,
      },
    });
    const lines = readCallerLines(stateDir);

    expect(lines[0]).toMatchObject({
      schemaVersion: SERVER_LOG_SCHEMA_VERSION,
      registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
      schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
      catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
      buildClass: "node-esm",
      productVersion: KEIKO_PRODUCT_VERSION,
      compatibilityState: "supported",
      writerCapability: "active",
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
    const before = readCallerRecords(stateDir)[0]?.seq as number;

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
    const records = readCallerRecords(stateDir);

    // Only the two writes that actually landed are on disk; the failed one never appears.
    expect(records.map((record) => record?.op)).toStrictEqual(["before-failure", "after-failure"]);
    // The failed event claimed `before + 1`; the separate safe-reopen event claims `before + 2`,
    // and the caller's next event follows it. Exactly the failed number stays absent.
    expect(records[1]?.seq).toBe(before + 3);
    expect(readRawRecords(stateDir).some((record) => record?.seq === before + 1)).toBe(false);
    expect(readRawRecords(stateDir)).toContainEqual(
      expect.objectContaining({ op: "server-log.safe-open", seq: before + 2 }),
    );
  });

  it("reserves the caller seq before an open failure and exposes the exact gap", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "http", op: "before-open-failure" });
    const before = readCallerLines(stateDir)[0]?.seq as number;
    sink.close?.();

    fsCalls.failOpenPath = join(stateDir, "logs", "server.log");
    sink.write({ category: "http", op: "open-failed-caller" });
    fsCalls.failOpenPath = null;
    sink.write({ category: "http", op: "after-open-recovery" });

    const records = readLines(stateDir);
    expect(readCallerLines(stateDir).map((record) => record.op)).toStrictEqual([
      "before-open-failure",
      "after-open-recovery",
    ]);
    expect(records.some((record) => record.seq === before + 1)).toBe(false);
    expect(records).toContainEqual(
      expect.objectContaining({ op: "server-log.safe-open", seq: before + 2 }),
    );
    expect(readCallerLines(stateDir)[1]?.seq).toBe(before + 3);
    const notice = stderr.mock.calls
      .map((call) => String(call[0]))
      .find((value) => value.includes('"failedOp":"open-failed-caller"'));
    expect(notice).toBeDefined();
    expect(JSON.parse(notice ?? "{}")).toMatchObject({
      op: "server-log.write-failed",
      failedOp: "open-failed-caller",
      errorKind: "open-failed",
      compatibilityState: "incomplete",
      writerCapability: "unavailable",
      completeness: "unknown",
      loss: "event-dropped",
    });
  });

  // Envelope v2 widens the category union to include process-lifecycle lines; this proves the sink
  // actually accepts and persists the new member rather than only the type system allowing it.
  it("accepts the process category alongside every existing one", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "process", op: "process.started" });
    expect(readCallerLines(stateDir)[0]).toMatchObject({
      category: "process",
      op: "process.started",
    });
  });

  it("stamps every line with a level, defaulting to info", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "request" });
    sink.write({ level: "error", category: "gateway", op: "transport-failed" });
    const lines = readCallerLines(stateDir);
    expect(lines[0]).toMatchObject({ level: "info" });
    expect(lines[1]).toMatchObject({ level: "error" });
  });

  it("fails closed when mandatory activity-log storage cannot be created", () => {
    // Point at a path that is a file, not a directory. A configured production logger cannot
    // silently claim reconstruction capability by falling back to a null writer.
    const filePath = join(stateDir, "not-a-dir");
    writeFileSync(filePath, "block");
    expect(() => createFileServerLogSink(filePath)).toThrow(
      "safe artifact activity-log failed: open-failed",
    );
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

  it("refuses symlinked, hard-linked, and non-regular current logs", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logsDir = join(stateDir, "logs");
    mkdirSync(logsDir);
    const victim = join(stateDir, "victim");
    writeFileSync(victim, "unchanged", { mode: 0o640 });
    chmodSync(victim, 0o640);

    for (const kind of ["symlink", "hard-link", "fifo"] as const) {
      const current = join(logsDir, "server.log");
      rmSync(current, { force: true });
      if (kind === "symlink") symlinkSync(victim, current);
      else if (kind === "hard-link") linkSync(victim, current);
      else execFileSync("mkfifo", [current]);
      const sink = createFileServerLogSink(stateDir);
      sink.write({
        category: "diagnostic",
        op: `unsafe-${kind}`,
        correlationId: "unsafe-log-test",
      });
      sink.close?.();
      expect(readFileSync(victim, "utf8")).toBe("unchanged");
      expect(statSync(victim).mode & 0o777).toBe(0o640);
    }

    expect(stderr).toHaveBeenCalled();
    const noticeText = stderr.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes('"failedOp":"unsafe-symlink"'));
    expect(noticeText).toBeDefined();
    expect(JSON.parse(noticeText ?? "{}")).toMatchObject({
      category: "diagnostic",
      op: "server-log.write-failed",
      failedOp: "unsafe-symlink",
      correlationId: "unsafe-log-test",
      errorKind: "unsafe-target",
      completeness: "unknown",
      loss: "event-dropped",
    });
    expect(noticeText).not.toContain(victim);
  });

  it("reopens the current path when a peer replaces it instead of appending to a stale inode", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "diagnostic", op: "before-peer-replace" });
    const logsDir = join(stateDir, "logs");
    const stale = join(logsDir, "server-stale.log");
    renameSync(join(logsDir, "server.log"), stale);
    writeFileSync(join(logsDir, "server.log"), `${JSON.stringify({ op: "peer" })}\n`, {
      mode: 0o600,
    });

    sink.write({ category: "diagnostic", op: "after-peer-replace" });

    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "peer",
      "after-peer-replace",
    ]);
    expect(readFileSync(stale, "utf8")).not.toContain("after-peer-replace");
  });

  it("reports an event location as unknown when a peer swaps the path after its write", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logsDir = join(stateDir, "logs");
    const current = join(logsDir, "server.log");
    const stale = join(logsDir, "server-stale.log");
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    fsCalls.replaceAfterWrite = { current, op: "post-write-swap", stale };

    sink.write({
      category: "diagnostic",
      op: "post-write-swap",
      correlationId: "post-write-race-3528",
    });

    expect(readFileSync(stale, "utf8")).toContain('"op":"post-write-swap"');
    expect(readFileSync(current, "utf8")).not.toContain('"op":"post-write-swap"');
    expect(readLines(stateDir)).toContainEqual(
      expect.objectContaining({
        op: "server-log.write-failed",
        failedOp: "post-write-swap",
        correlationId: "post-write-race-3528",
        errorKind: "target-mutated",
        completeness: "unknown",
        loss: "event-location-unknown",
      }),
    );
    const notice = JSON.parse(String(stderr.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(notice).toMatchObject({
      op: "server-log.write-failed",
      failedOp: "post-write-swap",
      correlationId: "post-write-race-3528",
      errorKind: "target-mutated",
      completeness: "unknown",
      loss: "event-location-unknown",
    });
  });

  it("tightens an existing current log to owner-only permissions before appending", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const logsDir = join(stateDir, "logs");
    mkdirSync(logsDir);
    const current = join(logsDir, "server.log");
    writeFileSync(current, "", { mode: 0o644 });
    chmodSync(current, 0o644);

    createFileServerLogSink(stateDir).write({ category: "diagnostic", op: "permission-hardened" });

    expect(statSync(current).mode & 0o777).toBe(0o600);
  });

  it("defers rotation and retention without mutating files at the day boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const logsDir = join(stateDir, "logs");
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "day1" });
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
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    sink.write({
      category: "http",
      op: "day2",
      correlationId: "rotation-deferred-3528",
    });

    const rolled = readdirSync(logsDir)
      .filter((name) => name.startsWith("server-"))
      .sort();
    expect(rolled).toStrictEqual([
      "server-2026-08-01.log",
      "server-2026-08-02.log",
      "server-2026-08-03.log",
      "server-2026-08-04.log",
      "server-2026-08-05.log",
      "server-2026-08-06.log",
      "server-2026-08-07.log",
      "server-2026-08-08.log",
    ]);
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(["day1", "day2"]);
    expect(readLines(stateDir)).toContainEqual(
      expect.objectContaining({
        op: "server-log.rotation",
        correlationId: "rotation-deferred-3528",
        errorKind: "publish-unsupported",
        persistenceStatus: "deferred",
        durabilityAssurance: "unchanged",
        rotationAssurance: "append-only-current",
        retentionStatus: "deferred",
        retentionReason: "segment-retention-owned-by-3530",
        completeness: "partial",
        loss: "none",
      }),
    );
    sink.close?.();
  });

  it("does not repeat deferred-rotation evidence when the caller write fails", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "indexing", op: "before-boundary-caller-failure" });

    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    fsCalls.failWriteOpOnce = "boundary-caller-fails";
    sink.write({ category: "indexing", op: "boundary-caller-fails" });
    sink.write({ category: "indexing", op: "boundary-caller-retry" });

    const records = readRawRecords(stateDir).filter(
      (record): record is Record<string, unknown> => record !== null,
    );
    expect(
      records.filter((line) => !FILESYSTEM_EVIDENCE_OPS.has(line.op)).map((line) => line.op),
    ).toStrictEqual(["before-boundary-caller-failure", "boundary-caller-retry"]);
    expect(records.filter((line) => line.op === "server-log.rotation")).toHaveLength(1);
  });

  it("keeps Windows logging active with explicit platform and deferred-rotation evidence", () => {
    stateDir = realpathSync(stateDir);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "indexing", op: "windows-day-20" });

    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    sink.write({
      category: "indexing",
      op: "windows-day-21",
      correlationId: "windows-rotation-3528",
    });

    expect(readdirSync(join(stateDir, "logs"))).toStrictEqual(["server.log"]);
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "windows-day-20",
      "windows-day-21",
    ]);
    expect(readLines(stateDir)).toContainEqual(
      expect.objectContaining({
        op: "server-log.rotation",
        correlationId: "windows-rotation-3528",
        errorKind: "publish-unsupported",
        persistenceStatus: "deferred",
        durabilityAssurance: "unchanged",
        retentionStatus: "deferred",
        completeness: "partial",
        loss: "none",
      }),
    );
    expect(readLines(stateDir)[0]).toMatchObject({
      op: "server-log.safe-open",
      persistenceStatus: "opened",
      permissionAssurance: "platform-inherited",
      containmentAssurance: "platform-inherited",
    });
  });

  // Regression for the retired path-based rotation: a peer may still move the current inode into a
  // legacy archive and install a new current file. The sink must reopen the pathname and must never
  // mutate the moved inode through its stale descriptor.
  it("reopens after peer replacement without mutating the legacy archive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const logsDir = join(stateDir, "logs");
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "indexing", op: "our-day-20" });

    // A peer process or operator moves the current inode and installs a fresh file. Our sink still
    // holds the descriptor for the moved inode until its pre-write identity check rejects it.
    renameSync(join(logsDir, "server.log"), join(logsDir, "server-2026-08-20.log"));
    writeFileSync(join(logsDir, "server.log"), `${JSON.stringify({ op: "peer-day-21" })}\n`, {
      mode: 0o600,
    });

    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    sink.write({ category: "indexing", op: "our-day-21" });

    // The legacy archive is untouched and contains only the bytes it held when it was moved.
    const archived = readFileSync(join(logsDir, "server-2026-08-20.log"), "utf8");
    expect(archived).toContain("our-day-20");
    expect(archived).not.toContain("peer-day-21");
    // And both processes' lines for the new day are in the new day's file.
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "peer-day-21",
      "our-day-21",
    ]);
    sink.close?.();
  });

  it("does not mutate an outside victim or advertised stage after a parent redirect", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "indexing", op: "before-parent-redirect" });
    const logsDir = join(stateDir, "logs");
    const parkedLogs = join(stateDir, "logs-parked");
    const outside = mkdtempSync(join(tmpdir(), "keiko-server-log-outside-"));
    const outsideVictim = join(outside, "server.log");
    const outsideStage = join(outside, `.keiko-server-rotation-${"a".repeat(32)}.stage`);
    writeFileSync(outsideVictim, "outside-victim", { mode: 0o640 });
    writeFileSync(outsideStage, "outside-stage", { mode: 0o640 });
    chmodSync(outsideVictim, 0o640);
    renameSync(logsDir, parkedLogs);
    symlinkSync(outside, logsDir);

    try {
      vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
      sink.write({ category: "indexing", op: "during-parent-redirect" });

      expect(readFileSync(outsideVictim, "utf8")).toBe("outside-victim");
      expect(readFileSync(outsideStage, "utf8")).toBe("outside-stage");
      expect(statSync(outsideVictim).mode & 0o777).toBe(0o640);
      expect(statSync(outsideStage).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(logsDir);
      renameSync(parkedLogs, logsDir);
      rmSync(outside, { recursive: true, force: true });
    }

    sink.write({ category: "indexing", op: "after-parent-restore" });
    expect(readCallerLines(stateDir).map((line) => line.op)).toContain("after-parent-restore");
    expect(readdirSync(logsDir)).toStrictEqual(["server.log"]);
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
    }
    sink.write({ category: "http", op: "second" });

    const records = readCallerRecords(stateDir);
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
        correlationId: "job-7-correlation",
      });
    } finally {
      fsCalls.writeBudgetBytes = null;
    }

    expect(stderr).toHaveBeenCalledTimes(1);
    const notice = JSON.parse(String(stderr.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(notice).toMatchObject({
      level: "error",
      category: "diagnostic",
      op: "server-log.write-failed",
      failedOp: "indexing.document.persisted",
      correlationId: "job-7-correlation",
      errorKind: "write-failed",
      compatibilityState: "incomplete",
      writerCapability: "unavailable",
      completeness: "unknown",
      loss: "event-dropped",
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
        correlationId: "job-42-correlation",
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const calls: readonly (readonly unknown[])[] = warn.mock.calls;
      expect(calls[0]?.[1]).toMatchObject({ code: "KEIKO_LOG_NOTICE_FAILED" });
      const options = calls[0]?.[1] as { detail?: string } | undefined;
      expect(options?.detail).toContain("job-42-correlation");
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
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      correlationId: "unknown-correlation-id",
      errorKind: "internal",
      compatibilityState: "incomplete",
      writerCapability: "unavailable",
      completeness: "unknown",
      loss: "event-dropped",
    });

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
      correlationId: "unknown-correlation-id",
      errorKind: "unknown",
      compatibilityState: "incomplete",
      writerCapability: "unavailable",
      completeness: "unknown",
      loss: "event-dropped",
      reason: "shutdown-flush",
      suppressedNotices: 1,
    });
  });

  it("reports a closed body-free registration rejection without recursing into the file sink", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    reportServerLogFailure(new ActivityLogEventValidationError("unknown-field"), {
      op: "hostile.operation.value",
      correlationId: "registration-rejection",
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    const raw = String(stderr.mock.calls[0]?.[0]);
    expect(JSON.parse(raw)).toMatchObject({
      op: "server-log.write-failed",
      correlationId: "registration-rejection",
      errorKind: "validation-failed",
      rejectionKind: "unknown-field",
      compatibilityState: "incomplete",
      writerCapability: "unavailable",
      completeness: "unknown",
      loss: "event-dropped",
    });
    expect(raw).not.toContain("hostile.operation.value");
  });

  it("closes the descriptor it holds and reopens on the next write", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "one" });
    sink.close?.();
    sink.write({ category: "http", op: "two" });
    expect(readCallerLines(stateDir)).toHaveLength(2);
  });

  it("shares one boundary state and emits one deferred warning across every sink", () => {
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

    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "before-midnight",
      "after-midnight-cli",
      "after-midnight-process",
    ]);
    expect(readLines(stateDir).filter((line) => line.op === "server-log.rotation")).toHaveLength(1);
    expect(readdirSync(join(stateDir, "logs"))).toStrictEqual(["server.log"]);
  });

  it("coalesces multi-day open failures into one warning on the recovery day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T23:59:00Z"));
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "indexing", op: "before-multi-day-failure" });
    sink.close?.();

    fsCalls.failOpenPath = join(stateDir, "logs", "server.log");
    vi.setSystemTime(new Date("2026-08-21T00:00:30Z"));
    sink.write({ category: "indexing", op: "lost-day-21" });
    vi.setSystemTime(new Date("2026-08-22T00:00:30Z"));
    sink.write({ category: "indexing", op: "lost-day-22" });
    fsCalls.failOpenPath = null;

    sink.write({ category: "indexing", op: "recovered-day-22" });
    sink.write({ category: "indexing", op: "same-recovery-day" });

    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "before-multi-day-failure",
      "recovered-day-22",
      "same-recovery-day",
    ]);
    expect(readLines(stateDir).filter((line) => line.op === "server-log.rotation")).toHaveLength(1);
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
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(["skipped", "breaker"]);
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
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(["kept"]);

    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    const verbose = createFileServerLogSink(stateDir);
    verbose.write({ level: "debug", category: "indexing", op: "now-kept" });
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(["kept", "now-kept"]);
  });
});

describe("server activity log line format", () => {
  it("rejects unregistered and post-construction-mutated typed events without serializing content", () => {
    expect(() =>
      formatRegisteredServerLogLine(
        { category: "diagnostic", op: "unknown.operation" },
        undefined,
        testServerLogIdentity(),
      ),
    ).toThrow(new ActivityLogEventValidationError("unregistered-operation"));

    const operation = defineActivityLogOperation({
      contractKind: "activity-log-operation",
      schemaVersion: 1,
      op: "registry.runtime.fixture",
      category: "diagnostic",
      owner: "keiko-server",
      emitter: "observability/server-log.test",
      fields: {
        status: {
          type: "string",
          dataClass: "closed-enum",
          required: true,
          values: ["ready"],
        },
      },
      causal: "correlation",
      lifecycle: "state",
      analyzerProjection: "timeline",
      failureClasses: ["registry-runtime-fixture"],
      proofIds: ["registry-runtime-fixture-line"],
      releaseImpact: "patch",
    });
    const event = activityLogEvent(
      operation,
      { correlationId: "registry-runtime-fixture" },
      { status: "ready" },
    );
    (event.extra as Record<string, unknown>).rawBody = "must-not-serialize";
    expect(() => formatRegisteredServerLogLine(event, undefined, testServerLogIdentity())).toThrow(
      new ActivityLogEventValidationError("unknown-field"),
    );
  });

  it("requires the generated registry identity and closed writer capability for typed events", () => {
    const operation = defineActivityLogOperation({
      contractKind: "activity-log-operation",
      schemaVersion: 1,
      op: "registry.identity.fixture",
      category: "diagnostic",
      owner: "keiko-server",
      emitter: "observability/server-log.test",
      fields: {},
      causal: "none",
      lifecycle: "state",
      analyzerProjection: "capability",
      failureClasses: ["registry-runtime-fixture"],
      proofIds: ["registry-runtime-identity"],
      releaseImpact: "patch",
    });
    const event = activityLogEvent(operation, {}, {});
    expect(() => formatRegisteredServerLogLine(event)).toThrow(
      new ActivityLogEventValidationError("missing-identity"),
    );
    expect(() =>
      formatRegisteredServerLogLine(event, undefined, {
        ...testServerLogIdentity(),
        writerCapability: "degraded",
      }),
    ).toThrow(new ActivityLogEventValidationError("invalid-identity"));
  });

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
    const guardedOpenCount = fsCalls.open;
    expect(guardedOpenCount).toBeGreaterThan(1);
    expect(fsCalls.close).toBe(guardedOpenCount - 1);

    resetServerLogger();
    expect(fsCalls.close).toBe(guardedOpenCount);

    // Closing releases an OS resource; it does not disable the log.
    getServerLogger().info({ category: "diagnostic", op: "lifecycle.after" });
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
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
// more precisely: a return to open/write/close per line moves `open` from the fixed boundary-safe
// setup cost to N, and a quadratic format path shows up as a byte total that is not N x the line
// size.
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
    sink.write(event);
    const guardedOpenCount = fsCalls.open;
    const closedGuardCount = fsCalls.close;
    for (let index = 1; index < BURST_EVENT_COUNT; index += 1) {
      sink.write(event);
    }

    // One retained file descriptor plus one-time ancestry guards. The exact guard count depends on
    // the absolute state-directory depth; an `appendFileSync`-style path would keep growing it.
    expect(guardedOpenCount).toBeGreaterThan(1);
    expect(fsCalls.open).toBe(guardedOpenCount);
    expect(fsCalls.close).toBe(closedGuardCount);
    // One `write(2)` per line: one separate safe-open record, then one per caller event.
    // `writeAll` loops only on a short write, which a regular file does not produce.
    expect(fsCalls.write).toBe(BURST_EVENT_COUNT + 1);

    sink.close?.();
    expect(fsCalls.close).toBe(closedGuardCount + 1);

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
    const callerLines = readCallerLines(stateDir);
    const firstSeq = callerLines[0]?.seq as number;
    let expectedBytes = serverLogLineBytes(`${JSON.stringify(lines[0])}\n`);
    for (let index = 0; index < BURST_EVENT_COUNT; index += 1) {
      expectedBytes += serverLogLineBytes(
        formatServerLogLine(event, undefined, testServerLogIdentity(firstSeq + index)),
      );
    }
    expect(statSync(join(stateDir, "logs", "server.log")).size).toBe(expectedBytes);
    expect(lines).toHaveLength(BURST_EVENT_COUNT + 1);
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
