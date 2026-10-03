import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";

vi.mock("./support-report-job.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./support-report-job.js")>();
  return { ...actual, runSupportReportJob: vi.fn() };
});
import { runSupportReportJob, SupportReportJobError } from "./support-report-job.js";
import { handleCreateSupportReport } from "./support-report-routes.js";

function context(body: string): RouteContext {
  const req = new IncomingMessage(new Socket());
  req.push(body);
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    params: {},
    url: new URL("http://localhost/api/diagnostics/report"),
    correlationId: "report-route-test",
  };
}
function deps(paired = true): UiHandlerDeps {
  return {
    env: { KEIKO_STATE_DIR: "/server-private-report-state" },
    codingAppSessionChannel: {
      verifySession: () =>
        paired
          ? {
              sessionId: "session-test",
              principalLabel: "local",
              issuedAtMs: 1,
              lastSeenAtMs: 1,
              rotationCount: 0,
            }
          : undefined,
    },
  } as unknown as UiHandlerDeps;
}

function proofLine(sink: ReturnType<typeof createBufferedServerLogSink>, index: number): string {
  const event = sink.events[index];
  if (event === undefined) throw new Error("Expected report lifecycle event");
  return formatActivityLogProofLine(event);
}

let clock = Date.now();
beforeEach(() => {
  clock += 120_000;
  vi.setSystemTime(clock);
  vi.mocked(runSupportReportJob).mockReset();
});
afterEach(() => {
  resetServerLogger();
  vi.useRealTimers();
});

describe("desktop support report transport", () => {
  it("requires an existing local session before reading or creating a report", async () => {
    const ctx = context("invalid private body");
    expect((await handleCreateSupportReport(ctx, deps(false))).status).toBe(403);
    expect(ctx.req.readableFlowing).toBeNull();
    expect(runSupportReportJob).not.toHaveBeenCalled();
  });

  it.each([
    '{"stateDir":"/other-private-state"}',
    '{"correlationId":"bad"}',
    '{"correlationId":12}',
    "[]",
    "null",
    "{broken",
    '{"status":201,"body":{}}',
  ])("rejects closed-shape or malformed input %s", async (body) => {
    expect((await handleCreateSupportReport(context(body), deps())).status).toBe(400);
    expect(runSupportReportJob).not.toHaveBeenCalled();
  });

  it("rejects an oversized request without starting a scan", async () => {
    expect(
      (
        await handleCreateSupportReport(
          context(JSON.stringify({ correlationId: "a".repeat(2048) })),
          deps(),
        )
      ).status,
    ).toBe(413);
    expect(runSupportReportJob).not.toHaveBeenCalled();
  });

  it("returns the exact canonical report bytes and records only counts", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const report = { fileName: "report.json", reportJson: '{"private":"report-canary"}' };
    vi.mocked(runSupportReportJob).mockResolvedValue(report);
    const result = await handleCreateSupportReport(
      context('{"correlationId":"selected-correlation"}'),
      deps(),
    );
    expect(result).toEqual({ status: 200, body: report, headers: { "Cache-Control": "no-store" } });
    expect(runSupportReportJob).toHaveBeenCalledWith(
      "/server-private-report-state",
      "selected-correlation",
      expect.any(AbortSignal),
    );
    const started = sink.events.findIndex((event) => event.op === "support.report.ui.started");
    const completed = sink.events.findIndex((event) => event.op === "support.report.ui.completed");
    expectActivityLogProof("support.report.ui.started.lifecycle", proofLine(sink, started));
    const line = expectActivityLogProof(
      "support.report.ui.completed.lifecycle",
      proofLine(sink, completed),
    );
    expect(line).toMatchObject({
      reportBytes: Buffer.byteLength(report.reportJson),
      completeness: "complete",
    });
    expect(sink.lines().join("\n")).not.toContain("report-canary");
    expect(sink.lines().join("\n")).not.toContain("server-private-report-state");
  });

  it("retains body-free failure diagnostics and returns a correlation-linked short failure", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    vi.mocked(runSupportReportJob).mockRejectedValue(
      new SupportReportJobError("unavailable", new TypeError("secret failure path")),
    );
    const result = await handleCreateSupportReport(context("{}"), deps());
    expect(result).toMatchObject({
      status: 503,
      body: { error: { correlationId: "report-route-test" } },
    });
    const index = sink.events.findIndex((event) => event.op === "support.report.ui.failed");
    const line = expectActivityLogProof(
      "support.report.ui.failed.lifecycle",
      proofLine(sink, index),
    );
    expect(line).toMatchObject({ reason: "unavailable", correlationId: "report-route-test" });
    expect(sink.lines().join("\n")).not.toContain("secret failure path");
  });

  it("bounds repeated downloads without queueing scans", async () => {
    vi.mocked(runSupportReportJob).mockResolvedValue({ fileName: "report.json", reportJson: "{}" });
    for (let index = 0; index < 6; index++)
      expect((await handleCreateSupportReport(context("{}"), deps())).status).toBe(200);
    expect((await handleCreateSupportReport(context("{}"), deps())).status).toBe(429);
    expect(runSupportReportJob).toHaveBeenCalledTimes(6);
  });
});
