import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({ instances: [] as EventEmitter[], terminate: vi.fn() }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    public constructor() {
      super();
      workers.instances.push(this);
    }
    public terminate = workers.terminate;
  },
}));
import { runSupportReportJob } from "./support-report-job.js";

function activeWorker(): EventEmitter {
  const worker = workers.instances.at(-1);
  if (worker === undefined) throw new Error("Worker was not started");
  return worker;
}

afterEach(() => {
  vi.useRealTimers();
  workers.instances.length = 0;
  workers.terminate.mockReset();
});

describe("bounded desktop support-report worker", () => {
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
