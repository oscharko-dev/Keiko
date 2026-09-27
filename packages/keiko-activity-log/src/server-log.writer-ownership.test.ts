import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogLossCounters,
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

const CHILD_ORDER_ENV = "KEIKO_ACTIVITY_LOG_WRITER_GRAPH_ORDER";
const TEST_TIMEOUT_MS = process.env[CHILD_ORDER_ENV] === undefined ? 45_000 : 15_000;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_MODULE_URL = pathToFileURL(resolve(PACKAGE_ROOT, "dist/server-log.js")).href;
const DIST_ROOT_URL = pathToFileURL(resolve(PACKAGE_ROOT, "dist/index.js")).href;
const VITEST_ENTRY = resolve(PACKAGE_ROOT, "../../node_modules/vitest/vitest.mjs");
const THIS_TEST = "src/server-log.writer-ownership.test.ts";
const roots: string[] = [];

type WriterModule = typeof import("./server-log.js");
type PublicModule = typeof import("./index.js");
type GraphOrder = "source-first" | "dist-first";
type ChildMode = GraphOrder | "foreign-slot";

const CHILD_MODE = process.env[CHILD_ORDER_ENV] as ChildMode | undefined;
const WRITER_OWNER_KEY = Symbol.for("@oscharko-dev/keiko-activity-log/process-writer-owner");

// The operation correlation each rejected call carries. Entry points without one (opening a sink,
// declaring a production logger, appending a durable batch) fall back to the sanctioned unknown id.
const REJECTED_CALL = {
  pin: "writer-owner-pin-create",
  release: "writer-owner-pin-release",
  list: "writer-owner-incident-list",
  dismiss: "writer-owner-incident-dismiss",
  report: "writer-owner-incident-report",
  failure: "writer-owner-incident-failure",
} as const;
// A frame of this test file is the call site that attempted to open the second writer.
const CALLER_FRAME =
  /^packages\/keiko-activity-log\/src\/server-log\.writer-ownership\.test\.ts:\d+:\d+$/;

// The rejected graph's own claim frame: the built copy for source-first, the source copy otherwise.
function rejectedClaimFrame(order: GraphOrder): RegExp {
  return order === "source-first"
    ? /^packages\/keiko-activity-log\/dist\/server-log\.js:\d+:\d+$/
    : /^packages\/keiko-activity-log\/src\/server-log\.ts:\d+:\d+$/;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadGraphs(order: GraphOrder): Promise<readonly [WriterModule, WriterModule]> {
  if (order === "source-first") {
    const source = await import("./server-log.js");
    const dist = (await import(/* @vite-ignore */ DIST_MODULE_URL)) as WriterModule;
    return [source, dist];
  }
  const dist = (await import(/* @vite-ignore */ DIST_MODULE_URL)) as WriterModule;
  const source = await import("./server-log.js");
  return [dist, source];
}

async function loadPublicGraphs(order: GraphOrder): Promise<readonly [PublicModule, PublicModule]> {
  if (order === "source-first") {
    const source = await import("./index.js");
    const dist = (await import(/* @vite-ignore */ DIST_ROOT_URL)) as PublicModule;
    return [source, dist];
  }
  const dist = (await import(/* @vite-ignore */ DIST_ROOT_URL)) as PublicModule;
  const source = await import("./index.js");
  return [dist, source];
}

function persistedLines(stateDir: string): readonly string[] {
  const directory = join(stateDir, "logs");
  return readdirSync(directory)
    .sort((left, right) => left.localeCompare(right, "en-US"))
    .flatMap((name) =>
      readFileSync(join(directory, name), "utf8")
        .split("\n")
        .filter((line) => line.length > 0),
    );
}

interface LiveSegment {
  readonly name: string;
  readonly ino: number;
  readonly bytes: string;
}

// The winner's one active segment. A sealed sibling would be renamed away from `.active.jsonl`,
// and a recovered one would be re-created under a new inode, so name and inode together prove the
// segment stayed live and untouched apart from appends.
function liveSegment(stateDir: string): LiveSegment {
  const directory = join(stateDir, "logs");
  const active = readdirSync(directory).filter((name) => name.endsWith(".active.jsonl"));
  expect(active).toHaveLength(1);
  const name = active[0] ?? "";
  const path = join(directory, name);
  return { name, ino: lstatSync(path).ino, bytes: readFileSync(path, "utf8") };
}

function segmentNames(stateDir: string): readonly string[] {
  return readdirSync(join(stateDir, "logs"))
    .filter((name) => name.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

function fileSnapshot(
  directory: string,
  include: (name: string) => boolean = () => true,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter(include)
      .sort((left, right) => left.localeCompare(right, "en-US"))
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
}

async function exerciseOrder(order: GraphOrder): Promise<void> {
  if (!existsSync(fileURLToPath(DIST_MODULE_URL))) {
    throw new Error("Built keiko-activity-log is missing; run npm run build:packages first");
  }
  const stateDir = mkdtempSync(join(tmpdir(), `keiko-writer-owner-${order}-`));
  roots.push(stateDir);
  const [winner, rejected] = await loadGraphs(order);
  const publicGraphs = await loadPublicGraphs(order);
  const internalOnlyExports = [
    "createBufferedServerLogSink",
    "writeActivityLogPinRecord",
    "writeActivityLogPolicyRecord",
    "removeActivityLogFile",
    "ensureSupportIncidentDirectory",
    "writeSupportIncidentRecord",
    "removeSupportIncidentRecord",
    "claimSupportIncidentFingerprint",
    "releaseSupportIncidentFingerprintClaim",
    "claimSupportIncidentSlot",
    "releaseSupportIncidentSlot",
    "removeSupportIncidentClaimFile",
    "resetActivityLogLossSummaryForTests",
    "resetActivityLogReadinessForTests",
    "installActivityLogTestWriter",
    "resetServerLogger",
    "setSupportIncidentTriggerForTests",
    "resetActivityLogRouteRedactor",
    "resetServerLogFailureNotices",
    "activityLogTestWriterInstalled",
  ] as const;
  for (const publicGraph of publicGraphs) {
    for (const name of internalOnlyExports) expect(publicGraph).not.toHaveProperty(name);
  }
  const registration = activityLogOperationSchema("server-log.write-failed");
  if (registration === undefined) throw new Error("fixture operation is not registered");
  const event: import("./server-log.js").ServerLogEvent = attachActivityLogEventRegistration(
    {
      level: "error",
      category: "diagnostic",
      op: "server-log.write-failed",
      correlationId: "00000000-0000-4000-8000-000000000001",
      errorKind: "internal",
      extra: { completeness: "complete", loss: "none" },
    },
    registration,
  );

  const sink = winner.createFileServerLogSink(stateDir, { level: "debug" });
  sink.write(event);
  const winnerPublic = publicGraphs[0];
  const incident = winnerPublic.recordUserReportedIncident(stateDir);
  expect(incident.status).toBe("created");
  if (incident.status !== "created") throw new Error("fixture: winner did not create an incident");
  const incidentDirectory = join(stateDir, "support-incidents");
  const incidentSnapshot = fileSnapshot(incidentDirectory);
  const pinSnapshot = fileSnapshot(join(stateDir, "logs"), (name) => name.startsWith("pin-"));
  const liveBefore = liveSegment(stateDir);
  const segmentsBefore = segmentNames(stateDir);
  expect(() => rejected.createFileServerLogSink(stateDir, { level: "debug" })).toThrow(
    rejected.ActivityLogWriterOwnershipError,
  );
  expect(() =>
    rejected.pinActivityLogWindow(stateDir, {
      scope: { kind: "window", fromMs: Date.now() - 1_000, toMs: Date.now() + 1_000 },
      expiresAtMs: Date.now() + 60_000,
      correlationId: REJECTED_CALL.pin,
    }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  expect(() =>
    rejected.releaseActivityLogPin(stateDir, {
      pinId: "0".repeat(24),
      correlationId: REJECTED_CALL.release,
    }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  const rejectedPublic = publicGraphs[1];
  expect(() =>
    rejectedPublic.listSupportIncidents(stateDir, { correlationId: REJECTED_CALL.list }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  expect(() =>
    rejectedPublic.dismissSupportIncident(stateDir, incident.record.incidentId, {
      correlationId: REJECTED_CALL.dismiss,
    }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  expect(() =>
    rejectedPublic.recordUserReportedIncident(stateDir, { correlationId: REJECTED_CALL.report }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  expect(() =>
    rejectedPublic.recordRegisteredFailureIncident(stateDir, {
      op: "coding-runtime.readiness.failed",
      errorKind: "internal",
      correlationId: REJECTED_CALL.failure,
    }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  expect(() => {
    rejectedPublic.setServerLogger(
      rejectedPublic.createServerLogger({ sink: { write: (): void => undefined } }),
      "production-file",
      stateDir,
    );
  }).toThrow(rejected.ActivityLogWriterOwnershipError);
  let inspected = false;
  expect(() =>
    rejected.appendDurableServerLogBatch(stateDir, {
      level: "info",
      inspect: () => {
        inspected = true;
        return { status: "already-complete" };
      },
    }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  expect(inspected).toBe(false);
  expect(fileSnapshot(incidentDirectory)).toEqual(incidentSnapshot);
  expect(fileSnapshot(join(stateDir, "logs"), (name) => name.startsWith("pin-"))).toEqual(
    pinSnapshot,
  );
  // Neither instance sealed the other's live segment: the winner's segment is the same live file,
  // only appended to (by the winner's rejection evidence), and no segment appeared or disappeared.
  const liveAfterRejections = liveSegment(stateDir);
  expect(liveAfterRejections.name).toBe(liveBefore.name);
  expect(liveAfterRejections.ino).toBe(liveBefore.ino);
  expect(liveAfterRejections.bytes.startsWith(liveBefore.bytes)).toBe(true);
  expect(segmentNames(stateDir)).toEqual(segmentsBefore);
  sink.write(event);
  const liveAfterWinnerWrite = liveSegment(stateDir);
  expect(liveAfterWinnerWrite.name).toBe(liveBefore.name);
  expect(liveAfterWinnerWrite.ino).toBe(liveBefore.ino);
  expect(liveAfterWinnerWrite.bytes.length).toBeGreaterThan(liveAfterRejections.bytes.length);
  sink.close?.();

  const lines = persistedLines(stateDir);
  const records = lines.map((line) => JSON.parse(line) as { readonly op?: unknown });
  expect(records.filter((record) => record.op === "server-log.write-failed")).toHaveLength(2);
  const rejectionLines = lines.filter(
    (_line, index) => records[index]?.op === "activity-log.writer-rejected",
  );
  expect(rejectionLines).toHaveLength(9);
  const rejectedCall = expect.arrayContaining([
    expect.stringMatching(rejectedClaimFrame(order)),
    expect.stringMatching(CALLER_FRAME),
  ]) as unknown;
  await expectRejectionLines(rejectionLines, rejectedCall);
  await expectRejectionAnalysis(lines, rejectedCall);
}

// Each rejection is a correlated failure line: the operation the rejected call belonged to, or the
// sanctioned unknown id for an entry point that has none, with the frames of that rejected call.
async function expectRejectionLines(
  lines: readonly string[],
  rejectedCall: unknown,
): Promise<void> {
  const { expectActivityLogProof } = await import("../../../tests/support/activity-log-proof.js");
  const rejections = lines.map((line) =>
    expectActivityLogProof("server-log.writer-ownership-rejected.registered-line", line),
  );
  expect(rejections.map((record) => record.correlationId)).toEqual([
    ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    REJECTED_CALL.pin,
    REJECTED_CALL.release,
    REJECTED_CALL.list,
    REJECTED_CALL.dismiss,
    REJECTED_CALL.report,
    REJECTED_CALL.failure,
    ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  ]);
  for (const rejection of rejections) {
    expect(rejection).toMatchObject({
      level: "error",
      category: "diagnostic",
      errorKind: "conflict",
      reason: "process-writer-owned",
      completeness: "complete",
      loss: "none",
      frames: rejectedCall,
    });
  }
}

// The analyzer reconstructs the rejected call through its normal timeline and failure cluster.
async function expectRejectionAnalysis(
  lines: readonly string[],
  rejectedCall: unknown,
): Promise<void> {
  const { analyzeLogText } = await import("./reader/support-analyze.js");
  const analysis = analyzeLogText(`${lines.join("\n")}\n`);
  expect(
    analysis.clusters.find((cluster) => cluster.op === "activity-log.writer-rejected"),
  ).toEqual({
    category: "diagnostic",
    op: "activity-log.writer-rejected",
    errorKind: "conflict",
    count: 9,
    sampleCorrelationIds: [
      ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
      REJECTED_CALL.pin,
      REJECTED_CALL.release,
      REJECTED_CALL.list,
      REJECTED_CALL.dismiss,
    ],
  });
  const pinTimeline = analysis.timelines.find(
    (timeline) => timeline.correlationId === REJECTED_CALL.pin,
  );
  expect(pinTimeline?.lines.map((line) => line.op)).toEqual(["activity-log.writer-rejected"]);
  expect(pinTimeline?.errorKinds).toEqual(["conflict"]);
  expect(pinTimeline?.frames).toEqual(rejectedCall);
}

// The lines `run` writes to stderr, captured without reaching the real stream.
function stderrLines(run: () => void): readonly string[] {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    run();
    return stderr.mock.calls.map(([chunk]) => String(chunk).trimEnd());
  } finally {
    stderr.mockRestore();
  }
}

// A foreign or version-skewed value in the process slot is not a writer this graph can defer to.
// The claim must fail closed before any filesystem mutation, and the rejection it cannot persist
// is counted in the loss ledger.
async function exerciseForeignSlot(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-writer-owner-foreign-"));
  roots.push(stateDir);
  Reflect.set(globalThis, WRITER_OWNER_KEY, { graphToken: "foreign" });
  const writer = await import("./server-log.js");
  resetActivityLogLossCountersForTests();
  const written = stderrLines(() => {
    // The notice is throttled process-wide; each rejection below starts from an unused slate.
    writer.resetServerLogFailureNotices();
    expect(() => writer.createFileServerLogSink(stateDir, { level: "debug" })).toThrow(
      writer.ActivityLogWriterOwnershipError,
    );
    writer.resetServerLogFailureNotices();
    expect(() =>
      writer.pinActivityLogWindow(stateDir, {
        scope: { kind: "window", fromMs: Date.now() - 1_000, toMs: Date.now() + 1_000 },
        expiresAtMs: Date.now() + 60_000,
        correlationId: REJECTED_CALL.pin,
      }),
    ).toThrow(writer.ActivityLogWriterOwnershipError);
  });
  expect(existsSync(join(stateDir, "logs"))).toBe(false);
  expect(activityLogLossCounters()["persistence-failed"]).toBe(2);
  // The independent stderr notice keeps the rejected call's correlation and closed error kind.
  const { expectActivityLogStderrProof } =
    await import("../../../tests/support/activity-log-proof.js");
  const notices = written.map((line) =>
    expectActivityLogStderrProof("server-log.write-failed.stderr-line", line),
  );
  expect(notices.map((notice) => notice.correlationId)).toEqual([
    ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    REJECTED_CALL.pin,
  ]);
  for (const notice of notices) {
    expect(notice).toMatchObject({
      errorKind: "conflict",
      failedOp: "activity-log.writer-rejected",
      loss: "event-dropped",
    });
  }
}

// A worker thread shares the pid but not the main realm's owner slot, so it must never open a writer.
const WORKER_WRITER_ATTEMPT = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.moduleUrl).then(
  (writer) => {
    try {
      writer.createFileServerLogSink(workerData.stateDir, { level: "debug" });
      parentPort.postMessage({ outcome: "opened" });
    } catch (error) {
      parentPort.postMessage({ outcome: "rejected", name: error.name });
    }
  },
  (error) => parentPort.postMessage({ outcome: "load-failed", name: String(error) }),
);
`;

function runIsolated(order: ChildMode): void {
  const run = spawnSync(
    process.execPath,
    [VITEST_ENTRY, "run", THIS_TEST, "--config", "vitest.config.ts"],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: { ...process.env, [CHILD_ORDER_ENV]: order },
      timeout: 30_000,
    },
  );
  expect(run.error, run.stderr).toBeUndefined();
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
}

describe("process-wide Activity Log writer ownership", () => {
  it(
    "rejects the second source/dist graph before mutation and keeps the winner appendable",
    async (ctx) => {
      if (CHILD_MODE === "foreign-slot") ctx.skip();
      if (CHILD_MODE !== undefined) {
        await exerciseOrder(CHILD_MODE as GraphOrder);
        return;
      }
      runIsolated("source-first");
      runIsolated("dist-first");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails closed with counted evidence when the ownership slot holds a foreign value",
    async (ctx) => {
      if (CHILD_MODE === "foreign-slot") {
        await exerciseForeignSlot();
        return;
      }
      if (CHILD_MODE !== undefined) ctx.skip();
      runIsolated("foreign-slot");
    },
    TEST_TIMEOUT_MS,
  );

  it("refuses to open a writer inside a worker thread", async (ctx) => {
    if (CHILD_MODE !== undefined) ctx.skip();
    if (!existsSync(fileURLToPath(DIST_ROOT_URL))) {
      throw new Error("Built keiko-activity-log is missing; run npm run build:packages first");
    }
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-writer-owner-worker-"));
    roots.push(stateDir);
    const worker = new Worker(WORKER_WRITER_ATTEMPT, {
      eval: true,
      workerData: { moduleUrl: DIST_ROOT_URL, stateDir },
    });
    try {
      const [message] = (await once(worker, "message")) as [unknown];
      expect(message).toEqual({ outcome: "rejected", name: "ActivityLogWriterOwnershipError" });
      expect(existsSync(join(stateDir, "logs"))).toBe(false);
    } finally {
      await worker.terminate();
    }
  });
});
