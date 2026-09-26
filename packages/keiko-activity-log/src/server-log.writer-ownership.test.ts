import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
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
  expect(() => rejected.createFileServerLogSink(stateDir, { level: "debug" })).toThrow(
    rejected.ActivityLogWriterOwnershipError,
  );
  expect(() =>
    rejected.pinActivityLogWindow(stateDir, {
      scope: { kind: "window", fromMs: Date.now() - 1_000, toMs: Date.now() + 1_000 },
      expiresAtMs: Date.now() + 60_000,
    }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
  expect(() => rejected.releaseActivityLogPin(stateDir, { pinId: "0".repeat(24) })).toThrow(
    rejected.ActivityLogWriterOwnershipError,
  );
  const rejectedPublic = publicGraphs[1];
  expect(() => rejectedPublic.listSupportIncidents(stateDir)).toThrow(
    rejected.ActivityLogWriterOwnershipError,
  );
  expect(() => rejectedPublic.dismissSupportIncident(stateDir, incident.record.incidentId)).toThrow(
    rejected.ActivityLogWriterOwnershipError,
  );
  expect(() => rejectedPublic.recordUserReportedIncident(stateDir)).toThrow(
    rejected.ActivityLogWriterOwnershipError,
  );
  expect(() =>
    rejectedPublic.recordRegisteredFailureIncident(stateDir, {
      op: "coding-runtime.readiness.failed",
      errorKind: "internal",
    }),
  ).toThrow(rejected.ActivityLogWriterOwnershipError);
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
  sink.write(event);
  sink.close?.();

  const lines = persistedLines(stateDir);
  const records = lines.map((line) => JSON.parse(line) as { readonly op?: unknown });
  expect(records.filter((record) => record.op === "server-log.write-failed")).toHaveLength(2);
  const rejectionLines = lines.filter(
    (_line, index) => records[index]?.op === "activity-log.writer-rejected",
  );
  expect(rejectionLines).toHaveLength(8);
  const { expectActivityLogProof } = await import("../../../tests/support/activity-log-proof.js");
  const rejection = expectActivityLogProof(
    "server-log.writer-ownership-rejected.registered-line",
    rejectionLines[0] ?? "",
  );
  expect(rejection).toMatchObject({
    reason: "process-writer-owned",
    completeness: "complete",
    loss: "none",
  });
}

function runIsolated(order: GraphOrder): void {
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
    async () => {
      const childOrder = process.env[CHILD_ORDER_ENV] as GraphOrder | undefined;
      if (childOrder !== undefined) {
        await exerciseOrder(childOrder);
        return;
      }
      runIsolated("source-first");
      runIsolated("dist-first");
    },
    TEST_TIMEOUT_MS,
  );
});
