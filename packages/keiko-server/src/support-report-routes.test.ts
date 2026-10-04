import { parseSupportIncidentPrivateProjection } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { DesktopSupportReportResponse } from "@oscharko-dev/keiko-contracts/runtime/observability";
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
import { analyzeSupportReport, parseSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";

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
  it.each(["absent", "forged", "expired"])(
    "exports only a canonical limited artifact for a %s session without private evidence",
    async (state) => {
      let now = Date.now();
      const registry = createSessionRegistry({ now: () => now, idleTtlMs: 1000 });
      const mint = registry.mint("local");
      const owner = {
        get env(): never {
          throw new Error("Private configuration cannot be consulted");
        },
        codingAppSessionChannel: { verifySession: registry.verify },
      } as unknown as UiHandlerDeps;
      const ctx = context('{"correlationId":"original-customer-error"}');
      if (state !== "absent")
        ctx.req.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${state === "forged" ? "forged" : mint.cookieToken}`;
      if (state === "expired") now += 1001;
      const result = await handleCreateSupportReport(ctx, owner);
      expect(result.status).toBe(200);
      expect(runSupportReportJob).not.toHaveBeenCalled();
      const report = result.body as DesktopSupportReportResponse;
      expect(report).toMatchObject({
        evidenceScope: "client-only",
        downloadPath: expect.any(String) as unknown,
      });
      const parsed = parseSupportReport(report.reportJson);
      expect(parsed.incident).toMatchObject({
        op: "unattributed",
        errorKind: "unknown",
        frameCount: 0,
        clientReport: { serverEvidence: "unavailable", availabilityReason: "session-unavailable" },
      });
      expect(parsed.evidence.recordCount).toBe(0);
      expect(parsed.selection.status).toBe("insufficient");
      expect(analyzeSupportReport(report.reportJson).selection.status).toBe("insufficient");
      expect(report.reportJson).not.toContain("original-customer-error");
      expect(report.reportJson).not.toContain("private-report-must-never-be-read");
      if (state === "expired") expect(registry.verify(mint.cookieToken)).toBeUndefined();
    },
  );

  it.each([
    '{"evidenceScope":"server"}',
    '{"clientReport":{"message":"customer-private-prose"}}',
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

  it.each([
    { op: "client.diagnostic" },
    { surface: "bff" },
    { errorKind: "internal" },
    {
      coverage: {
        requiredClassCount: 1,
        presentClassCount: 0,
        completeClassCount: 0,
        degradedClassCount: 0,
        insufficientClassCount: 0,
      },
    },
  ])(
    "rejects invented server attribution in the actual client-only projection %j",
    async (patch) => {
      const response = await handleCreateSupportReport(context("{}"), deps(false));
      const report = response.body as DesktopSupportReportResponse;
      const incident = parseSupportReport(report.reportJson).incident;
      expect(parseSupportIncidentPrivateProjection(incident)).toEqual(incident);
      expect(parseSupportIncidentPrivateProjection({ ...incident, ...patch })).toBeUndefined();
    },
  );

  it("records completed limited availability without inventing activity-log loss", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    expect((await handleCreateSupportReport(context("{}"), deps(false))).status).toBe(200);
    const index = sink.events.findIndex((event) => event.op === "support.report.ui.completed");
    const proof = expectActivityLogProof(
      "support.report.ui.completed.lifecycle",
      proofLine(sink, index),
    );
    expect(proof).toMatchObject({
      correlationId: "report-route-test",
      recordCount: 0,
      sufficiency: "insufficient",
      completeness: "partial",
      loss: "none",
    });
  });

  it("does not let limited report traffic consume protected full-report request admission", async () => {
    const owner = deps(false);
    for (let index = 0; index < 6; index += 1)
      expect((await handleCreateSupportReport(context("{}"), owner)).status).toBe(200);
    expect((await handleCreateSupportReport(context("{}"), owner)).status).toBe(429);
    vi.mocked(runSupportReportJob).mockResolvedValue({
      fileName: "keiko-support-v1-aabbccddeeff-2026-10-03.json",
      reportJson: "{}",
    });
    expect((await handleCreateSupportReport(context("{}"), deps())).status).toBe(200);
    expect(runSupportReportJob).toHaveBeenCalledOnce();
  });

  it("honestly exports client-only availability when diagnostic delivery failed in a valid session", async () => {
    const result = await handleCreateSupportReport(
      context('{"correlationId":"undelivered-client-error","evidenceScope":"client-only"}'),
      deps(),
    );
    expect(result.status).toBe(200);
    const report = result.body as DesktopSupportReportResponse;
    expect(parseSupportReport(report.reportJson).incident.clientReport).toEqual({
      serverEvidence: "unavailable",
      availabilityReason: "diagnostic-delivery-unavailable",
    });
    expect(runSupportReportJob).not.toHaveBeenCalled();
  });

  it("returns the exact canonical report bytes and records only counts", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const report: DesktopSupportReportResponse = {
      fileName: "keiko-support-v1-aabbccddeeff-2026-10-03.json",
      reportJson: '{"private":"report-canary"}',
      summary: {
        status: "complete",
        reasons: [],
        recordCount: 4,
        reportDigest: "a".repeat(64),
        incidentId: "a".repeat(32),
        manifestUnreadableCount: 0,
        manifestReusedCount: 2,
      },
    };
    vi.mocked(runSupportReportJob).mockResolvedValue(report);
    const result = await handleCreateSupportReport(
      context('{"correlationId":"selected-correlation"}'),
      deps(),
    );
    expect(result).toMatchObject({
      status: 200,
      body: {
        ...report,
        downloadPath: expect.stringMatching(
          /^\/api\/diagnostics\/report\/download\/[a-f0-9-]{36}$/u,
        ) as unknown,
        downloadExpiresAtMs: expect.any(Number) as unknown,
      },
      headers: { "Cache-Control": "no-store" },
    });
    expect(runSupportReportJob).toHaveBeenCalledWith(
      "/server-private-report-state",
      "selected-correlation",
      expect.any(AbortSignal),
      "report-route-test",
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

  it("logs a transported worker failure exactly once without transporting its private body", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const diagnostic = {
      ok: false as const,
      reason: "unavailable" as const,
      failureKind: "internal" as const,
      frames: ["keiko-server/support-report-worker:1:1"],
      causeChain: ["TypeError", "RangeError"],
    };
    vi.mocked(runSupportReportJob).mockRejectedValue(
      new SupportReportJobError("unavailable", undefined, diagnostic),
    );
    expect(await handleCreateSupportReport(context("{}"), deps())).toMatchObject({ status: 503 });
    const failures = sink.events.filter((event) => event.op === "support.report.ui.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.extra).toMatchObject({
      frames: diagnostic.frames,
      causeChain: diagnostic.causeChain,
      reason: "unavailable",
    });
    expect(failures[0]?.correlationId).toBe("report-route-test");
  });

  it("records incomplete report sufficiency and technical coverage without claiming complete evidence", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const report: DesktopSupportReportResponse = {
      fileName: "keiko-support-v1-aabbccddeeff-2026-10-03.json",
      reportJson: "{}",
      summary: {
        status: "insufficient",
        reasons: ["evidence-not-retained"],
        recordCount: 2,
        reportDigest: "a".repeat(64),
        incidentId: "b".repeat(32),
        manifestUnreadableCount: 1,
        manifestReusedCount: 3,
      },
    };
    vi.mocked(runSupportReportJob).mockResolvedValue(report);
    await handleCreateSupportReport(context("{}"), deps());
    const completed = sink.events.find((event) => event.op === "support.report.ui.completed");
    expect(completed?.level).toBe("warn");
    expect(completed?.extra).toMatchObject({
      sufficiency: "insufficient",
      reasons: ["evidence-not-retained"],
      completeness: "partial",
      recordCount: 2,
      manifestUnreadableCount: 1,
      manifestReusedCount: 3,
      incidentId: report.summary?.incidentId,
      reportDigest: report.summary?.reportDigest,
    });
  });
  it.each([
    "busy",
    "selection-unavailable",
    "cancelled",
    "quota-exhausted",
    "evaluation-rate-limited",
    "record-too-large",
  ] as const)("keeps expected report refusal %s out of internal failures", async (reason) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    vi.mocked(runSupportReportJob).mockRejectedValue(new SupportReportJobError(reason));
    await handleCreateSupportReport(context("{}"), deps());
    const failed = sink.events.find((event) => event.op === "support.report.ui.failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.errorKind).not.toBe("internal");
  });

  it("bounds repeated downloads without queueing scans", async () => {
    vi.mocked(runSupportReportJob).mockResolvedValue({
      fileName: "keiko-support-v1-aabbccddeeff-2026-10-03.json",
      reportJson: "{}",
    });
    for (let index = 0; index < 6; index++)
      expect((await handleCreateSupportReport(context("{}"), deps())).status).toBe(200);
    expect((await handleCreateSupportReport(context("{}"), deps())).status).toBe(429);
    expect(runSupportReportJob).toHaveBeenCalledTimes(6);
  });
});
