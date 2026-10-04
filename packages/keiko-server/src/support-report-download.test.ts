import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { gunzipSync } from "node:zlib";
import * as zlib from "node:zlib";
vi.mock("node:zlib", { spy: true });
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClientOnlySupportReport,
  parseSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  cacheSupportReportDownload,
  MAX_SUPPORT_REPORT_DELIVERY_BYTES,
  SupportReportDeliveryCapacityError,
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
function attachmentBytes(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new TypeError("Expected opaque gzip attachment bytes");
  return value;
}
function decodeAttachment(value: unknown): string {
  return gunzipSync(attachmentBytes(value)).toString("utf8");
}
afterEach(() => {
  vi.useRealTimers();
  resetServerLogger();
  vi.clearAllMocks();
});
describe("authenticated canonical report attachment", () => {
  it.each([
    { session: undefined, status: 403, reason: "no-session", known: true },
    { session: "other-session", status: 404, reason: "other-session", known: true },
    { session: "owner-session", status: 404, reason: "expired-or-unknown", known: false },
  ])("records routine refusal evidence for $reason without claiming delivery", async (control) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const owner = deps(control.session);
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    const ctx = context(
      control.known ? cached.downloadPath : "/api/diagnostics/report/download/unknown",
    );
    expect(await handleDownloadSupportReport(ctx, owner)).toMatchObject({ status: control.status });
    const refusal = sink.events.find((event) => event.op === "support.report.ui.download-refused");
    expect(refusal).toMatchObject({
      level: "info",
      correlationId: ctx.correlationId,
    });
    expect(refusal?.extra).toMatchObject({
      reason: control.reason,
      completeness: "complete",
      loss: "none",
    });
    expect(
      expectActivityLogProof(
        "support.report.ui.download-refused.line",
        formatActivityLogProofLine(refusal ?? {}),
      ),
    ).toMatchObject({
      reason: control.reason,
      httpStatus: control.status,
      completeness: "complete",
      loss: "none",
    });
    expect(sink.lines().join("\n")).not.toContain(cached.downloadPath);
    expect(sink.events.some((event) => event.op === "support.report.ui.delivered")).toBe(false);
  });
  it("keeps a single admitted boundary-size artifact repeatable after compression", async () => {
    const owner = deps("owner-session");
    const boundary = {
      ...report,
      reportJson: '"' + "x".repeat(MAX_SUPPORT_REPORT_BYTES - 2) + '"',
    };
    const cached = cacheSupportReportDownload(owner, "owner-session", boundary);
    for (let index = 0; index < 2; index += 1) {
      const ctx = context(cached.downloadPath);
      vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
      const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
      expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
      expect(decodeAttachment(end.mock.calls[0]?.[0])).toBe(boundary.reportJson);
    }
  });
  it("records a gzip callback failure as a causal delivery failure", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(
      owner,
      "owner-session",
      report,
      "report-creation-123",
    );
    vi.mocked(zlib.gzip).mockImplementationOnce((_buffer, _options, callback) => {
      callback(new Error("Compression unavailable"), Buffer.alloc(0));
    });
    const ctx = context(cached.downloadPath);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(await handleDownloadSupportReport(ctx, owner)).toMatchObject({ status: 500 });
    expect(end).not.toHaveBeenCalled();
    const failure = sink.events.find((event) => event.op === "support.report.ui.failed");
    expect(failure).toMatchObject({
      correlationId: ctx.correlationId,
      parentCorrelationId: "report-creation-123",
    });
    expect(failure?.extra).toMatchObject({ reason: "unavailable" });
    expect(sink.events.some((event) => event.op === "support.report.ui.delivered")).toBe(false);
  });
  it("compresses concurrent and repeated downloads once off the event loop", async () => {
    const gzip = vi.mocked(zlib.gzip);
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    const responses = Array.from({ length: 3 }, () => context(cached.downloadPath));
    const ends = responses.map((ctx) => {
      vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
      return vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    });
    await Promise.all(responses.map((ctx) => handleDownloadSupportReport(ctx, owner)));
    expect(gzip).toHaveBeenCalledTimes(1);
    for (const end of ends)
      expect(decodeAttachment(end.mock.calls[0]?.[0])).toBe(report.reportJson);
    const repeated = context(cached.downloadPath);
    vi.spyOn(repeated.res, "writeHead").mockReturnValue(repeated.res);
    vi.spyOn(repeated.res, "end").mockReturnValue(repeated.res);
    await handleDownloadSupportReport(repeated, owner);
    expect(gzip).toHaveBeenCalledTimes(1);
  });
  it("rechecks the original session after pending compression before releasing protected bytes", async () => {
    const registry = createSessionRegistry();
    const mint = registry.mint("local");
    const owner = deps(mint.session.sessionId);
    const channel = owner.codingAppSessionChannel;
    if (channel === undefined) throw new TypeError("Missing session channel");
    vi.spyOn(channel, "verifySession").mockImplementation(registry.verify);
    const cached = cacheSupportReportDownload(owner, mint.session.sessionId, report);
    const ctx = context(cached.downloadPath);
    ctx.req.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${mint.cookieToken}`;
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    let finishCompression = (): void => {
      throw new TypeError("Compression not entered");
    };
    vi.mocked(zlib.gzip).mockImplementationOnce((buffer, options, callback) => {
      finishCompression = (): void => {
        callback(null, zlib.gzipSync(buffer, options));
      };
    });
    const pending = handleDownloadSupportReport(ctx, owner);
    registry.revoke(mint.session.sessionId);
    finishCompression();
    expect(await pending).toMatchObject({ status: 403 });
    expect(end).not.toHaveBeenCalled();
  });
  it("does not claim a delivered attachment until the response finishes", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    const ctx = context(cached.downloadPath);
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    await handleDownloadSupportReport(ctx, owner);
    expect(sink.events.filter((line) => line.op === "support.report.ui.delivered")).toEqual([]);
    ctx.res.emit("close");
    expect(sink.events.filter((line) => line.op === "support.report.ui.delivered")).toEqual([]);
    expect(sink.events).toContainEqual(
      expect.objectContaining({ op: "support.report.ui.failed", errorKind: "cancelled" }),
    );
  });
  it("actively releases the transient delivery at its declared expiry", async () => {
    vi.useFakeTimers();
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(cached.downloadExpiresAtMs - Date.now());
    expect(vi.getTimerCount()).toBe(0);
    expect(await handleDownloadSupportReport(context(cached.downloadPath), owner)).toMatchObject({
      status: 404,
    });
  });
  it("delivers standard gzip preserving exact canonical producer bytes and strict integrity", async () => {
    const canonicalReport = createClientOnlySupportReport("gzip-attachment", "session-unavailable");
    const owner = deps(undefined);
    const cached = cacheSupportReportDownload(owner, undefined, canonicalReport);
    const ctx = context(cached.downloadPath);
    const writeHead = vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${canonicalReport.fileName}.gz"`,
      }),
    );
    const bytes: unknown = end.mock.calls[0]?.[0];
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Expected opaque gzip attachment bytes");
    const decoded = gunzipSync(bytes).toString("utf8");
    expect(decoded).toBe(canonicalReport.reportJson);
    expect(parseSupportReport(decoded)).toEqual(parseSupportReport(canonicalReport.reportJson));
    expect(writeHead.mock.calls[0]?.[1]).not.toHaveProperty("Content-Encoding");
  });
  it("preserves protected artifacts when unauthenticated limited reports fill the shared cache", async () => {
    const owner = deps("protected-session");
    const full = cacheSupportReportDownload(owner, "protected-session", report);
    const limited = createClientOnlySupportReport("limited-flood", "session-unavailable");
    for (let index = 0; index < 140; index += 1)
      cacheSupportReportDownload(owner, undefined, limited);
    const ctx = context(full.downloadPath);
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
    expect(decodeAttachment(end.mock.calls[0]?.[0])).toBe(report.reportJson);
  });

  it("keeps a boundary protected report and a canonical limited report independently downloadable", async () => {
    const owner = deps("protected-session");
    const boundary = { ...report, reportJson: "x".repeat(MAX_SUPPORT_REPORT_BYTES) };
    const protectedTarget = cacheSupportReportDownload(owner, "protected-session", boundary);
    const limited = createClientOnlySupportReport(
      "limited-boundary-coexistence",
      "session-unavailable",
    );
    const limitedTarget = cacheSupportReportDownload(owner, undefined, limited);
    for (const [target, expected] of [
      [protectedTarget, boundary],
      [limitedTarget, limited],
    ] as const) {
      const ctx = context(target.downloadPath);
      vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
      const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
      expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
      expect(decodeAttachment(end.mock.calls[0]?.[0])).toBe(expected.reportJson);
    }
  });

  it("evicts limited evidence first under aggregate byte pressure below the count ceiling", async () => {
    const owner = deps("protected-session");
    const limited = createClientOnlySupportReport("limited-byte-pressure", "session-unavailable");
    let remaining =
      MAX_SUPPORT_REPORT_DELIVERY_BYTES -
      Buffer.byteLength(limited.reportJson) -
      Buffer.byteLength(report.reportJson) +
      1;
    const protectedTargets: { downloadPath: string; text: string }[] = [];
    while (remaining > 0) {
      const text = "x".repeat(Math.min(MAX_SUPPORT_REPORT_BYTES, remaining));
      const cached = cacheSupportReportDownload(owner, "protected-session", {
        ...report,
        reportJson: text,
      });
      protectedTargets.push({ downloadPath: cached.downloadPath, text });
      remaining -= Buffer.byteLength(text);
    }
    const limitedTarget = cacheSupportReportDownload(owner, undefined, limited);
    const latest = cacheSupportReportDownload(owner, "protected-session", report);
    expect(
      await handleDownloadSupportReport(context(limitedTarget.downloadPath), owner),
    ).toMatchObject({ status: 404 });
    for (const target of [
      ...protectedTargets,
      { downloadPath: latest.downloadPath, text: report.reportJson },
    ]) {
      const ctx = context(target.downloadPath);
      vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
      const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
      expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
      expect(decodeAttachment(end.mock.calls[0]?.[0])).toBe(target.text);
    }
  });

  it("refuses limited delivery when protected artifacts occupy the whole existing capacity", async () => {
    const owner = deps("protected-session");
    const first = cacheSupportReportDownload(owner, "protected-session", report);
    for (let index = 1; index < 128; index += 1)
      cacheSupportReportDownload(owner, "protected-session", report);
    const limited = createClientOnlySupportReport("limited-capacity", "session-unavailable");
    expect(() => cacheSupportReportDownload(owner, undefined, limited)).toThrow(
      SupportReportDeliveryCapacityError,
    );
    const ctx = context(first.downloadPath);
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
  });

  it("delivers only canonical client-only bytes without granting protected report authority", async () => {
    const owner = deps(undefined);
    const limited = createClientOnlySupportReport("client-report-download", "session-unavailable");
    const cached = cacheSupportReportDownload(owner, undefined, limited);
    const ctx = context(cached.downloadPath);
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
    expect(decodeAttachment(end.mock.calls[0]?.[0])).toBe(limited.reportJson);
    expect(() => cacheSupportReportDownload(owner, undefined, report)).toThrow();
    expect(() =>
      cacheSupportReportDownload(owner, undefined, { ...report, evidenceScope: "client-only" }),
    ).toThrow();
    const full = cacheSupportReportDownload(owner, "protected-session", report);
    expect(await handleDownloadSupportReport(context(full.downloadPath), owner)).toMatchObject({
      status: 403,
    });
  });

  it("serves exact canonical bytes as an HTTP attachment without another generation", async () => {
    const canonicalReport = createClientOnlySupportReport(
      "opaque-canonical",
      "session-unavailable",
    );
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", canonicalReport);
    const ctx = context(cached.downloadPath);
    const writeHead = vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
    expect(decodeAttachment(end.mock.calls[0]?.[0])).toBe(canonicalReport.reportJson);
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Disposition": `attachment; filename="${canonicalReport.fileName}.gz"`,
        "Content-Type": "application/gzip",
        "Content-Length": String(attachmentBytes(end.mock.calls[0]?.[0]).length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      }),
    );
  });
  it("records attachment delivery without logging report bytes or the resource reference", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(
      owner,
      "owner-session",
      {
        ...report,
        summary: {
          status: "complete",
          reasons: [],
          recordCount: 1,
          reportDigest: "a".repeat(64),
          incidentId: "b".repeat(32),
          manifestUnreadableCount: 0,
          manifestReusedCount: 0,
        },
      },
      "report-creation-request",
    );
    const ctx = context(cached.downloadPath);
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    await handleDownloadSupportReport(ctx, owner);
    expect(sink.events.some((line) => line.op === "support.report.ui.delivered")).toBe(false);
    ctx.res.emit("finish");
    const event = sink.events.find((line) => line.op === "support.report.ui.delivered");
    if (event === undefined) throw new Error("Expected body-free attachment delivery evidence");
    const proof = expectActivityLogProof(
      "support.report.ui.delivered.line",
      formatActivityLogProofLine(event),
    );
    expect(proof).toMatchObject({
      reportBytes: Buffer.byteLength(report.reportJson),
      transportBytes: attachmentBytes(end.mock.calls[0]?.[0]).length,
      correlationId: "download-test",
      parentCorrelationId: "report-creation-request",
      reportDigest: "a".repeat(64),
      completeness: "complete",
      evidenceScope: "server",
      deliveryAuthority: "session-bound",
    });
    expect(sink.lines().join("\n")).not.toContain(report.reportJson);
    expect(sink.lines().join("\n")).not.toContain(cached.downloadPath);
  });
  it("records actual client-only evidence independently of session-bound delivery authority", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const owner = deps("owner-session");
    const limited = createClientOnlySupportReport("scope-projection", "session-unavailable");
    const cached = cacheSupportReportDownload(owner, "owner-session", limited);
    const ctx = context(cached.downloadPath);
    vi.spyOn(ctx.res, "writeHead").mockReturnValue(ctx.res);
    const end = vi.spyOn(ctx.res, "end").mockReturnValue(ctx.res);
    await handleDownloadSupportReport(ctx, owner);
    ctx.res.emit("finish");
    const event = sink.events.find((line) => line.op === "support.report.ui.delivered");
    expect(event?.extra).toMatchObject({
      evidenceScope: "client-only",
      deliveryAuthority: "session-bound",
      reportBytes: Buffer.byteLength(limited.reportJson),
      transportBytes: attachmentBytes(end.mock.calls[0]?.[0]).length,
    });
  });
  it("requires the original session and server instance even when the reference is known", async () => {
    const owner = deps("owner-session");
    const cached = cacheSupportReportDownload(owner, "owner-session", report);
    expect(
      await handleDownloadSupportReport(context(cached.downloadPath), deps(undefined)),
    ).toMatchObject({ status: 403 });
    expect(
      await handleDownloadSupportReport(context(cached.downloadPath), deps("other-session")),
    ).toMatchObject({ status: 404 });
    const channel = owner.codingAppSessionChannel;
    if (channel === undefined) throw new TypeError("Missing session channel");
    vi.spyOn(channel, "verifySession").mockReturnValue({
      sessionId: "other-session",
    } as never);
    expect(await handleDownloadSupportReport(context(cached.downloadPath), owner)).toMatchObject({
      status: 404,
    });
  });
  it("refuses revoked and expired sessions through the real session verifier", async () => {
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
    expect(await handleDownloadSupportReport(ctx, owner)).toBe(STREAMING);
    now += 1_001;
    expect(await handleDownloadSupportReport(ctx, owner)).toMatchObject({ status: 403 });
    const fresh = registry.mint("local");
    const freshArtifact = cacheSupportReportDownload(owner, fresh.session.sessionId, report);
    const revoked = context(freshArtifact.downloadPath);
    revoked.req.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${fresh.cookieToken}`;
    registry.revoke(fresh.session.sessionId);
    expect(await handleDownloadSupportReport(revoked, owner)).toMatchObject({ status: 403 });
  });

  it("expires references and bounds aggregate retained UTF-8 bytes", async () => {
    vi.useFakeTimers();
    const owner = deps("owner-session");
    const first = cacheSupportReportDownload(owner, "owner-session", {
      ...report,
      reportJson: "é".repeat(MAX_SUPPORT_REPORT_BYTES / 2),
    });
    let remaining = MAX_SUPPORT_REPORT_DELIVERY_BYTES - MAX_SUPPORT_REPORT_BYTES;
    while (remaining > 0) {
      const bytes = Math.min(remaining, MAX_SUPPORT_REPORT_BYTES);
      cacheSupportReportDownload(owner, "other-session", {
        ...report,
        reportJson: "x".repeat(bytes),
      });
      remaining -= bytes;
    }
    const next = cacheSupportReportDownload(owner, "owner-session", report);
    expect(await handleDownloadSupportReport(context(first.downloadPath), owner)).toMatchObject({
      status: 404,
    });
    vi.setSystemTime(next.downloadExpiresAtMs + 1);
    expect(await handleDownloadSupportReport(context(next.downloadPath), owner)).toMatchObject({
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
