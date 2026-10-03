import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  cacheSupportReportDownload,
  handleDownloadSupportReport,
} from "./support-report-download.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { STREAMING, type RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

const report = {
  fileName: "keiko-support-v1-aabbccddeeff-2026-10-03.json",
  reportJson: '{"kind":"keiko.support.report"}',
};
function deps(sessionId: string | undefined): UiHandlerDeps {
  return {
    codingAppSessionChannel: {
      verifySession: () => (sessionId === undefined ? undefined : { sessionId }),
    },
  } as unknown as UiHandlerDeps;
}
function context(downloadPath: string): RouteContext {
  const req = new IncomingMessage(new Socket());
  return {
    req,
    res: new ServerResponse(req),
    params: { downloadId: downloadPath.split("/").at(-1) ?? "" },
    url: new URL(downloadPath, "http://localhost"),
    correlationId: "download-test",
  };
}
afterEach(() => {
  vi.useRealTimers();
  resetServerLogger();
});
describe("authenticated canonical report attachment", () => {
  it("serves exact canonical bytes as an HTTP attachment without another generation", () => {
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    const ctx = context(cached.downloadPath);
    const writeHead = vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
    expect(end).toHaveBeenCalledWith(report.reportJson);
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Disposition": `attachment; filename="${report.fileName}"`,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(report.reportJson)),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      }),
    );
  });
  it("records attachment delivery without logging report bytes or the resource reference", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    const ctx = context(cached.downloadPath);
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    handleDownloadSupportReport(ctx, owner);
    const event = sink.events.find((line) => line.op === "support.report.ui.delivered");
    if (event === undefined) throw new Error("Expected body-free attachment delivery evidence");
    const proof = expectActivityLogProof(
      "support.report.ui.delivered.line",
      formatActivityLogProofLine(event),
    );
    expect(proof).toMatchObject({
      reportBytes: Buffer.byteLength(report.reportJson),
      correlationId: "download-test",
      completeness: "complete",
    });
    expect(sink.lines().join("\n")).not.toContain(report.reportJson);
    expect(sink.lines().join("\n")).not.toContain(cached.downloadPath);
  });
  it("requires the original session and server instance even when the reference is known", () => {
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    expect(
      handleDownloadSupportReport(context(cached.downloadPath), deps(undefined)),
    ).toMatchObject({ status: 403 });
    expect(
      handleDownloadSupportReport(context(cached.downloadPath), deps("other-session")),
    ).toMatchObject({ status: 404 });
    vi.spyOn(owner.codingAppSessionChannel!, "verifySession").mockReturnValue({
      sessionId: "other-session",
    } as never);
    expect(handleDownloadSupportReport(context(cached.downloadPath), owner)).toMatchObject({
      status: 404,
    });
  });
  it("refuses revoked and expired sessions through the real session verifier", () => {
    let now = Date.now();
    const registry = createSessionRegistry({ now: () => now, idleTtlMs: 1_000 });
    const mint = registry.mint("local");
    const owner = {
      codingAppSessionChannel: { verifySession: registry.verify },
    } as unknown as UiHandlerDeps;
    const cached = cacheSupportReportDownload(owner, mint.session.sessionId, report);
    const ctx = context(cached.downloadPath);
    ctx.req.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${mint.cookieToken}`;
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
    now += 1_001;
    expect(handleDownloadSupportReport(ctx, owner)).toMatchObject({ status: 403 });
    const fresh = registry.mint("local");
    const freshArtifact = cacheSupportReportDownload(owner, fresh.session.sessionId, report);
    const revoked = context(freshArtifact.downloadPath);
    revoked.req.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${fresh.cookieToken}`;
    registry.revoke(fresh.session.sessionId);
    expect(handleDownloadSupportReport(revoked, owner)).toMatchObject({ status: 403 });
  });

  it("expires references and bounds aggregate retained UTF-8 bytes", () => {
    vi.useFakeTimers();
    const owner = deps("owner-session");
    const first = cacheSupportReportDownload(owner, "owner-session", {
      ...report,
      reportJson: "é".repeat(MAX_SUPPORT_REPORT_BYTES / 2),
    });
    const next = cacheSupportReportDownload(owner, "owner-session", report);
    expect(handleDownloadSupportReport(context(first.downloadPath), owner)).toMatchObject({
      status: 404,
    });
    vi.setSystemTime(next.downloadExpiresAtMs + 1);
    expect(handleDownloadSupportReport(context(next.downloadPath), owner)).toMatchObject({
      status: 404,
    });
  });
  it("rejects unsafe filenames and oversized report bytes before retaining them", () => {
    const owner = deps("owner-session");
    expect(() =>
      cacheSupportReportDownload(owner, "owner-session", {
        ...report,
        fileName: "../private.json",
      }),
    ).toThrow(TypeError);
    expect(() =>
      cacheSupportReportDownload(owner, "owner-session", {
        ...report,
        reportJson: "é".repeat(MAX_SUPPORT_REPORT_BYTES / 2 + 1),
      }),
    ).toThrow(TypeError);
  });
});
