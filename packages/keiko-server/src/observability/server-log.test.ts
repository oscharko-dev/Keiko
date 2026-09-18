import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ACTIVITY_LOG_STORE_POLICY_FILE_NAME,
  ActivityLogEventValidationError,
  activityLogEvent,
  activityLogLossCounters,
  activityLogSegmentFileName,
  defineActivityLogOperation,
  formatActivityLogSegmentId,
  parseActivityLogFileName,
  resetActivityLogLossCountersForTests,
  type ActivityLogSegmentIdentity,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";

import { MAX_LOG_FIELD_COUNT, REDACTED_KEY, REDACTED_SHAPE } from "./log-redaction.js";
import {
  ACTIVITY_LOG_STORAGE_OPERATIONS,
  MAX_LOG_LINE_BYTES,
  SERVER_LOG_LEVEL_ENV,
  SERVER_LOG_SCHEMA_VERSION,
  activityLogStorageHealth,
  closeFileServerLogSinks,
  createBufferedServerLogSink,
  createFileServerLogSink as createStrictFileServerLogSink,
  appendDurableServerLogBatch as appendStrictDurableServerLogBatch,
  errorKindOf,
  formatServerLogLine,
  formatRegisteredServerLogLine,
  listActivityLogFiles,
  pinActivityLogWindow,
  releaseActivityLogPin,
  reportServerLogFailure,
  resetServerLogFailureNotices,
  serverLogInstanceId,
  serverLogLineBytes,
  serverLogLineWithinCap,
  serverLogProcessIdentity,
} from "./server-log.js";
import type {
  ActivityLogFileInfo,
  ActivityLogPinResult,
  DurableServerLogBatchOptions,
  DurableServerLogBatchResult,
  FileServerLogSinkOptions,
  ServerLogEvent,
  ServerLogIdentity,
  ServerLogSink,
} from "./server-log.js";
import { getServerLogger, resetServerLogger, shutdownServerLogging } from "./server-logger.js";

// Derived from the producer (AGENTS.md section 7): a restated release or platform rule would stay
// green if production's rule moved and the copy did not.
function testServerLogIdentity(seq = 1): ServerLogIdentity {
  return { ...serverLogProcessIdentity(), seq };
}

function invalidServerLogIdentity(
  field: keyof ServerLogIdentity,
  value: unknown,
): ServerLogIdentity {
  const identity = { ...testServerLogIdentity() };
  Reflect.set(identity, field, value);
  return identity;
}

const TEST_EVENT_MARKER_PREFIX = "test-event:";
const TEST_FILE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "server-log.write-failed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.failureNoticeEvent",
  fields: {
    failedOp: { type: "string", dataClass: "opaque-id", required: false, maxLength: 160 },
    rejectionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "unregistered-operation",
        "registration-mismatch",
        "missing-identity",
        "invalid-identity",
        "fields-not-object",
        "missing-field",
        "unknown-field",
        "invalid-field-type",
        "invalid-field-bound",
        "invalid-field-vocabulary",
      ],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["shutdown-flush"],
    },
    suppressedNotices: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["activity-log-persistence", "activity-log-contract"],
  proofIds: ["server-log.write-failed.stderr-line"],
  releaseImpact: "patch",
});

function testEventMarker(event: ServerLogEvent): string {
  return `${TEST_EVENT_MARKER_PREFIX}${event.category}:${event.op}`.slice(0, 160);
}

function registeredTestEvent(event: ServerLogEvent): ServerLogEvent {
  const correlationId =
    event.correlationId !== undefined && /^[A-Za-z0-9._-]{8,128}$/u.test(event.correlationId)
      ? event.correlationId
      : "server-log-test-event";
  return activityLogEvent(
    TEST_FILE_OPERATION,
    {
      ...(event.level === undefined ? {} : { level: event.level }),
      correlationId,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.status === undefined ? {} : { status: event.status }),
      errorKind: "write-failed",
    },
    {
      failedOp: testEventMarker(event),
      completeness: "unknown",
      loss: "event-dropped",
    },
  );
}

function createFileServerLogSink(
  stateDir: string,
  options?: FileServerLogSinkOptions,
): ServerLogSink {
  const sink = createStrictFileServerLogSink(stateDir, options);
  const write = (event: ServerLogEvent): void => {
    sink.write(registeredTestEvent(event));
  };
  return sink.close === undefined
    ? { write }
    : {
        write,
        close: (): void => {
          sink.close?.();
        },
      };
}

function appendDurableServerLogBatch(
  stateDir: string,
  options: DurableServerLogBatchOptions,
): DurableServerLogBatchResult {
  return appendStrictDurableServerLogBatch(stateDir, {
    ...options,
    inspect(directory, files): ReturnType<DurableServerLogBatchOptions["inspect"]> {
      const inspection = options.inspect(directory, files);
      return inspection.status === "append"
        ? { ...inspection, events: inspection.events.map(registeredTestEvent) }
        : inspection;
    },
  });
}

function logicalTestRecord(record: Record<string, unknown>): Record<string, unknown> {
  const failedOp = record.failedOp;
  if (record.op !== "server-log.write-failed" || typeof failedOp !== "string") return record;
  if (!failedOp.startsWith(TEST_EVENT_MARKER_PREFIX)) return record;
  const marker = failedOp.slice(TEST_EVENT_MARKER_PREFIX.length);
  const separator = marker.indexOf(":");
  if (separator < 1) return record;
  return {
    ...record,
    category: marker.slice(0, separator),
    op: marker.slice(separator + 1),
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return logicalTestRecord(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return null;
  }
}

// Every physical line of the logical log, read through the writer's own ordered listing (the
// function under test) so no test restates the name grammar or the order.
function readActivityLogLines(stateDir: string): readonly string[] {
  return listActivityLogFiles(stateDir).flatMap((file) =>
    readFileSync(file.path, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  );
}

// Every physical line of the logical log, or `null` where the bytes are not a parseable record.
// Used by the short-write test, which is about exactly that distinction.
function readRawRecords(stateDir: string): (Record<string, unknown> | null)[] {
  return readActivityLogLines(stateDir).map(parseLine);
}

function readLines(stateDir: string): Record<string, unknown>[] {
  return readRawRecords(stateDir).filter(
    (record): record is Record<string, unknown> => record !== null,
  );
}

function fileRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Counters for the syscalls the sink's cost claim is actually about, plus the fault knobs the
// failure tests drive. The mock passes every call through to the real filesystem unless a knob is
// set, so every other test in this file keeps exercising real appends and real permissions.
const fsCalls = vi.hoisted(() => ({
  replaceAfterWrite: null as { readonly logsDir: string; readonly op: string } | null,
  open: 0,
  write: 0,
  close: 0,
  fsync: 0,
  failFsync: false,
  failOpenMatching: null as RegExp | null,
  failWriteOpOnce: null as string | null,
  failWriteCode: null as string | null,
  freeBytes: null as number | null,
  // `null` lists every Activity Log directory normally. A number fails exactly that ordinal listing of a
  // `logs` directory (1 = the next one) with EACCES, the error class `readdirSync` rethrows.
  failLogsListingCall: null as number | null,
  logsListings: 0,
  // `null` passes every write through untouched. A number is a byte budget: the descriptor accepts
  // that many more bytes and then reports 0, which is what a stalled descriptor reports and the
  // only way to produce a short write on a regular file.
  writeBudgetBytes: null as number | null,
}));

function resetFsKnobs(): void {
  fsCalls.writeBudgetBytes = null;
  fsCalls.replaceAfterWrite = null;
  fsCalls.fsync = 0;
  fsCalls.failFsync = false;
  fsCalls.failOpenMatching = null;
  fsCalls.failWriteOpOnce = null;
  fsCalls.failWriteCode = null;
  fsCalls.freeBytes = null;
  fsCalls.failLogsListingCall = null;
  fsCalls.logsListings = 0;
}

// The four-argument Buffer overload is the only one the module under test uses, and the only one
// the budget path has to understand. `Parameters<>` resolves to the string overload, so the
// forwarding path keeps it and the budget path names the shape it actually receives.
type BufferWriteArgs = readonly [fd: number, buffer: Buffer, offset: number, length: number];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // A peer swaps the active segment right after a matching write: the written inode moves to a
  // non-grammar name and an empty file takes the segment's name.
  const swapActiveSegment = (logsDir: string): void => {
    const name = actual.readdirSync(logsDir).find((entry) => entry.endsWith(".active.jsonl"));
    if (name === undefined) return;
    actual.renameSync(join(logsDir, name), join(logsDir, "peer-moved.jsonl"));
    actual.writeFileSync(join(logsDir, name), "", { mode: 0o600 });
  };
  const textOf = (buffer: Buffer, offset: number, length: number): string =>
    buffer.subarray(offset, offset + length).toString("utf8");
  const mentionsOp = (text: string, op: string): boolean =>
    text.includes(`"op":"${op}"`) || text.includes(`:${op}"`);
  const readdirSync = actual.readdirSync as (...args: readonly unknown[]) => unknown;
  return {
    ...actual,
    readdirSync: ((...args: readonly unknown[]): unknown => {
      if (fsCalls.failLogsListingCall !== null && /(?:^|[\\/])logs$/u.test(String(args[0]))) {
        fsCalls.logsListings += 1;
        if (fsCalls.logsListings === fsCalls.failLogsListingCall) {
          throw Object.assign(new Error("forced listing failure"), { code: "EACCES" });
        }
      }
      return readdirSync(...args);
    }) as typeof actual.readdirSync,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      fsCalls.open += 1;
      if (fsCalls.failOpenMatching?.test(String(args[0])) === true) {
        throw Object.assign(new Error("forced open failure"), { code: "EIO" });
      }
      return actual.openSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>): number => {
      fsCalls.write += 1;
      const [fd, buffer, offset, length] = args as unknown as BufferWriteArgs;
      if (fsCalls.failWriteCode !== null) {
        throw Object.assign(new Error("forced write failure"), { code: fsCalls.failWriteCode });
      }
      if (
        fsCalls.failWriteOpOnce !== null &&
        mentionsOp(textOf(buffer, offset, length), fsCalls.failWriteOpOnce)
      ) {
        fsCalls.failWriteOpOnce = null;
        return 0;
      }
      const budget = fsCalls.writeBudgetBytes;
      const allowed = budget === null ? length : Math.min(length, budget);
      if (budget !== null) fsCalls.writeBudgetBytes = budget - allowed;
      if (allowed === 0) return 0;
      const written = actual.writeSync(fd, buffer, offset, allowed);
      const replacement = fsCalls.replaceAfterWrite;
      if (replacement !== null && mentionsOp(textOf(buffer, offset, written), replacement.op)) {
        fsCalls.replaceAfterWrite = null;
        swapActiveSegment(replacement.logsDir);
      }
      return written;
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>): void => {
      fsCalls.close += 1;
      actual.closeSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
      fsCalls.fsync += 1;
      if (fsCalls.failFsync) {
        throw Object.assign(new Error("forced fsync failure"), { code: "EIO" });
      }
      actual.fsyncSync(...args);
    },
    statfsSync: (
      ...args: Parameters<typeof actual.statfsSync>
    ): ReturnType<typeof actual.statfsSync> => {
      const real = actual.statfsSync(...args);
      const free = fsCalls.freeBytes;
      if (free === null || typeof real.bavail === "bigint") return real;
      const numeric = real as import("node:fs").StatsFs;
      return {
        type: numeric.type,
        bsize: 1,
        blocks: numeric.blocks,
        bfree: free,
        bavail: free,
        files: numeric.files,
        ffree: numeric.ffree,
        frsize: numeric.frsize,
      };
    },
  };
});

const BURST_EVENT_COUNT = 2_000;

// Storage evidence the writer adds on its own, taken from the producer. Caller-facing assertions
// filter these out; the storage tests assert them explicitly.
const STORAGE_EVIDENCE_OPS: ReadonlySet<unknown> = ACTIVITY_LOG_STORAGE_OPERATIONS;

function readCallerLines(stateDir: string): Record<string, unknown>[] {
  return readLines(stateDir).filter((line) => !STORAGE_EVIDENCE_OPS.has(line.op));
}

function readCallerRecords(stateDir: string): (Record<string, unknown> | null)[] {
  return readRawRecords(stateDir).filter(
    (record) => record === null || !STORAGE_EVIDENCE_OPS.has(record.op),
  );
}

function linesWithOp(stateDir: string, op: string): Record<string, unknown>[] {
  return readLines(stateDir).filter((line) => line.op === op);
}

function segmentFiles(
  stateDir: string,
  kind?: ActivityLogFileInfo["kind"],
): readonly ActivityLogFileInfo[] {
  return listActivityLogFiles(stateDir).filter((file) => kind === undefined || file.kind === kind);
}

function logsDirectory(stateDir: string): string {
  return join(stateDir, "logs");
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

// A process id that certainly belonged to a process that has exited.
function exitedProcessId(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

// What recovery must report for a writer killed at an arbitrary instant: every complete line it
// left is still a whole record, and the tail and seal state follow from its last bytes.
function expectedKilledWriterRecovery(name: string, bytes: Buffer): Record<string, unknown> {
  const completeLines = bytes.toString("utf8").split("\n").slice(0, -1);
  for (const line of completeLines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  const truncated = bytes.at(-1) !== 0x0a;
  const sealWritten = (completeLines.at(-1) ?? "").includes('"op":"activity-log.segment.sealed"');
  const parsed = parseActivityLogFileName(name);
  return {
    recoveryStatus: "sealed",
    recoveryKind: sealWritten && !truncated ? "interrupted-seal" : "unsealed",
    ownerState: "exited",
    tailState: truncated ? "truncated" : "terminated",
    segmentBytes: bytes.length,
    recoveredInstanceId: parsed !== undefined && "instanceId" in parsed ? parsed.instanceId : "",
    loss: truncated ? "event-dropped" : "none",
  };
}

interface SeededSegment {
  readonly identity: ActivityLogSegmentIdentity;
  readonly state: "active" | "sealed";
  readonly content: string;
  readonly mtimeMs?: number;
}

function seedSegment(stateDir: string, segment: SeededSegment): string {
  const directory = logsDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, activityLogSegmentFileName(segment.identity, segment.state));
  writeFileSync(path, segment.content, { mode: 0o600 });
  chmodSync(path, segment.state === "sealed" ? 0o400 : 0o600);
  if (segment.mtimeMs !== undefined) {
    utimesSync(path, segment.mtimeMs / 1000, segment.mtimeMs / 1000);
  }
  return path;
}

function seedLegacyFile(stateDir: string, name: string, bytes: number, mtimeMs?: number): string {
  const directory = logsDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const line = `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", op: "legacy" })}\n`;
  writeFileSync(path, line.repeat(Math.max(1, Math.ceil(bytes / line.length))).slice(0, bytes), {
    mode: 0o600,
  });
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

function syntheticLines(bytes: number, seqStart = 1): string {
  let seq = seqStart;
  let text = "";
  while (Buffer.byteLength(text) < bytes) {
    text += `${JSON.stringify({ ts: "2026-09-18T00:00:00.000Z", seq, op: "seeded" })}\n`;
    seq += 1;
  }
  return text;
}

function storageEnv(overrides: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return { [SERVER_LOG_LEVEL_ENV]: "debug", ...overrides };
}

// Bytes the directory really occupies: each inode once (a seal briefly holds one inode under both
// its active and its sealed name), and a name that vanishes mid-scan simply no longer counts.
function directoryBytes(directory: string): number {
  const inodes = new Map<string, number>();
  for (const name of readdirSync(directory)) {
    try {
      const stat = lstatSync(join(directory, name));
      if (stat.isFile()) inodes.set(`${String(stat.dev)}:${String(stat.ino)}`, stat.size);
    } catch {
      // Sealed or pruned between the listing and the stat.
    }
  }
  return [...inodes.values()].reduce((total, size) => total + size, 0);
}

const serverLogDistModule = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/observability/server-log.js"),
).href;
const contractsDistModule = pathToFileURL(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../keiko-contracts/dist/observability.js",
  ),
).href;

// A forever writer that stops by itself exits with this code, so a test can tell it from a kill.
const WRITER_WORKER_STOPPED_ITSELF = 75;
// Longer than any test waits before it kills a forever writer on purpose (their timeouts are 60 s).
const WRITER_WORKER_LIFETIME_MS = 90_000;

// A real Keiko writer process built from dist: `count` events and a clean close, or `forever` until
// it is killed. Every event names its worker and index, so no line can be attributed to the wrong
// process. A forever writer whose test failed before killing it must not spin on: it stops by itself
// at the end of its lifetime, or as soon as the process that spawned it (`parentPid`) is gone. On
// #3554 ten writers from failed runs outlived their tests and held ten cores for two hours.
const WRITER_WORKER_SOURCE = `
const [moduleUrl, contractsUrl, stateDir, workerId, count, mode, pinMode, lifetimeMs, parentPid] =
  process.argv.slice(1);
const { createFileServerLogSink, pinActivityLogWindow } = await import(moduleUrl);
const { activityLogEvent, defineActivityLogOperation } = await import(contractsUrl);
const operation = defineActivityLogOperation(${JSON.stringify(TEST_FILE_OPERATION)});
const event = (index) => activityLogEvent(operation, {
  level: "error",
  correlationId: "worker-" + workerId + "-events",
  errorKind: "write-failed",
}, {
  failedOp: "worker." + workerId + "." + index + "." + "x".repeat(index % 7 * 11),
  completeness: "unknown",
  loss: "event-dropped",
});
const sink = createFileServerLogSink(stateDir, { level: "debug" });
if (mode === "forever") {
  const stopAtMs = Date.now() + Number(lifetimeMs);
  for (let index = 0; ; index += 1) {
    sink.write(event(index));
    if (index % 64 === 0 && (Date.now() > stopAtMs || process.ppid !== Number(parentPid))) {
      process.exit(${String(WRITER_WORKER_STOPPED_ITSELF)});
    }
  }
}
for (let index = 0; index < Number(count); index += 1) {
  sink.write(event(index));
  if (pinMode === "pin" && index === Math.floor(Number(count) / 2)) {
    const now = Date.now();
    pinActivityLogWindow(stateDir, {
      scope: { kind: "window", fromMs: now - 60_000, toMs: now + 60_000 },
      expiresAtMs: now + 3_600_000,
    });
  }
}
sink.close();
`;

interface WriterWorker {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  // Captured at spawn: a worker that finishes before the test awaits it must not be missed.
  readonly exit: Promise<number | null>;
}

interface WriterWorkerOptions {
  readonly count: number;
  readonly mode: "count" | "forever";
  readonly env: Readonly<Record<string, string>>;
  readonly pin?: boolean;
  readonly lifetimeMs?: number;
}

// Every writer a test spawned that has not exited yet. A test that fails or times out before its
// own kill leaves its writer here until killLiveWriterWorkers ends it.
const liveWriterWorkers = new Set<WriterWorker>();

async function killLiveWriterWorkers(): Promise<void> {
  const workers = [...liveWriterWorkers];
  for (const worker of workers) worker.child.kill("SIGKILL");
  await Promise.all(workers.map((worker) => worker.exit.catch(() => null)));
}

// A suite that spawns writers kills them first thing in its own afterEach, before it removes the
// directory they write to: Vitest skips the enclosing hooks once an inner one throws, and a removal
// racing a live writer does throw. This file-level hook is the backstop for any other suite.
afterEach(killLiveWriterWorkers);

// The worker's arguments without its trailing parent pid, which whoever spawns it appends.
function writerWorkerArgs(
  stateDir: string,
  workerId: number,
  options: WriterWorkerOptions,
): string[] {
  return [
    "--input-type=module",
    "-e",
    WRITER_WORKER_SOURCE,
    serverLogDistModule,
    contractsDistModule,
    stateDir,
    String(workerId),
    String(options.count),
    options.mode,
    options.pin === true ? "pin" : "none",
    String(options.lifetimeMs ?? WRITER_WORKER_LIFETIME_MS),
  ];
}

function startWriterWorker(
  stateDir: string,
  workerId: number,
  options: WriterWorkerOptions,
): WriterWorker {
  const child = spawn(
    process.execPath,
    [...writerWorkerArgs(stateDir, workerId, options), String(process.pid)],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...options.env } },
  );
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolveExit(code);
    });
  });
  const worker = { child, exit };
  liveWriterWorkers.add(worker);
  const forget = (): void => {
    liveWriterWorkers.delete(worker);
  };
  exit.then(forget, forget);
  return worker;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Spawns a forever writer through a short-lived relay process that exits at once, which leaves the
// writer exactly as a killed test runner leaves it: alive, with its parent gone. Resolves the pid.
const ORPHANING_RELAY_SOURCE = `
import { spawn } from "node:child_process";
const [command, ...args] = process.argv.slice(1);
const writer = spawn(command, [...args, String(process.pid)], { stdio: "ignore" });
writer.once("spawn", () => {
  process.stdout.write(String(writer.pid) + "\\n", () => process.exit(0));
});
`;

async function startOrphanedForeverWriter(stateDir: string): Promise<number> {
  const args = writerWorkerArgs(stateDir, 7, { count: 0, mode: "forever", env: {} });
  const relay = spawn(
    process.execPath,
    ["--input-type=module", "-e", ORPHANING_RELAY_SOURCE, process.execPath, ...args],
    { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...storageEnv({}) } },
  );
  let output = "";
  relay.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    relay.once("error", reject);
    relay.once("exit", resolveExit);
  });
  const pid = Number(output.trim());
  if (code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("the relay did not report its writer");
  }
  return pid;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

describe("server activity log", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-"));
    // Hermetic: the suite must not observe the developer's or the runner's own threshold.
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetFsKnobs();
    // The failure notice is throttled process-wide, so a test that asserts on it must start from a
    // slate no earlier test can have used up.
    resetServerLogFailureNotices();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    // The file sink is a process-wide singleton per log directory, so a suite that leaves one
    // registered leaves its segment open too.
    closeFileServerLogSinks();
    resetFsKnobs();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes one JSON line per event into this process's own active segment", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "request", status: 200, durationMs: 42 });
    sink.write({
      category: "embedding",
      op: "batch",
      status: 500,
      errorKind: "http-error",
      extra: { items: 36 },
    });

    const files = segmentFiles(stateDir);
    expect(files.map((file) => file.kind)).toStrictEqual(["active"]);
    expect(parseActivityLogFileName(files[0]?.name ?? "")).toMatchObject({
      kind: "active",
      pid: process.pid,
      instanceId: serverLogInstanceId(),
      index: 1,
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
      errorKind: "write-failed",
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
      correlationId: "request-correlation-3528",
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
  // agent joins across segments and any legacy file. This is the functional counterpart to the
  // spoofing test below — it proves the real values actually land on disk, not merely that a forged
  // one is stripped.
  it("stamps registry, build, platform and writer identity on every file-sink line", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "one" });
    sink.write({ category: "http", op: "two" });
    const lines = readCallerLines(stateDir);
    const first = lines[0];
    const second = lines[1];
    if (first === undefined || second === undefined) throw new Error("expected two log lines");

    expect(first).toMatchObject({
      schemaVersion: SERVER_LOG_SCHEMA_VERSION,
      registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
      schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
      catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
      buildClass: "node-esm",
      releaseClass: serverLogProcessIdentity().releaseClass,
      productVersion: KEIKO_PRODUCT_VERSION,
      compatibilityState: "supported",
      writerCapability: "active",
      pid: process.pid,
    });
    expect(String(first.platformClass)).toMatch(
      /^(?:darwin|linux|win32|other)-(?:arm64|x64|other)$/u,
    );
    expect(first.instanceId).toBe(serverLogInstanceId());
    expect(String(first.instanceId)).toMatch(/^[0-9a-f]{8}$/);
    // Monotonic PER PROCESS, not per file and not starting at a fixed value: the allocator is
    // shared by every store this process ever resolves, so an earlier test's sink may already have
    // claimed numbers below this one. Two lines written back to back by the SAME sink are exactly
    // one apart and carry the SAME instanceId/pid.
    if (typeof first.seq !== "number" || typeof second.seq !== "number") {
      throw new TypeError("expected numeric sequence values");
    }
    expect(second.seq).toBe(first.seq + 1);
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.pid).toBe(first.pid);
  });

  // The reserved-field defense-in-depth this envelope depends on: `RESERVED_FIELD_NAMES` in
  // `log-redaction.ts` strips a same-named `extra` key before the real identity is ever applied, so
  // a caller cannot make its own line look like a different process or sequence position.
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
    });
    expect(lines[0]?.instanceId).toBe(serverLogInstanceId());
    expect(lines[0]?.pid).not.toBe(-1);
    expect(lines[0]?.instanceId).not.toBe("deadbeef");
    expect(lines[0]?.seq).not.toBe(999_999);
    expect(typeof lines[0]?.seq).toBe("number");
    expect(lines[0]?.seq as number).toBeGreaterThan(0);
  });

  // ADR-0173 D2's join key is `(pid, instanceId, seq)`, promised unique PROCESS-WIDE — not merely
  // within one log directory. A per-directory counter would let two state directories in the same
  // process stamp an identical tuple on two unrelated lines.
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
      const combined = [...seqA, ...seqB];
      expect(new Set(combined).size).toBe(combined.length);
      expect(seqA[1]).toBeGreaterThan(seqA[0] ?? Number.POSITIVE_INFINITY);
      expect(seqB[1]).toBeGreaterThan(seqB[0] ?? Number.POSITIVE_INFINITY);
    } finally {
      rmSync(otherStateDir, { recursive: true, force: true });
    }
  });

  // The counter is claimed BEFORE the write is attempted, so a write that throws still consumes a
  // number that is never reused. The gap is the diagnosable outcome, and once writing resumes the
  // blocked backpressure is persisted with the exact number of events it cost.
  it("leaves a gap in seq for a write that throws and persists the backpressure once writing resumes", () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "http", op: "before-failure" });
    const before = readCallerRecords(stateDir)[0]?.seq as number;

    fsCalls.writeBudgetBytes = 0;
    try {
      sink.write({ category: "http", op: "dropped" });
    } finally {
      fsCalls.writeBudgetBytes = null;
    }
    sink.write({ category: "http", op: "after-failure" });

    const records = readCallerRecords(stateDir);
    expect(records.map((record) => record?.op)).toStrictEqual(["before-failure", "after-failure"]);
    expect(readRawRecords(stateDir).some((record) => record?.seq === before + 1)).toBe(false);
    expect(linesWithOp(stateDir, "activity-log.pressure")).toStrictEqual([
      expect.objectContaining({
        seq: before + 2,
        pressureState: "backpressure",
        droppedEventCount: 1,
        writerCapability: "degraded",
        errorKind: "write-failed",
        completeness: "partial",
        loss: "event-dropped",
      }),
    ]);
    expect(records[1]?.seq).toBe(before + 3);
  });

  it("reserves the caller seq before a segment open failure and exposes the exact gap", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "http", op: "before-open-failure" });
    const before = readCallerLines(stateDir)[0]?.seq as number;
    sink.close?.();

    fsCalls.failOpenMatching = /\.active\.jsonl$/u;
    sink.write({ category: "http", op: "open-failed-caller" });
    fsCalls.failOpenMatching = null;
    sink.write({ category: "http", op: "after-open-recovery" });

    const records = readLines(stateDir);
    expect(readCallerLines(stateDir).map((record) => record.op)).toStrictEqual([
      "before-open-failure",
      "after-open-recovery",
    ]);
    // before + 1 is the close's seal line; before + 2 is the caller that could not persist.
    expect(records).toContainEqual(
      expect.objectContaining({ op: "activity-log.segment.sealed", seq: before + 1 }),
    );
    expect(records.some((record) => record.seq === before + 2)).toBe(false);
    expect(records).toContainEqual(
      expect.objectContaining({ op: "server-log.safe-open", seq: before + 3 }),
    );
    expect(readCallerLines(stateDir)[1]?.seq).toBe(before + 4);
    const notice = stderr.mock.calls
      .map((call) => String(call[0]))
      .find((value) => value.includes('"failedOp":"server-log.write-failed"'));
    expect(JSON.parse(notice ?? "{}")).toMatchObject({
      op: "server-log.write-failed",
      failedOp: "server-log.write-failed",
      errorKind: "open-failed",
      compatibilityState: "incomplete",
      writerCapability: "unavailable",
      completeness: "unknown",
      loss: "event-dropped",
    });
  });

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
    rmSync(logsDirectory(stateDir), { recursive: true, force: true });
    expect(() => {
      sink.write({ category: "http", op: "after" });
      sink.write({ category: "http", op: "after-again" });
    }).not.toThrow();
  });

  it("abandons a replaced active segment instead of appending to a stale inode", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "diagnostic", op: "before-peer-replace" });
    const [active] = segmentFiles(stateDir, "active");
    if (active === undefined) throw new Error("expected an active segment");
    const stale = join(logsDirectory(stateDir), "peer-moved.jsonl");
    renameSync(active.path, stale);
    writeFileSync(active.path, `${JSON.stringify({ op: "peer" })}\n`, { mode: 0o600 });

    sink.write({ category: "diagnostic", op: "after-peer-replace" });

    expect(readFileSync(stale, "utf8")).not.toContain("after-peer-replace");
    // The file now at this process's old segment name is sealed as-is, never appended to.
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "peer",
      "after-peer-replace",
    ]);
    expect(linesWithOp(stateDir, "activity-log.segment.recovered")).toStrictEqual([
      expect.objectContaining({
        recoveryStatus: "sealed",
        recoveryKind: "unsealed",
        ownerState: "same-process",
        tailState: "terminated",
      }),
    ]);
    expect(segmentFiles(stateDir).map((file) => file.kind)).toStrictEqual(["sealed", "active"]);
  });

  it("reports an event location as unknown when a peer swaps the segment after its write", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "diagnostic", op: "warm-up" });
    fsCalls.replaceAfterWrite = { logsDir: logsDirectory(stateDir), op: "post-write-swap" };

    sink.write({
      category: "diagnostic",
      op: "post-write-swap",
      correlationId: "post-write-race-3528",
    });

    const moved = readFileSync(join(logsDirectory(stateDir), "peer-moved.jsonl"), "utf8");
    expect(moved).toContain(":post-write-swap");
    expect(readLines(stateDir)).toContainEqual(
      expect.objectContaining({
        op: "server-log.target-mutated",
        failedOp: "server-log.write-failed",
        correlationId: "post-write-race-3528",
        errorKind: "target-mutated",
        completeness: "unknown",
        loss: "event-location-unknown",
      }),
    );
    const notice = JSON.parse(String(stderr.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(notice).toMatchObject({
      op: "server-log.write-failed",
      failedOp: "server-log.write-failed",
      correlationId: "post-write-race-3528",
      errorKind: "target-mutated",
      completeness: "unknown",
      loss: "event-location-unknown",
    });
  });

  it("bounds a stalled write to the line that stalled instead of corrupting the next one", () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "http", op: "first" });
    // The descriptor takes 10 bytes of the next line and then reports 0 — a short write that never
    // completes. The bytes it accepted cannot be recalled.
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
    // The record written AFTER the stall is intact.
    expect(records[2]).toMatchObject({ op: "second" });
  });

  it("announces a write failure on stderr instead of dropping the line in silence", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
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
      failedOp: "server-log.write-failed",
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

  // Regression: when stderr itself cannot be written, the notice surfaces on the independent
  // `process.emitWarning` channel instead of vanishing into an empty catch.
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
  // the NEXT unthrottled failure; a shutdown must flush it rather than clear it.
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

  it("seals the segment on close and opens the next segment on the next write", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "one" });
    sink.close?.();
    sink.write({ category: "http", op: "two" });

    const files = segmentFiles(stateDir);
    expect(files.map((file) => file.kind)).toStrictEqual(["sealed", "active"]);
    expect(files.map((file) => parseActivityLogFileName(file.name))).toMatchObject([
      { index: 1 },
      { index: 2 },
    ]);
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(["one", "two"]);
    const sealed = files[0];
    if (sealed === undefined) throw new Error("expected a sealed segment");
    expect(modeOf(sealed.path) & 0o222).toBe(0);
    expect(fileRecords(sealed.path).at(-1)).toMatchObject({
      op: "activity-log.segment.sealed",
      sealReason: "close",
      segmentIndex: 1,
    });
  });

  it("shares one active segment and emits one seal across every sink on the directory", () => {
    // Two independent consumers, exactly as the CLI and the process logger ask for them.
    const cliSink = createFileServerLogSink(stateDir, { level: "debug" });
    const processSink = createFileServerLogSink(stateDir, { level: "debug" });
    cliSink.write({ category: "indexing", op: "from-cli" });
    processSink.write({ category: "indexing", op: "from-process" });
    cliSink.close?.();

    const files = segmentFiles(stateDir);
    expect(files.map((file) => file.kind)).toStrictEqual(["sealed"]);
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "from-cli",
      "from-process",
    ]);
    expect(linesWithOp(stateDir, "activity-log.segment.sealed")).toHaveLength(1);
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

  it("writes nothing at all — not even a segment — under a silent threshold", () => {
    const sink = createFileServerLogSink(stateDir, { level: "silent" });
    sink.write({ level: "error", category: "indexing", op: "breaker" });
    expect(listActivityLogFiles(stateDir)).toHaveLength(0);
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

    const event = registeredTestEvent({
      category: "diagnostic",
      op: "registry.runtime.fixture",
      correlationId: "registry-runtime-fixture",
    });
    (event.extra as Record<string, unknown>).rawBody = "must-not-serialize";
    expect(() => formatRegisteredServerLogLine(event, undefined, testServerLogIdentity())).toThrow(
      new ActivityLogEventValidationError("unknown-field"),
    );
  });

  it("requires the generated registry identity for typed events", () => {
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
        writerCapability: "unavailable",
      }),
    ).toThrow(new ActivityLogEventValidationError("invalid-identity"));

    const invalidIdentities: readonly (readonly [string, ServerLogIdentity])[] = [
      ["registry", invalidServerLogIdentity("registryVersion", 0)],
      ["digest", invalidServerLogIdentity("schemaDigest", "0".repeat(64))],
      ["build", invalidServerLogIdentity("buildClass", "browser")],
      ["product", invalidServerLogIdentity("productVersion", "0.0.0")],
      ["writer", invalidServerLogIdentity("writerCapability", "unavailable")],
      ["pid lower bound", invalidServerLogIdentity("pid", 0)],
      ["pid upper bound", invalidServerLogIdentity("pid", 2_147_483_648)],
      ["instance", invalidServerLogIdentity("instanceId", "not-hex")],
      ["sequence lower bound", invalidServerLogIdentity("seq", 0)],
      ["sequence safe-integer bound", invalidServerLogIdentity("seq", Number.MAX_SAFE_INTEGER + 1)],
    ];
    for (const [_predicate, identity] of invalidIdentities) {
      expect(() => formatRegisteredServerLogLine(event, undefined, identity)).toThrow(
        new ActivityLogEventValidationError("invalid-identity"),
      );
    }
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
    expect(serverLogLineBytes(line)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    expect(JSON.parse(line)).toMatchObject({
      category: "diagnostic",
      op: "server-log.line-dropped",
      errorKind: "write-failed",
      failedOp: "wide",
      completeness: "unknown",
      loss: "event-dropped",
    });
  });

  it("is a single line: the record always ends with exactly one newline", () => {
    const line = formatServerLogLine({ category: "http", op: "request" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toContain("\n");
  });

  // ADR-0173 D5 / g12: `parentCorrelationId` reuses `isValidCorrelationId`'s shape guard; a
  // malformed one is dropped outright, never written under a marker.
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
// dropped the reference and the handle stayed open for the life of the process.
describe("server activity log descriptor lifecycle", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-lifecycle-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    // The process logger resolves its threshold from the environment, so without this the suite
    // asserts on lines a runner that exports KEIKO_LOG_LEVEL=warn would legitimately suppress.
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetServerLogger();
    fsCalls.open = 0;
    fsCalls.close = 0;
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("seals the segment the process logger opened on reset, and stays usable after", () => {
    getServerLogger().info(registeredTestEvent({ category: "diagnostic", op: "lifecycle.probe" }));
    expect(segmentFiles(stateDir, "active")).toHaveLength(1);
    const closesBefore = fsCalls.close;

    resetServerLogger();
    // The segment descriptor is released and the segment sealed: nothing is left open.
    expect(fsCalls.close).toBeGreaterThan(closesBefore);
    expect(segmentFiles(stateDir, "active")).toHaveLength(0);

    // Closing releases an OS resource; it does not disable the log.
    getServerLogger().info(registeredTestEvent({ category: "diagnostic", op: "lifecycle.after" }));
    expect(
      readCallerLines(stateDir)
        .map((line) => line.op)
        .filter((op) => String(op).startsWith("lifecycle.")),
    ).toStrictEqual(["lifecycle.probe", "lifecycle.after"]);
  });
});

// Requirement 4. The sink is deliberately synchronous, so the cost has to be pinned rather than
// argued — by COUNTING, not by timing: one descriptor for the life of a segment, one `write(2)` per
// line, and not one byte of work for a line below the threshold.
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

    // One retained segment descriptor plus one-time ancestry guards when the segment opened; an
    // `appendFileSync`-style path would keep growing both counts.
    expect(guardedOpenCount).toBeGreaterThan(1);
    expect(fsCalls.open).toBe(guardedOpenCount);
    expect(fsCalls.close).toBe(closedGuardCount);
    // One `write(2)` per line: one exclusive-create for this process's first-ever store-policy
    // record (#3554, resolved lazily on this first passing-threshold write), one separate
    // safe-open record, then one per caller event.
    expect(fsCalls.write).toBe(BURST_EVENT_COUNT + 2);

    // Linear output, not quadratic, measured on the still-active segment: the SUM of each line's own
    // width, derived through the production formatter itself so a change to the identity envelope
    // shows up here automatically. `seq` is process-wide, so the burst's starting number is read
    // back off the first persisted caller line rather than assumed.
    const [active] = segmentFiles(stateDir, "active");
    if (active === undefined) throw new Error("expected one active segment");
    const lines = readLines(stateDir);
    const firstSeq = readCallerLines(stateDir)[0]?.seq as number;
    let expectedBytes = serverLogLineBytes(`${JSON.stringify(lines[0])}\n`);
    for (let index = 0; index < BURST_EVENT_COUNT; index += 1) {
      expectedBytes += serverLogLineBytes(
        formatServerLogLine(
          registeredTestEvent(event),
          undefined,
          testServerLogIdentity(firstSeq + index),
        ),
      );
    }
    expect(statSync(active.path).size).toBe(expectedBytes);
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

    // The gate short-circuits before the event source is touched and before any syscall.
    expect(fieldReads).toBe(0);
    expect(fsCalls.open).toBe(0);
    expect(fsCalls.write).toBe(0);
    expect(listActivityLogFiles(stateDir)).toHaveLength(0);
  });
});

// ADR-0173 D11: `errorKindOf` delegates to `error-classification.ts`'s hardened reflection helpers
// instead of a plain-cast reader with no try/catch of its own.
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

// #3530: the logical log is a sequence of bounded, immutable segments. These suites pin the seal
// triggers, crash recovery, the cross-process ownership rule, retention by bytes and age, the pin
// primitive and its quota, pressure evidence, and the read-only storage health report.
const SMALL_SEGMENT = 32 * 1024;
const SMALL_BUDGET = 128 * 1024;

// #3554: a forever writer must never outlive the test that started it, whether that test fails
// before its kill or the whole runner dies.
describe("activity log writer workers never outlive their test", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-worker-"));
  });

  afterEach(async () => {
    // First: a writer still running would recreate files while the directory is removed.
    await killLiveWriterWorkers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("stops a forever writer by itself at the end of its lifetime", async () => {
    const worker = startWriterWorker(stateDir, 5, {
      count: 0,
      mode: "forever",
      env: storageEnv({}),
      lifetimeMs: 200,
    });
    expect(await worker.exit).toBe(WRITER_WORKER_STOPPED_ITSELF);
  }, 30_000);

  it("stops a forever writer as soon as the process that spawned it is gone", async (ctx) => {
    // Windows keeps a dead parent's pid, so there only the lifetime bounds a writer.
    if (process.platform === "win32") ctx.skip();
    const pid = await startOrphanedForeverWriter(stateDir);
    const stopped = await waitFor(() => (processIsRunning(pid) ? undefined : true), 10_000).catch(
      () => false,
    );
    // Whatever the outcome, this test itself must not leave the writer running.
    if (processIsRunning(pid)) process.kill(pid, "SIGKILL");
    expect(stopped).toBe(true);
  }, 30_000);
});

describe("activity log segment lifecycle", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-segments-"));
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetFsKnobs();
    resetServerLogFailureNotices();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(async () => {
    // First: a writer still running would recreate files while the directory is removed.
    await killLiveWriterWorkers();
    closeFileServerLogSinks();
    resetFsKnobs();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rolls over by size: every sealed segment stays within the byte bound and ends with its seal line", () => {
    const env = storageEnv({ KEIKO_LOG_SEGMENT_BYTES: String(SMALL_SEGMENT) });
    const sink = createFileServerLogSink(stateDir, { env });
    for (let index = 0; index < 180; index += 1) {
      sink.write({ category: "indexing", op: `size.rollover.${String(index)}` });
    }

    const sealed = segmentFiles(stateDir, "sealed");
    expect(sealed.length).toBeGreaterThanOrEqual(2);
    for (const file of sealed) {
      expect(file.sizeBytes).toBeLessThanOrEqual(SMALL_SEGMENT);
      expect(modeOf(file.path) & 0o222).toBe(0);
      const records = fileRecords(file.path);
      const seal = records.at(-1);
      expect(records[0]).toMatchObject({ op: "server-log.safe-open" });
      expect(seal).toMatchObject({
        op: "activity-log.segment.sealed",
        sealReason: "size-limit",
        segmentFirstSeq: records[0]?.seq,
        segmentLastSeq: seal?.seq,
        segmentLineCount: records.length - 1,
        segmentBytes: file.sizeBytes - serverLogLineBytes(`${JSON.stringify(seal)}\n`),
        segmentByteLimit: SMALL_SEGMENT,
        droppedEventCount: 0,
        completeness: "complete",
        loss: "none",
      });
      expect(new Set(records.map((record) => record.instanceId))).toStrictEqual(
        new Set([serverLogInstanceId()]),
      );
    }
    // One strictly increasing sequence across every segment, and every caller line exactly once.
    const seqs = readLines(stateDir).map((line) => line.seq as number);
    expect(seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? 0))).toBe(true);
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(
      Array.from({ length: 180 }, (_, index) => `size.rollover.${String(index)}`),
    );
  });

  it("rolls over by age on the next write, and a clock step backwards seals too", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const env = storageEnv({ KEIKO_LOG_SEGMENT_SECONDS: "60" });
    const sink = createFileServerLogSink(stateDir, { env });
    sink.write({ category: "indexing", op: "age.first" });
    vi.setSystemTime(new Date("2026-09-18T10:01:01Z"));
    sink.write({ category: "indexing", op: "age.second" });
    vi.setSystemTime(new Date("2026-09-18T09:00:00Z"));
    sink.write({ category: "indexing", op: "clock.third" });

    const seals = linesWithOp(stateDir, "activity-log.segment.sealed");
    expect(seals.map((seal) => seal.sealReason)).toStrictEqual(["age-limit", "clock-change"]);
    expect(seals[0]).toMatchObject({ segmentSecondsLimit: 60, segmentIndex: 1 });
    // The third segment's name never sorts before its predecessors although the clock stepped back.
    const names = segmentFiles(stateDir).map((file) => parseActivityLogFileName(file.name));
    expect(
      names.map((name) => (name !== undefined && "index" in name ? name.index : 0)),
    ).toStrictEqual([1, 2, 3]);
  });

  it("seals an idle segment from its own timer so no active segment outlives its window", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const env = storageEnv({ KEIKO_LOG_SEGMENT_SECONDS: "4" });
    const sink = createFileServerLogSink(stateDir, { env });
    sink.write({ category: "indexing", op: "idle.only" });
    expect(segmentFiles(stateDir, "active")).toHaveLength(1);

    vi.advanceTimersByTime(5_000);

    expect(segmentFiles(stateDir, "active")).toHaveLength(0);
    expect(linesWithOp(stateDir, "activity-log.segment.sealed")).toStrictEqual([
      expect.objectContaining({ sealReason: "age-limit", correlationId: "unknown-correlation-id" }),
    ]);
  });

  it("keeps every process's lines in its own segments across concurrent writers", async () => {
    const env = storageEnv({
      KEIKO_LOG_SEGMENT_BYTES: String(SMALL_SEGMENT),
      KEIKO_LOG_RETENTION_BYTES: String(64 * 1024 * 1024),
    });
    const workers = [1, 2, 3].map((id) =>
      startWriterWorker(stateDir, id, { count: 120, mode: "count", env }),
    );
    const codes = await Promise.all(workers.map((worker) => worker.exit));
    expect(codes).toStrictEqual([0, 0, 0]);

    const files = segmentFiles(stateDir);
    expect(files.every((file) => file.kind === "sealed")).toBe(true);
    const seen = new Map<string, number[]>();
    for (const file of files) {
      const name = parseActivityLogFileName(file.name);
      const records = fileRecords(file.path);
      // No process ever appended to another process's segment.
      expect(
        new Set(records.map((record) => `${String(record.pid)}:${String(record.instanceId)}`)),
      ).toStrictEqual(
        new Set([
          name !== undefined && "pid" in name ? `${String(name.pid)}:${name.instanceId}` : "",
        ]),
      );
      for (const record of records) {
        const marker = /^worker\.(\d+)\.(\d+)\./u.exec(String(record.failedOp));
        if (marker === null) continue;
        const list = seen.get(marker[1] ?? "") ?? [];
        list.push(Number(marker[2]));
        seen.set(marker[1] ?? "", list);
      }
    }
    for (const id of ["1", "2", "3"]) {
      expect(seen.get(id)).toStrictEqual(Array.from({ length: 120 }, (_, index) => index));
    }
  }, 60_000);

  it("recovers a SIGKILLed writer's segment byte-for-byte and reports how it ended", async () => {
    const env = storageEnv({ KEIKO_LOG_SEGMENT_BYTES: String(1024 * 1024) });
    const worker = startWriterWorker(stateDir, 9, { count: 0, mode: "forever", env });
    const workerPid = worker.child.pid ?? 0;
    await waitFor(() =>
      segmentFiles(stateDir, "active").find(
        (file) => file.name.includes(`-${String(workerPid)}-`) && file.sizeBytes > 4_096,
      ),
    );
    worker.child.kill("SIGKILL");
    await worker.exit;
    const orphan = segmentFiles(stateDir, "active").find((file) =>
      file.name.includes(`-${String(workerPid)}-`),
    );
    if (orphan === undefined) throw new Error("the killed writer left no active segment");
    const bytes = readFileSync(orphan.path);

    createFileServerLogSink(stateDir, { env }).write({ category: "process", op: "after-crash" });

    const sealedPath = orphan.path.replace(/\.active\.jsonl$/u, ".jsonl");
    expect(existsSync(orphan.path)).toBe(false);
    expect(readFileSync(sealedPath).equals(bytes)).toBe(true);
    expect(modeOf(sealedPath) & 0o222).toBe(0);
    expect(linesWithOp(stateDir, "activity-log.segment.recovered")).toStrictEqual([
      expect.objectContaining(expectedKilledWriterRecovery(orphan.name, bytes)),
    ]);
  }, 60_000);

  it("seals a dead writer's orphan as-is and reports exactly its truncated tail", () => {
    const deadPid = exitedProcessId();
    const identity = {
      startMs: Date.now() - 1_000,
      pid: deadPid,
      instanceId: "0badc0de",
      index: 3,
    };
    const complete = syntheticLines(600);
    const fragment = '{"ts":"2026-09-18T00:00:00.000Z","seq":99,"op":"torn';
    const orphanPath = seedSegment(stateDir, {
      identity,
      state: "active",
      content: `${complete}${fragment}`,
    });

    createFileServerLogSink(stateDir).write({ category: "process", op: "recovery.trigger" });

    const sealedPath = join(
      logsDirectory(stateDir),
      activityLogSegmentFileName(identity, "sealed"),
    );
    expect(existsSync(orphanPath)).toBe(false);
    expect(readFileSync(sealedPath, "utf8")).toBe(`${complete}${fragment}`);
    expect(linesWithOp(stateDir, "activity-log.segment.recovered")).toStrictEqual([
      expect.objectContaining({
        level: "warn",
        recoveryStatus: "sealed",
        recoveryKind: "unsealed",
        ownerState: "exited",
        tailState: "truncated",
        truncatedBytes: Buffer.byteLength(fragment),
        segmentBytes: Buffer.byteLength(`${complete}${fragment}`),
        segmentIndex: 3,
        recoveredInstanceId: "0badc0de",
        completeness: "unknown",
        loss: "event-dropped",
      }),
    ]);
    expect(activityLogStorageHealth(stateDir).recoveredSegments).toBe(1);
  });

  it("finishes a seal interrupted between its link and its unlink without touching the content", () => {
    const identity = {
      startMs: Date.now() - 1_000,
      pid: exitedProcessId(),
      instanceId: "5ea1ed00",
      index: 1,
    };
    const sealLine = `${JSON.stringify({ ts: "2026-09-18T00:00:00.000Z", seq: 7, op: "activity-log.segment.sealed" })}\n`;
    const activePath = seedSegment(stateDir, {
      identity,
      state: "active",
      content: `${syntheticLines(300)}${sealLine}`,
    });
    const sealedPath = join(
      logsDirectory(stateDir),
      activityLogSegmentFileName(identity, "sealed"),
    );
    linkSync(activePath, sealedPath);

    createFileServerLogSink(stateDir).write({ category: "process", op: "recovery.trigger" });

    expect(existsSync(activePath)).toBe(false);
    expect(lstatSync(sealedPath).nlink).toBe(1);
    expect(linesWithOp(stateDir, "activity-log.segment.recovered")).toStrictEqual([
      expect.objectContaining({
        recoveryStatus: "sealed",
        recoveryKind: "interrupted-seal",
        tailState: "terminated",
        completeness: "complete",
        loss: "none",
      }),
    ]);
  });

  it("never takes over a live writer's fresh segment, but recovers one stale past two windows", () => {
    const livePid = process.ppid;
    const fresh = { startMs: Date.now(), pid: livePid, instanceId: "11111111", index: 1 };
    const stale = {
      startMs: Date.now() - 3 * 3_600_000,
      pid: livePid,
      instanceId: "22222222",
      index: 1,
    };
    const freshPath = seedSegment(stateDir, {
      identity: fresh,
      state: "active",
      content: syntheticLines(200),
    });
    seedSegment(stateDir, {
      identity: stale,
      state: "active",
      content: syntheticLines(200),
      mtimeMs: Date.now() - 2 * 3_600_000,
    });

    createFileServerLogSink(stateDir).write({ category: "process", op: "recovery.trigger" });

    expect(existsSync(freshPath)).toBe(true);
    expect(linesWithOp(stateDir, "activity-log.segment.recovered")).toStrictEqual([
      expect.objectContaining({ ownerState: "stale", recoveredInstanceId: "22222222" }),
    ]);
  });
});

describe("activity log retention", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-retention-"));
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetFsKnobs();
    resetServerLogFailureNotices();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetFsKnobs();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const retentionEnv = storageEnv({ KEIKO_LOG_RETENTION_BYTES: String(SMALL_BUDGET) });

  it("prunes the oldest files first until the byte budget holds the new segment's reservation", () => {
    const archive = seedLegacyFile(stateDir, "server-2026-09-01.log", 40 * 1024);
    const legacyCurrent = seedLegacyFile(stateDir, "server.log", 20 * 1024);
    const older = seedSegment(stateDir, {
      identity: {
        startMs: Date.now() - 60_000,
        pid: exitedProcessId(),
        instanceId: "aaaaaaaa",
        index: 1,
      },
      state: "sealed",
      content: syntheticLines(30 * 1024),
    });
    const newer = seedSegment(stateDir, {
      identity: {
        startMs: Date.now() - 30_000,
        pid: exitedProcessId(),
        instanceId: "bbbbbbbb",
        index: 1,
      },
      state: "sealed",
      content: syntheticLines(20 * 1024),
    });

    createFileServerLogSink(stateDir, { env: retentionEnv }).write({
      category: "http",
      op: "after",
    });

    // 110 KiB seeded + one 32 KiB reservation exceeds 128 KiB: only the oldest file has to go.
    expect(existsSync(archive)).toBe(false);
    expect([legacyCurrent, older, newer].every((path) => existsSync(path))).toBe(true);
    expect(linesWithOp(stateDir, "activity-log.retention.pruned")).toStrictEqual([
      expect.objectContaining({
        retentionStatus: "pruned",
        prunedLegacyFileCount: 1,
        prunedSegmentCount: 0,
        prunedBytes: 40 * 1024,
        prunedByBudgetCount: 1,
        prunedByAgeCount: 0,
        failedDeletionCount: 0,
        retentionBudgetBytes: SMALL_BUDGET,
        retentionDays: 14,
        completeness: "complete",
        loss: "none",
      }),
    ]);
    expect(directoryBytes(logsDirectory(stateDir))).toBeLessThanOrEqual(SMALL_BUDGET);
  });

  it("prunes by age even when the byte budget has room", () => {
    const now = Date.now();
    const aged = seedSegment(stateDir, {
      identity: {
        startMs: now - 21 * 86_400_000,
        pid: exitedProcessId(),
        instanceId: "cccccccc",
        index: 1,
      },
      state: "sealed",
      content: syntheticLines(1_024),
      mtimeMs: now - 20 * 86_400_000,
    });
    const agedLegacy = seedLegacyFile(
      stateDir,
      "server-2026-08-01.log",
      1_024,
      now - 30 * 86_400_000,
    );
    const recent = seedSegment(stateDir, {
      identity: { startMs: now - 60_000, pid: exitedProcessId(), instanceId: "dddddddd", index: 1 },
      state: "sealed",
      content: syntheticLines(1_024),
    });

    createFileServerLogSink(stateDir).write({ category: "http", op: "after" });

    expect(existsSync(aged)).toBe(false);
    expect(existsSync(agedLegacy)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(linesWithOp(stateDir, "activity-log.retention.pruned")).toStrictEqual([
      expect.objectContaining({ prunedByAgeCount: 2, prunedByBudgetCount: 0, retentionDays: 14 }),
    ]);
  });

  it("reads legacy files as part of the logical log and never rewrites them", () => {
    const archive = seedLegacyFile(stateDir, "server-2026-09-10.log", 512);
    const current = seedLegacyFile(stateDir, "server.log", 512);
    const archiveBefore = readFileSync(archive);
    const currentBefore = readFileSync(current);
    const currentMtime = statSync(current).mtimeMs;

    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "after-upgrade" });
    sink.close?.();

    expect(readFileSync(archive).equals(archiveBefore)).toBe(true);
    expect(readFileSync(current).equals(currentBefore)).toBe(true);
    expect(statSync(current).mtimeMs).toBe(currentMtime);
    expect(listActivityLogFiles(stateDir).map((file) => file.kind)).toStrictEqual([
      "legacy-archive",
      "legacy-current",
      "sealed",
    ]);
    expect(
      readLines(stateDir)
        .map((line) => line.op)
        .slice(0, 2),
    ).toStrictEqual(["legacy", "legacy"]);
  });

  it("tightens a non-private legacy archive before retention deletes it", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const archive = seedLegacyFile(
      stateDir,
      "server-2026-08-02.log",
      512,
      Date.now() - 30 * 86_400_000,
    );
    chmodSync(archive, 0o644);

    createFileServerLogSink(stateDir).write({ category: "http", op: "after" });

    expect(existsSync(archive)).toBe(false);
    expect(linesWithOp(stateDir, "activity-log.retention.pruned")[0]).toMatchObject({
      prunedLegacyFileCount: 1,
      failedDeletionCount: 0,
    });
  });

  it("never deletes through a symlink or hard link planted at a grammar name", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const outside = mkdtempSync(join(tmpdir(), "keiko-activity-victim-"));
    try {
      const victim = join(outside, "victim.jsonl");
      writeFileSync(victim, "outside", { mode: 0o600 });
      mkdirSync(logsDirectory(stateDir), { recursive: true, mode: 0o700 });
      const old = Date.now() - 40 * 86_400_000;
      const symlinkName = activityLogSegmentFileName(
        { startMs: old, pid: 4_242, instanceId: "eeeeeeee", index: 1 },
        "sealed",
      );
      symlinkSync(victim, join(logsDirectory(stateDir), symlinkName));
      const hardlink = join(logsDirectory(stateDir), "server-2026-07-01.log");
      linkSync(victim, hardlink);
      utimesSync(hardlink, old / 1000, old / 1000);

      createFileServerLogSink(stateDir).write({ category: "http", op: "after" });

      expect(readFileSync(victim, "utf8")).toBe("outside");
      expect(existsSync(hardlink)).toBe(true);
      expect(linesWithOp(stateDir, "activity-log.retention.pruned")).toStrictEqual([
        expect.objectContaining({ retentionStatus: "failed", failedDeletionCount: 1 }),
      ]);
      expect(linesWithOp(stateDir, "activity-log.pressure")).toContainEqual(
        expect.objectContaining({
          pressureState: "retention-blocked",
          errorKind: "durability-failed",
        }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("drops events rather than exceed the budget, and reports the exact loss when room returns", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const outside = mkdtempSync(join(tmpdir(), "keiko-activity-budget-"));
    try {
      const blocker = join(outside, "blocker.log");
      writeFileSync(blocker, "x".repeat(SMALL_BUDGET), { mode: 0o600 });
      mkdirSync(logsDirectory(stateDir), { recursive: true, mode: 0o700 });
      // A hard link counts as Activity Log bytes but can never be deleted by the store.
      const planted = join(logsDirectory(stateDir), "server-2026-09-01.log");
      linkSync(blocker, planted);
      const sink = createFileServerLogSink(stateDir, { env: retentionEnv });
      sink.write({ category: "http", op: "blocked-one" });
      sink.write({ category: "http", op: "blocked-two" });
      expect(segmentFiles(stateDir).filter((file) => file.kind === "active")).toHaveLength(0);

      rmSync(planted);
      vi.setSystemTime(new Date("2026-09-18T10:00:05Z"));
      sink.write({ category: "http", op: "resumed" });

      expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(["resumed"]);
      expect(linesWithOp(stateDir, "activity-log.pressure")).toContainEqual(
        expect.objectContaining({
          pressureState: "budget-exceeded",
          droppedEventCount: 2,
          writerCapability: "degraded",
          errorKind: "unavailable",
          loss: "event-dropped",
        }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // PR #3554 review: a deletion that failed once was skipped for the life of the process while its
  // bytes kept counting, so one transient failure could deny every later segment.
  it("retries a deletion that failed transiently instead of wedging the writer", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const outside = mkdtempSync(join(tmpdir(), "keiko-activity-transient-"));
    try {
      const external = join(outside, "external-link.log");
      writeFileSync(external, "x".repeat(SMALL_BUDGET), { mode: 0o600 });
      mkdirSync(logsDirectory(stateDir), { recursive: true, mode: 0o700 });
      const archive = join(logsDirectory(stateDir), "server-2026-09-01.log");
      // Undeletable while a second link exists; an ordinary private file once it is gone.
      linkSync(external, archive);
      const sink = createFileServerLogSink(stateDir, { env: retentionEnv });
      sink.write({ category: "http", op: "while-blocked" });
      expect(readCallerLines(stateDir)).toHaveLength(0);

      rmSync(external);
      vi.setSystemTime(new Date("2026-09-18T10:01:01Z"));
      sink.write({ category: "http", op: "after-retry" });

      expect(existsSync(archive)).toBe(false);
      expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual(["after-retry"]);
      expect(linesWithOp(stateDir, "activity-log.retention.pruned")).toContainEqual(
        expect.objectContaining({ retentionStatus: "pruned", prunedLegacyFileCount: 1 }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // PR #3554 review, same class at the recovery layer: a failed recovery was never retried, so the
  // orphan stayed active and reserved against the budget for the life of the process.
  it("retries a recovery that failed transiently and evidences the first failure only once", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const outside = mkdtempSync(join(tmpdir(), "keiko-activity-orphan-"));
    try {
      const identity = {
        startMs: Date.now() - 1_000,
        pid: exitedProcessId(),
        instanceId: "7e7e7e7e",
        index: 1,
      };
      const orphan = seedSegment(stateDir, {
        identity,
        state: "active",
        content: syntheticLines(400),
      });
      const external = join(outside, "external-link.jsonl");
      linkSync(orphan, external);
      const sink = createFileServerLogSink(stateDir);
      sink.write({ category: "http", op: "first-pass" });
      sink.close?.();
      sink.write({ category: "http", op: "inside-backoff" });
      sink.close?.();
      expect(existsSync(orphan)).toBe(true);

      rmSync(external);
      vi.setSystemTime(new Date("2026-09-18T10:01:01Z"));
      sink.write({ category: "http", op: "after-backoff" });

      expect(existsSync(orphan)).toBe(false);
      expect(
        linesWithOp(stateDir, "activity-log.segment.recovered").map((line) => line.recoveryStatus),
      ).toStrictEqual(["failed", "sealed"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports a full disk once writing resumes, with the exact number of dropped events", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "before-full" });
    fsCalls.failWriteCode = "ENOSPC";
    for (let index = 0; index < 3; index += 1) sink.write({ category: "http", op: "while-full" });
    fsCalls.failWriteCode = null;
    sink.write({ category: "http", op: "after-full" });

    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "before-full",
      "after-full",
    ]);
    expect(linesWithOp(stateDir, "activity-log.pressure")).toStrictEqual([
      expect.objectContaining({
        pressureState: "disk-full",
        droppedEventCount: 3,
        writerCapability: "degraded",
        errorKind: "write-failed",
        completeness: "partial",
        loss: "event-dropped",
      }),
    ]);
    sink.close?.();
    expect(linesWithOp(stateDir, "activity-log.segment.sealed").at(-1)).toMatchObject({
      droppedEventCount: 3,
      completeness: "partial",
      loss: "event-dropped",
    });
  });

  it("reports low disk space on entry and once more when it clears", () => {
    fsCalls.freeBytes = 1_024;
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "low" });
    sink.close?.();
    fsCalls.freeBytes = null;
    sink.write({ category: "http", op: "cleared" });

    expect(linesWithOp(stateDir, "activity-log.pressure")).toStrictEqual([
      expect.objectContaining({
        pressureState: "low-disk-space",
        freeBytes: 1_024,
        droppedEventCount: 0,
      }),
      expect.objectContaining({ pressureState: "cleared", previousState: "low-disk-space" }),
    ]);
  });

  it("refuses to list, recover, or prune through a redirected log directory", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "indexing", op: "before-redirect" });
    const logs = logsDirectory(stateDir);
    const parked = join(stateDir, "logs-parked");
    const outside = mkdtempSync(join(tmpdir(), "keiko-activity-outside-"));
    const decoy = join(
      outside,
      activityLogSegmentFileName(
        {
          startMs: Date.now() - 40 * 86_400_000,
          pid: exitedProcessId(),
          instanceId: "dec0dec0",
          index: 1,
        },
        "active",
      ),
    );
    writeFileSync(decoy, "outside-decoy", { mode: 0o600 });
    utimesSync(decoy, (Date.now() - 40 * 86_400_000) / 1000, (Date.now() - 40 * 86_400_000) / 1000);
    renameSync(logs, parked);
    symlinkSync(outside, logs);

    try {
      sink.write({ category: "indexing", op: "during-redirect" });
      sink.close?.();
      expect(readdirSync(outside)).toStrictEqual([basenameOf(decoy)]);
      expect(readFileSync(decoy, "utf8")).toBe("outside-decoy");
    } finally {
      rmSync(logs);
      renameSync(parked, logs);
      rmSync(outside, { recursive: true, force: true });
    }

    sink.write({ category: "indexing", op: "after-restore" });
    expect(readCallerLines(stateDir).map((line) => line.op)).toContain("after-restore");
  });

  it("keeps Windows logging active with platform-inherited assurance and a completed seal", () => {
    stateDir = realpathSync(stateDir);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    sink.write({ category: "indexing", op: "windows-line" });
    sink.close?.();

    expect(segmentFiles(stateDir).map((file) => file.kind)).toStrictEqual(["sealed"]);
    expect(readLines(stateDir)[0]).toMatchObject({
      op: "server-log.safe-open",
      permissionAssurance: "platform-inherited",
      containmentAssurance: "platform-inherited",
    });
    expect(readLines(stateDir).at(-1)).toMatchObject({
      op: "activity-log.segment.sealed",
      sealReason: "close",
    });
  });
});

function basenameOf(path: string): string {
  return path.slice(dirname(path).length + 1);
}

function writeSegments(
  stateDir: string,
  env: Readonly<Record<string, string>>,
  count: number,
): void {
  const sink = createFileServerLogSink(stateDir, { env });
  for (let segment = 0; segment < count; segment += 1) {
    for (let line = 0; line < 12; line += 1) {
      sink.write({ category: "indexing", op: `pinned.${String(segment)}.${String(line)}` });
    }
    sink.close?.();
  }
}

function ageFiles(files: readonly ActivityLogFileInfo[], days: number): void {
  const when = (Date.now() - days * 86_400_000) / 1000;
  for (const file of files) utimesSync(file.path, when, when);
}

describe("activity log retention pins", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-pins-"));
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetFsKnobs();
    resetServerLogFailureNotices();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(async () => {
    // First: a writer still running would recreate files while the directory is removed.
    await killLiveWriterWorkers();
    closeFileServerLogSinks();
    resetFsKnobs();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("protects a pinned window from age retention, including segments sealed later inside it", () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const env = storageEnv({});
    // A control segment that ended well before the window: it ages out like any other.
    const outside = seedSegment(stateDir, {
      identity: {
        startMs: start - 5 * 3_600_000,
        pid: exitedProcessId(),
        instanceId: "0c0c0c0c",
        index: 1,
      },
      state: "sealed",
      content: syntheticLines(512),
      mtimeMs: start - 4 * 3_600_000,
    });
    writeSegments(stateDir, env, 2);
    const result = pinActivityLogWindow(
      stateDir,
      {
        scope: { kind: "window", fromMs: start - 3_600_000, toMs: start + 3_600_000 },
        expiresAtMs: start + 60 * 86_400_000,
        correlationId: "incident-pin-3530",
      },
      env,
    );
    expect(result).toMatchObject({
      status: "pinned",
      pinnedSegmentCount: 2,
      quotaStatus: "within-quota",
    });
    writeSegments(stateDir, env, 1);
    const pinned = segmentFiles(stateDir, "sealed").filter((file) => file.path !== outside);
    expect(pinned.length).toBeGreaterThanOrEqual(3);

    // Thirty days later every one of them is far past the 14-day age bound.
    vi.setSystemTime(start + 30 * 86_400_000);
    createFileServerLogSink(stateDir, { env }).write({ category: "http", op: "retention.pass" });

    expect(existsSync(outside)).toBe(false);
    for (const file of pinned) expect(existsSync(file.path)).toBe(true);
    expect(linesWithOp(stateDir, "activity-log.pin.created")).toContainEqual(
      expect.objectContaining({
        correlationId: "incident-pin-3530",
        pinStatus: "created",
        pinKind: "window",
        pinReason: "incident",
        pinnedSegmentCount: 2,
        windowSeconds: 7_200,
        quotaStatus: "within-quota",
        completeness: "complete",
      }),
    );
    expect(activityLogStorageHealth(stateDir, env).pinnedBytes).toBe(
      pinned.reduce((total, file) => total + file.sizeBytes, 0),
    );
  });

  it("reports quota exhaustion exactly once with exact segment counts and sequence span", () => {
    const env = storageEnv({ KEIKO_LOG_PIN_QUOTA_BYTES: String(12 * 1024) });
    writeSegments(stateDir, env, 3);
    const sealed = segmentFiles(stateDir, "sealed");
    const spans = sealed.map((file) => {
      const records = fileRecords(file.path);
      return (records.at(-1)?.seq as number) - (records[0]?.seq as number) + 1;
    });
    const now = Date.now();
    pinActivityLogWindow(
      stateDir,
      {
        scope: { kind: "window", fromMs: now - 3_600_000, toMs: now + 60_000 },
        expiresAtMs: now + 86_400_000,
      },
      env,
    );
    // Several more maintenance passes while the quota stays exhausted.
    const sink = createFileServerLogSink(stateDir, { env });
    for (let pass = 0; pass < 3; pass += 1) {
      sink.write({ category: "http", op: `pass.${String(pass)}` });
      sink.close?.();
    }

    const markers = linesWithOp(stateDir, "activity-log.pin.quota-exhausted");
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    const unprotectedCount = marker?.unprotectedSegmentCount as number;
    expect(marker).toMatchObject({
      level: "error",
      errorKind: "unavailable",
      pinQuotaBytes: 12 * 1024,
      activePinCount: 1,
      unknownSpanSegmentCount: 0,
      completeness: "partial",
      loss: "event-dropped",
    });
    expect((marker?.protectedSegmentCount as number) + unprotectedCount).toBe(sealed.length);
    expect(marker?.protectedPinnedBytes as number).toBeLessThanOrEqual(12 * 1024);
    expect(marker?.unprotectedSeqSpan as number).toBeGreaterThanOrEqual(
      Math.min(...spans) * Math.max(0, unprotectedCount - 1),
    );
  });

  it("expires a pin, releases its segments, and removes an unreadable pin record", () => {
    const env = storageEnv({});
    writeSegments(stateDir, env, 1);
    const [segment] = segmentFiles(stateDir, "sealed");
    if (segment === undefined) throw new Error("expected one sealed segment");
    const segmentName = parseActivityLogFileName(segment.name);
    const segmentId =
      segmentName !== undefined && "segmentId" in segmentName ? segmentName.segmentId : "";
    const logs = logsDirectory(stateDir);
    const expired = "0123456789abcdef01234567";
    writeFileSync(
      join(logs, `pin-${expired}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        pinId: expired,
        reason: "incident",
        createdAtMs: Date.now() - 7_200_000,
        expiresAtMs: Date.now() - 3_600_000,
        scope: { kind: "segments", segmentIds: [segmentId] },
      })}\n`,
      { mode: 0o600 },
    );
    const garbage = "fedcba9876543210fedcba98";
    writeFileSync(join(logs, `pin-${garbage}.json`), "not json", { mode: 0o600 });

    createFileServerLogSink(stateDir, { env }).write({ category: "http", op: "expiry.pass" });

    expect(existsSync(join(logs, `pin-${expired}.json`))).toBe(false);
    expect(existsSync(join(logs, `pin-${garbage}.json`))).toBe(false);
    expect(linesWithOp(stateDir, "activity-log.pin.expired")).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pinId: expired,
          expiryReason: "expired",
          removalStatus: "removed",
          releasedSegmentCount: 1,
          releasedBytes: segment.sizeBytes,
        }),
        expect.objectContaining({
          pinId: garbage,
          expiryReason: "invalid-record",
          removalStatus: "removed",
          releasedSegmentCount: 0,
        }),
      ]),
    );
  });

  it("rejects an unbounded or malformed pin request with closed evidence", () => {
    const now = Date.now();
    const cases = [
      {
        scope: { kind: "window", fromMs: now, toMs: now + 8 * 86_400_000 },
        expiresAtMs: now + 60_000,
      },
      { scope: { kind: "window", fromMs: now, toMs: now + 1 }, expiresAtMs: now - 1 },
      { scope: { kind: "segments", segmentIds: ["../escape"] }, expiresAtMs: now + 60_000 },
    ] as const;
    for (const request of cases) {
      expect(
        pinActivityLogWindow(
          stateDir,
          request as unknown as Parameters<typeof pinActivityLogWindow>[1],
        ),
      ).toStrictEqual({
        status: "rejected",
        reason: "invalid-request",
      });
    }
    expect(linesWithOp(stateDir, "activity-log.pin.created")).toHaveLength(3);
    expect(linesWithOp(stateDir, "activity-log.pin.created")[0]).toMatchObject({
      pinStatus: "rejected",
      rejectionReason: "invalid-request",
      errorKind: "invalid-request",
      completeness: "partial",
    });
    expect(readdirSync(logsDirectory(stateDir)).some((name) => name.startsWith("pin-"))).toBe(
      false,
    );
  });

  it("refuses a pin beyond the bounded number of pin records", () => {
    const logs = logsDirectory(stateDir);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (let index = 0; index < 64; index += 1) {
      const pinId = index.toString(16).padStart(24, "0");
      writeFileSync(
        join(logs, `pin-${pinId}.json`),
        `${JSON.stringify({
          schemaVersion: 1,
          pinId,
          reason: "incident",
          createdAtMs: now - 1_000,
          expiresAtMs: now + 3_600_000,
          scope: { kind: "window", fromMs: now - 1_000, toMs: now },
        })}\n`,
        { mode: 0o600 },
      );
    }
    expect(
      pinActivityLogWindow(stateDir, {
        scope: { kind: "window", fromMs: now - 1_000, toMs: now },
        expiresAtMs: now + 60_000,
      }),
    ).toStrictEqual({ status: "rejected", reason: "pin-limit-reached" });
    expect(linesWithOp(stateDir, "activity-log.pin.created")[0]).toMatchObject({
      pinStatus: "rejected",
      rejectionReason: "pin-limit-reached",
      errorKind: "rate-limited",
    });
  });

  it("keeps total disk use within budget plus pin quota across concurrent writers and a crash", async () => {
    const budget = 256 * 1024;
    const quota = 64 * 1024;
    const env = storageEnv({
      KEIKO_LOG_RETENTION_BYTES: String(budget),
      KEIKO_LOG_PIN_QUOTA_BYTES: String(quota),
    });
    const logs = logsDirectory(stateDir);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, directoryBytes(logs));
    }, 5);
    try {
      const writers = [1, 2, 3].map((id) =>
        startWriterWorker(stateDir, id, { count: 700, mode: "count", env, pin: id === 2 }),
      );
      const crasher = startWriterWorker(stateDir, 4, { count: 0, mode: "forever", env });
      const crasherPid = crasher.child.pid ?? 0;
      await waitFor(() =>
        segmentFiles(stateDir, "active").find(
          (file) => file.name.includes(`-${String(crasherPid)}-`) && file.sizeBytes > 4_096,
        ),
      );
      crasher.child.kill("SIGKILL");
      const codes = await Promise.all(writers.map((writer) => writer.exit));
      await crasher.exit;
      expect(codes).toStrictEqual([0, 0, 0]);
      createFileServerLogSink(stateDir, { env }).write({ category: "http", op: "final.pass" });
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, directoryBytes(logs));
    expect(peak).toBeLessThanOrEqual(budget + quota);
    // The crashed writer's segment was recovered by someone: no exited writer's segment is left active.
    const remaining = segmentFiles(stateDir, "active").map((file) =>
      parseActivityLogFileName(file.name),
    );
    expect(
      remaining.every((name) => name !== undefined && "pid" in name && name.pid === process.pid),
    ).toBe(true);
  }, 120_000);
});

// #3554 (PR #3554 review comment 4050604711): several cooperating processes writing the same
// directory must share ONE governing retention/pin-quota policy — not each enforce its own env —
// and a disagreement must be detected and reported, never silently mask a budget overrun.
describe("activity log store policy", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-store-policy-"));
    resetFsKnobs();
  });

  afterEach(async () => {
    // First: a writer still running would recreate files while the directory is removed.
    await killLiveWriterWorkers();
    closeFileServerLogSinks();
    resetFsKnobs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function policyRecord(): Record<string, unknown> | undefined {
    const path = join(logsDirectory(stateDir), ACTIVITY_LOG_STORE_POLICY_FILE_NAME);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
      : undefined;
  }

  it("keeps total disk use within the FIRST writer's stored budget when cooperating processes disagree on retention", async () => {
    const smallBudget = 256 * 1024;
    const bigBudget = 8 * 1024 * 1024;
    const quota = 64 * 1024;
    const establishingEnv = storageEnv({
      KEIKO_LOG_RETENTION_BYTES: String(smallBudget),
      KEIKO_LOG_PIN_QUOTA_BYTES: String(quota),
    });
    const disagreeingEnv = storageEnv({
      KEIKO_LOG_RETENTION_BYTES: String(bigBudget),
      KEIKO_LOG_PIN_QUOTA_BYTES: String(quota),
    });
    const logs = logsDirectory(stateDir);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    // A forever writer establishes the SMALL budget and holds a continuously active segment for
    // the whole test — a stand-in for the review's own example (a long-running server plus one-off
    // CLI invocations) — so every writer below unambiguously sees a live peer, never a startup race
    // against other equally-fresh processes, and must adopt rather than replace.
    const establisher = startWriterWorker(stateDir, 1, {
      count: 0,
      mode: "forever",
      env: establishingEnv,
    });
    const establisherPid = establisher.child.pid ?? 0;
    await waitFor(() =>
      segmentFiles(stateDir, "active").find((file) =>
        file.name.includes(`-${String(establisherPid)}-`),
      ),
    );
    expect(policyRecord()).toMatchObject({ retentionBytes: smallBudget });

    let peak = directoryBytes(logs);
    const sampler = setInterval(() => {
      peak = Math.max(peak, directoryBytes(logs));
    }, 5);
    try {
      // Three writers all believe the budget is the LARGER one: without one shared governing
      // policy each would only cap itself at its own bigger view, and the total could grow toward
      // bigBudget + quota instead of staying at the smaller stored budget.
      const writers = [2, 3, 4].map((id) =>
        startWriterWorker(stateDir, id, { count: 700, mode: "count", env: disagreeingEnv }),
      );
      const codes = await Promise.all(writers.map((writer) => writer.exit));
      expect(codes).toStrictEqual([0, 0, 0]);
      establisher.child.kill("SIGKILL");
      await establisher.exit;
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, directoryBytes(logs));
    // The bound is the STORED (small) budget plus quota — never the disagreeing processes' own
    // (larger) view — proving the governing policy, not each process's own env, is what is enforced.
    expect(peak).toBeLessThanOrEqual(smallBudget + quota);
    expect(policyRecord()).toMatchObject({ retentionBytes: smallBudget });
    // The conflict-evidence SHAPE (one "adopted" line per disagreeing process) is proven by the
    // lighter-weight "refuses to replace" case below; a first segment holding that evidence is
    // itself subject to the same governed retention bound under this test's volume and is
    // correctly pruned like any other aged content, so it is not re-asserted here.
  }, 120_000);

  it("replaces the stored policy once this process is the sole live writer (a clean restart with a changed budget)", async () => {
    const firstBudget = 4 * 1024 * 1024;
    const secondBudget = 512 * 1024;
    const firstEnv = storageEnv({ KEIKO_LOG_RETENTION_BYTES: String(firstBudget) });
    const secondEnv = storageEnv({ KEIKO_LOG_RETENTION_BYTES: String(secondBudget) });
    const first = startWriterWorker(stateDir, 1, { count: 5, mode: "count", env: firstEnv });
    expect(await first.exit).toBe(0);
    expect(policyRecord()).toMatchObject({ retentionBytes: firstBudget });

    // The first writer has fully exited: the second is the sole live writer and may replace it.
    const second = startWriterWorker(stateDir, 2, { count: 5, mode: "count", env: secondEnv });
    expect(await second.exit).toBe(0);
    expect(policyRecord()).toMatchObject({ retentionBytes: secondBudget });
    expect(linesWithOp(stateDir, "activity-log.policy.conflict")).toContainEqual(
      expect.objectContaining({
        policyResolution: "replaced",
        storedRetentionBytes: firstBudget,
        requestedRetentionBytes: secondBudget,
      }),
    );
  });

  it("refuses to replace the stored policy while a live peer still holds an active segment", async () => {
    const firstBudget = 4 * 1024 * 1024;
    const secondBudget = 512 * 1024;
    const firstEnv = storageEnv({ KEIKO_LOG_RETENTION_BYTES: String(firstBudget) });
    const secondEnv = storageEnv({ KEIKO_LOG_RETENTION_BYTES: String(secondBudget) });
    const forever = startWriterWorker(stateDir, 1, { count: 0, mode: "forever", env: firstEnv });
    try {
      await waitFor(() => segmentFiles(stateDir, "active")[0]);
      expect(policyRecord()).toMatchObject({ retentionBytes: firstBudget });

      // A second, different process — this test process itself — disagrees but must adopt, not
      // replace, since the forever writer is still alive.
      createFileServerLogSink(stateDir, { env: secondEnv }).write({
        category: "http",
        op: "disagreeing.write",
      });
      expect(policyRecord()).toMatchObject({ retentionBytes: firstBudget });
      expect(linesWithOp(stateDir, "activity-log.policy.conflict")).toContainEqual(
        expect.objectContaining({
          policyResolution: "adopted",
          storedRetentionBytes: firstBudget,
          requestedRetentionBytes: secondBudget,
        }),
      );
    } finally {
      forever.child.kill("SIGKILL");
      await forever.exit;
    }
  });
});

describe("activity log pins never throw and can be released", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-pin-release-"));
    resetFsKnobs();
  });

  afterEach(() => {
    resetFsKnobs();
    closeFileServerLogSinks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function pinWindow(
    env: Readonly<Record<string, string>>,
    correlationId: string,
  ): ActivityLogPinResult {
    const now = Date.now();
    return pinActivityLogWindow(
      stateDir,
      {
        scope: { kind: "window", fromMs: now - 3_600_000, toMs: now + 60_000 },
        expiresAtMs: now + 86_400_000,
        correlationId,
      },
      env,
    );
  }

  function pinRecordNames(): readonly string[] {
    return readdirSync(logsDirectory(stateDir)).filter((name) => name.startsWith("pin-"));
  }

  it("rejects a pin as storage-unavailable when the directory cannot be listed", () => {
    const env = storageEnv({});
    writeSegments(stateDir, env, 1);
    fsCalls.failLogsListingCall = 1;
    const result = pinWindow(env, "pin-unlistable-3530");
    fsCalls.failLogsListingCall = null;

    expect(result).toStrictEqual({ status: "rejected", reason: "storage-unavailable" });
    expect(pinRecordNames()).toStrictEqual([]);
    expect(linesWithOp(stateDir, "activity-log.pin.created")).toContainEqual(
      expect.objectContaining({
        correlationId: "pin-unlistable-3530",
        pinStatus: "rejected",
        rejectionReason: "storage-unavailable",
      }),
    );
  });

  it("still reports a published pin when the listing after the seal fails", () => {
    const env = storageEnv({});
    writeSegments(stateDir, env, 2);
    fsCalls.failLogsListingCall = 2;
    const result = pinWindow(env, "pin-late-listing-3530");
    fsCalls.failLogsListingCall = null;

    expect(result).toMatchObject({ status: "pinned", pinnedSegmentCount: 2 });
    expect(pinRecordNames()).toHaveLength(1);
  });

  it("releases a pin before its expiry and records it as a released pin.expired", () => {
    const env = storageEnv({});
    writeSegments(stateDir, env, 2);
    const pinned = pinWindow(env, "pin-to-release-3533");
    if (pinned.status !== "pinned") throw new Error("expected a pin");

    const released = releaseActivityLogPin(
      stateDir,
      { pinId: pinned.pinId, correlationId: "pin-release-3533" },
      env,
    );

    expect(released).toStrictEqual({
      status: "released",
      releasedSegmentCount: pinned.pinnedSegmentCount,
      releasedBytes: pinned.pinnedBytes,
    });
    expect(pinRecordNames()).toStrictEqual([]);
    expect(activityLogStorageHealth(stateDir, env).pinnedBytes).toBe(0);
    expect(linesWithOp(stateDir, "activity-log.pin.expired")).toContainEqual(
      expect.objectContaining({
        correlationId: "pin-release-3533",
        pinId: pinned.pinId,
        expiryReason: "released",
        removalStatus: "removed",
        releasedSegmentCount: pinned.pinnedSegmentCount,
      }),
    );
  });

  it("refuses an invalid or unknown pin id without touching the store", () => {
    const env = storageEnv({});
    writeSegments(stateDir, env, 1);

    expect(releaseActivityLogPin(stateDir, { pinId: "not-a-pin-id" }, env)).toStrictEqual({
      status: "rejected",
      reason: "invalid-request",
    });
    expect(releaseActivityLogPin(stateDir, { pinId: "a".repeat(24) }, env)).toStrictEqual({
      status: "rejected",
      reason: "not-found",
    });
    expect(linesWithOp(stateDir, "activity-log.pin.expired")).toStrictEqual([]);
  });

  it("evidences a release that cannot list the directory and never throws", () => {
    const env = storageEnv({});
    writeSegments(stateDir, env, 1);
    const pinned = pinWindow(env, "pin-release-unlistable-3533");
    if (pinned.status !== "pinned") throw new Error("expected a pin");
    fsCalls.logsListings = 0;
    fsCalls.failLogsListingCall = 1;
    const released = releaseActivityLogPin(
      stateDir,
      { pinId: pinned.pinId, correlationId: "pin-release-unlistable-3533" },
      env,
    );
    fsCalls.failLogsListingCall = null;

    expect(released).toStrictEqual({ status: "rejected", reason: "storage-unavailable" });
    expect(pinRecordNames()).toHaveLength(1);
    expect(linesWithOp(stateDir, "activity-log.pin.expired")).toContainEqual(
      expect.objectContaining({
        correlationId: "pin-release-unlistable-3533",
        expiryReason: "released",
        removalStatus: "failed",
      }),
    );
  });
});

describe("activity log storage health", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-health-"));
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetFsKnobs();
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetFsKnobs();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("reports a fresh state directory without creating anything", () => {
    expect(activityLogStorageHealth(stateDir)).toMatchObject({
      writable: true,
      usedBytes: 0,
      budgetBytes: 256 * 1024 * 1024,
      pinQuotaBytes: 64 * 1024 * 1024,
      pinnedBytes: 0,
      activeSegments: 0,
      sealedSegments: 0,
      legacyFiles: 0,
      orphanedSegments: 0,
      pressure: "none",
      pressureState: "none",
      recoveredSegments: 0,
    });
    expect(existsSync(logsDirectory(stateDir))).toBe(false);
  });

  it("counts every kind of file, orphans awaiting recovery, and closed pressure states", () => {
    seedLegacyFile(stateDir, "server.log", 100);
    seedSegment(stateDir, {
      identity: {
        startMs: Date.now() - 1_000,
        pid: exitedProcessId(),
        instanceId: "abababab",
        index: 1,
      },
      state: "active",
      content: syntheticLines(100),
    });
    const before = listActivityLogFiles(stateDir).map((file) => file.name);
    fsCalls.freeBytes = 1_024;

    const health = activityLogStorageHealth(
      stateDir,
      storageEnv({ KEIKO_LOG_RETENTION_BYTES: "70000" }),
    );

    expect(health).toMatchObject({
      writable: true,
      budgetBytes: 70_000,
      activeSegments: 1,
      sealedSegments: 0,
      legacyFiles: 1,
      orphanedSegments: 1,
      freeBytes: 1_024,
      pressure: "elevated",
      pressureState: "low-disk-space",
    });
    expect(health.usedBytes).toBe(
      listActivityLogFiles(stateDir).reduce((total, file) => total + file.sizeBytes, 0),
    );
    // Read-only: the orphan is still unrecovered after the probe.
    expect(listActivityLogFiles(stateDir).map((file) => file.name)).toStrictEqual(before);
  });

  it("reports a redirected or non-private log directory as unwritable", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    mkdirSync(logsDirectory(stateDir), { mode: 0o700 });
    chmodSync(logsDirectory(stateDir), 0o755);
    expect(activityLogStorageHealth(stateDir).writable).toBe(false);
  });
});

describe("activity log durable batches", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-durable-"));
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetFsKnobs();
    resetServerLogFailureNotices();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetFsKnobs();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("appends and fsyncs a standard durable batch through the segment writer", () => {
    seedLegacyFile(stateDir, "server.log", 64);
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "process", op: "before-batch" });
    const seenFiles: string[] = [];

    const result = appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: (directory, files) => {
        expect(directory).toBe(logsDirectory(stateDir));
        seenFiles.push(...files);
        return {
          status: "append",
          events: [
            { category: "diagnostic", op: "batch-one" },
            { category: "diagnostic", op: "batch-complete" },
          ],
        };
      },
    });

    expect(result).toStrictEqual({ status: "appended", appendedCount: 2 });
    // Only legacy files and durable-batch pinned segments can hold an earlier batch.
    expect(seenFiles).toStrictEqual(["server.log"]);
    expect(fsCalls.fsync).toBeGreaterThanOrEqual(1);
    expect(readCallerLines(stateDir).map((line) => line.op)).toStrictEqual([
      "legacy",
      "before-batch",
      "batch-one",
      "batch-complete",
    ]);
    expect(readdirSync(logsDirectory(stateDir)).some((name) => name.startsWith("pin-"))).toBe(
      false,
    );
  });

  it("pins a durable batch so its segments are found again and never aged out", () => {
    const first = appendDurableServerLogBatch(stateDir, {
      level: "info",
      retention: "pinned",
      inspect: () => ({
        status: "append",
        events: [{ category: "diagnostic", op: "import-complete" }],
      }),
    });
    expect(first).toStrictEqual({ status: "appended", appendedCount: 1 });
    const pinned = segmentFiles(stateDir, "sealed");
    expect(pinned).toHaveLength(1);
    expect(linesWithOp(stateDir, "activity-log.pin.created")[0]).toMatchObject({
      pinReason: "durable-batch",
      pinKind: "segments",
      pinStatus: "created",
      pinnedSegmentCount: 1,
    });
    ageFiles(pinned, 400);

    let seen: readonly string[] = [];
    const second = appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: (_directory, files) => {
        seen = files;
        return { status: "already-complete" };
      },
    });

    expect(second).toStrictEqual({ status: "already-complete" });
    expect(seen).toStrictEqual(pinned.map((file) => file.name));
    createFileServerLogSink(stateDir).write({ category: "http", op: "age.pass" });
    expect(existsSync(pinned[0]?.path ?? "")).toBe(true);
  });

  it("writes nothing when the batch is already complete or the inspection defers", () => {
    expect(
      appendDurableServerLogBatch(stateDir, {
        level: "info",
        inspect: () => ({ status: "already-complete" }),
      }),
    ).toStrictEqual({ status: "already-complete" });
    expect(
      appendDurableServerLogBatch(stateDir, {
        level: "info",
        inspect: () => ({ status: "deferred" }),
      }),
    ).toStrictEqual({ status: "inspection-deferred" });
    expect(listActivityLogFiles(stateDir)).toHaveLength(0);
  });

  it("does not inspect or touch the log directory when a durable info batch is filtered", () => {
    const inspect = vi.fn(() => ({ status: "already-complete" as const }));
    expect(appendDurableServerLogBatch(stateDir, { level: "warn", inspect })).toStrictEqual({
      status: "deferred",
      reason: "level-filtered",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(existsSync(logsDirectory(stateDir))).toBe(false);
  });

  it("reports uncertain durability when the batch fsync fails", () => {
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
  });

  it("defers an invalid batch before writing any of it", () => {
    const valid = registeredTestEvent({ category: "diagnostic", op: "valid-first" });
    const result = appendStrictDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: () => ({
        status: "append",
        events: [valid, { category: "diagnostic", op: "unregistered.second" }],
      }),
    });
    expect(result).toStrictEqual({ status: "deferred", reason: "append-failed" });
    expect(readCallerLines(stateDir)).toHaveLength(0);
  });

  it("defers without writing when the log directory is redirected during inspection", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const outside = mkdtempSync(join(tmpdir(), "keiko-activity-durable-outside-"));
    try {
      const result = appendDurableServerLogBatch(stateDir, {
        level: "info",
        inspect: (directory) => {
          renameSync(directory, join(stateDir, "parked"));
          symlinkSync(outside, directory);
          return { status: "append", events: [{ category: "diagnostic", op: "must-not-append" }] };
        },
      });
      expect(result).toStrictEqual({ status: "deferred", reason: "destination-mutated" });
      expect(readdirSync(outside)).toStrictEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// A shared segment id is what a segment-set pin names; the id survives sealing unchanged.
describe("activity log segment identity", () => {
  it("keeps one segment id from creation to seal", () => {
    const identity = {
      startMs: Date.UTC(2026, 8, 18),
      pid: 4_242,
      instanceId: "0a0b0c0d",
      index: 2,
    };
    const id = formatActivityLogSegmentId(identity);
    expect(activityLogSegmentFileName(identity, "active")).toBe(`activity-${id}.active.jsonl`);
    expect(activityLogSegmentFileName(identity, "sealed")).toBe(`activity-${id}.jsonl`);
  });
});

// #3532 reads the process-wide loss ledger for its loss summary and readiness, so every line this
// writer loses is counted there too, under the closed reason that lost it, and only once it is
// really lost: evidence still queued for the next write, or a seal line already on disk, is not.
describe("activity log loss ledger", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-activity-loss-"));
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "debug");
    resetFsKnobs();
    resetServerLogFailureNotices();
    resetActivityLogLossCountersForTests();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetFsKnobs();
    resetActivityLogLossCountersForTests();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("counts a dropped write as persistence-failed and a registry rejection as schema-rejected", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "before-full" });
    fsCalls.failWriteCode = "ENOSPC";
    for (let index = 0; index < 3; index += 1) sink.write({ category: "http", op: "while-full" });
    fsCalls.failWriteCode = null;
    createStrictFileServerLogSink(stateDir).write({
      category: "diagnostic",
      op: "unregistered.loss-ledger",
    });

    expect(activityLogLossCounters()).toMatchObject({
      "persistence-failed": 3,
      "schema-rejected": 1,
    });
  });

  it("counts the lines a close cannot persist: the blocked-loss line and the seal line", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "before-full" });
    fsCalls.failWriteCode = "ENOSPC";
    for (let index = 0; index < 3; index += 1) sink.write({ category: "http", op: "while-full" });
    sink.close?.();
    fsCalls.failWriteCode = null;

    // Three dropped writes, the disk-full pressure line that never landed, and the seal line.
    expect(activityLogLossCounters()["persistence-failed"]).toBe(5);
  });

  it("does not count a seal line that reached the disk before publication failed", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "sealed-late" });
    fsCalls.failFsync = true;
    sink.close?.();
    fsCalls.failFsync = false;

    expect(activityLogLossCounters()["persistence-failed"]).toBe(0);
    expect(linesWithOp(stateDir, "activity-log.segment.sealed")).toHaveLength(1);
  });

  it("keeps pin evidence queued through a failed write instead of counting it lost", () => {
    const sink = createFileServerLogSink(stateDir);
    sink.write({ category: "http", op: "before-pin" });
    const now = Date.now();
    fsCalls.failWriteOpOnce = "activity-log.pin.created";

    const result = pinActivityLogWindow(stateDir, {
      scope: { kind: "window", fromMs: now - 60_000, toMs: now },
      expiresAtMs: now + 60_000,
    });

    expect(result.status).toBe("pinned");
    expect(fsCalls.failWriteOpOnce).toBeNull();
    expect(linesWithOp(stateDir, "activity-log.pin.created")).toHaveLength(0);
    sink.write({ category: "http", op: "after-pin" });
    expect(linesWithOp(stateDir, "activity-log.pin.created")).toHaveLength(1);
    expect(activityLogLossCounters()["persistence-failed"]).toBe(0);
  });
});
