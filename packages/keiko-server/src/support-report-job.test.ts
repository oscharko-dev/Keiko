import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeFileServerLogSinks,
  listSupportIncidents,
  recordUserReportedIncident,
  recordRegisteredFailureIncident,
} from "@oscharko-dev/keiko-activity-log";
import {
  parseActivityLogPinFileName,
  SUPPORT_INCIDENT_DIRECTORY_NAME,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({
  instances: [] as EventEmitter[],
  terminate: vi.fn(),
  postMessage: vi.fn(),
  prepare:
    vi.fn<
      (typeof import("@oscharko-dev/keiko-activity-log/reader"))["prepareDesktopSupportReport"]
    >(),
}));
vi.mock("@oscharko-dev/keiko-activity-log/reader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-activity-log/reader")>();
  return { ...actual, prepareDesktopSupportReport: workers.prepare };
});
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends EventEmitter {
      public constructor() {
        super();
        workers.instances.push(this);
      }
      public terminate = workers.terminate;
      public postMessage = workers.postMessage;
    },
  };
});
import {
  expectRegisteredActivityLogLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { runSupportReportJob } from "./support-report-job.js";
const reportDirectories: string[] = [];

function activeWorker(): EventEmitter {
  const worker = workers.instances.at(-1);
  if (worker === undefined) throw new Error("Worker was not started");
  return worker;
}

function expectAbandonedPreparation(stateDir: string): void {
  const lines = persistedActivityLogLines(
    readPersistedActivityLog(stateDir),
    "support.incident.dismissed",
  );
  expect(lines).toHaveLength(1);
  expect(
    expectRegisteredActivityLogLine("support.incident.dismissed", lines[0] ?? ""),
  ).toMatchObject({
    reason: "abandoned",
    trigger: "user-report",
    incidentState: "candidate",
    pinRelease: "released",
    openIncidentCount: 0,
    correlationId: "fresh-manual-job",
  });
}

afterEach(() => {
  vi.useRealTimers();
  workers.instances.length = 0;
  workers.terminate.mockReset();
  workers.prepare.mockReset();
  workers.postMessage.mockReset();
  closeFileServerLogSinks();
  for (const directory of reportDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("bounded desktop support-report worker", () => {
  it.each(["manual", "registered"])(
    "preserves an existing %s candidate when a report job is cancelled",
    async (kind) => {
      const stateDir = mkdtempSync(join(tmpdir(), "keiko-existing-report-"));
      reportDirectories.push(stateDir);
      const correlationId = "existing-owned-diagnostic";
      const candidate =
        kind === "manual"
          ? recordUserReportedIncident(stateDir, { correlationId })
          : recordRegisteredFailureIncident(stateDir, {
              op: "coding-runtime.readiness.failed",
              errorKind: "unavailable",
              correlationId,
              frames: ["packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:710:9"],
            });
      if (candidate?.status !== "created") throw new TypeError("Expected existing candidate");
      const actual = await vi.importActual<
        typeof import("@oscharko-dev/keiko-activity-log/reader")
      >("@oscharko-dev/keiko-activity-log/reader");
      workers.prepare.mockImplementation(actual.prepareDesktopSupportReport);
      const controller = new AbortController();
      const prepared = vi.fn();
      const result = runSupportReportJob(
        stateDir,
        correlationId,
        controller.signal,
        "new-report-job",
        prepared,
      );
      const rejection = expect(result).rejects.toMatchObject({ reason: "cancelled" });
      activeWorker().emit("message", { kind: "prepare", correlationId });
      controller.abort();
      await rejection;
      expect(prepared).not.toHaveBeenCalled();
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([candidate.record]);
      expect(
        readdirSync(join(stateDir, "logs")).filter(
          (name) => parseActivityLogPinFileName(name) !== undefined,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["cancelled", "timeout", "error", "termination"])(
    "abandons only its fresh manual preparation after %s",
    async (failure) => {
      const stateDir = mkdtempSync(join(tmpdir(), "keiko-abandoned-report-"));
      reportDirectories.push(stateDir);
      const actual = await vi.importActual<
        typeof import("@oscharko-dev/keiko-activity-log/reader")
      >("@oscharko-dev/keiko-activity-log/reader");
      workers.prepare.mockImplementation(actual.prepareDesktopSupportReport);
      if (failure === "timeout") vi.useFakeTimers();
      const controller = new AbortController();
      const result = runSupportReportJob(
        stateDir,
        undefined,
        controller.signal,
        "fresh-manual-job",
      );
      const rejection = result.catch((error: unknown) => error);
      activeWorker().emit("message", { kind: "prepare" });
      const pendingRecords = listSupportIncidents(stateDir, { readOnly: true });
      if (failure === "cancelled") controller.abort();
      else if (failure === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else if (failure === "error")
        activeWorker().emit("error", new Error("Synthetic worker failure"));
      else {
        workers.terminate.mockRejectedValueOnce(new Error("Synthetic termination failure"));
        activeWorker().emit("message", {
          ok: true,
          report: { fileName: "report.json", reportJson: "{}" },
        });
      }
      const rejected = await rejection;
      expect(pendingRecords).toHaveLength(1);
      expect(rejected).toMatchObject({
        reason: failure === "error" || failure === "termination" ? "unavailable" : failure,
      });
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
      expect(readdirSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME))).toEqual([]);
      expectAbandonedPreparation(stateDir);
      expect(
        readdirSync(join(stateDir, "logs")).filter(
          (name) => parseActivityLogPinFileName(name) !== undefined,
        ),
      ).toEqual([]);
    },
  );

  it("hands off only its fresh preparation and leaves withdrawal idempotent after worker success", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-report-"));
    reportDirectories.push(stateDir);
    const actual = await vi.importActual<typeof import("@oscharko-dev/keiko-activity-log/reader")>(
      "@oscharko-dev/keiko-activity-log/reader",
    );
    workers.prepare.mockImplementation(actual.prepareDesktopSupportReport);
    let abandon: (() => void) | undefined;
    const prepared = vi.fn((cleanup: () => void): void => {
      abandon = cleanup;
    });
    const result = runSupportReportJob(
      stateDir,
      undefined,
      undefined,
      "fresh-manual-job",
      prepared,
    );
    activeWorker().emit("message", { kind: "prepare" });
    activeWorker().emit("message", {
      ok: true,
      report: { fileName: "report.json", reportJson: "{}" },
    });
    await expect(result).resolves.toHaveProperty("fileName", "report.json");
    expect(prepared).toHaveBeenCalledOnce();
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(1);
    abandon?.();
    abandon?.();
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
    expect(readdirSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME))).toEqual([]);
    expectAbandonedPreparation(stateDir);
  });

  it("does not queue concurrent scans and releases the worker after success", async () => {
    const result = runSupportReportJob("/private-report-state");
    await expect(runSupportReportJob("/private-report-state")).rejects.toMatchObject({
      reason: "busy",
    });
    const report = { fileName: "report.json", reportJson: "{}" };
    activeWorker().emit("message", { ok: true, report });
    await expect(result).resolves.toEqual(report);
    expect(workers.terminate).toHaveBeenCalledOnce();
  });

  it("retains redacted worker failure diagnostics", async () => {
    const result = runSupportReportJob("/private-report-state");
    activeWorker().emit("message", {
      ok: false,
      reason: "selection-unavailable",
      frames: ["support-report.ts:10:5"],
      causeChain: ["TypeError"],
      failureKind: "internal",
    });
    await expect(result).rejects.toMatchObject({
      reason: "selection-unavailable",
      frames: ["support-report.ts:10:5"],
      causeChain: ["TypeError"],
    });
  });

  it("propagates a writer-thread preparation failure to the awaiting route with bounded facts", async () => {
    workers.prepare.mockImplementationOnce(() => {
      throw new TypeError("private preparation payload", {
        cause: new RangeError("private cause"),
      });
    });
    const result = runSupportReportJob(
      "/private-report-state",
      "requested-failure",
      undefined,
      "report-http-request",
    );
    activeWorker().emit("message", { kind: "prepare", correlationId: "requested-failure" });
    await expect(result).rejects.toMatchObject({
      reason: "unavailable",
      causeChain: ["RangeError"],
    });
    await expect(result).rejects.not.toHaveProperty("message", "private preparation payload");
    expect(workers.prepare).toHaveBeenCalledExactlyOnceWith(
      "/private-report-state",
      "requested-failure",
      "report-http-request",
      expect.any(Function),
    );
    expect(workers.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a worker selection that retargets the explicitly requested error", async () => {
    const result = runSupportReportJob("/private-report-state", "requested-failure");
    activeWorker().emit("message", { kind: "prepare", correlationId: "different-failure" });
    await expect(result).rejects.toMatchObject({ reason: "selection-unavailable" });
    expect(workers.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an invalid automatically selected correlation before incident preparation", async () => {
    const result = runSupportReportJob("/private-report-state");
    activeWorker().emit("message", { kind: "prepare", correlationId: "private\ncontent" });
    await expect(result).rejects.toMatchObject({ reason: "selection-unavailable" });
    expect(workers.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a stalled worker at the deadline", async () => {
    vi.useFakeTimers();
    const result = runSupportReportJob("/private-report-state");
    const failure = expect(result).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(workers.terminate).toHaveBeenCalledOnce();
  });

  it("releases capacity even when termination rejects", async () => {
    workers.terminate.mockRejectedValueOnce(new Error("private termination path"));
    const first = runSupportReportJob("/private-report-state");
    activeWorker().emit("error", new TypeError("private worker error"));
    await expect(first).rejects.toMatchObject({ reason: "unavailable" });
    const second = runSupportReportJob("/private-report-state");
    activeWorker().emit("message", {
      ok: true,
      report: { fileName: "report.json", reportJson: "{}" },
    });
    await expect(second).resolves.toHaveProperty("fileName", "report.json");
  });
  it("cancels a disconnected download and releases capacity", async () => {
    const controller = new AbortController();
    const result = runSupportReportJob("/private-report-state", undefined, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ reason: "cancelled" });
    expect(workers.terminate).toHaveBeenCalledOnce();
  });

  it("does not start a scan for an already disconnected download", async () => {
    await expect(
      runSupportReportJob("/private-report-state", undefined, AbortSignal.abort()),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(workers.instances).toHaveLength(0);
  });

  it("settles a worker that exits without a report", async () => {
    const result = runSupportReportJob("/private-report-state");
    activeWorker().emit("exit", 1);
    await expect(result).rejects.toMatchObject({ reason: "unavailable" });
    expect(workers.terminate).toHaveBeenCalledOnce();
  });
});
