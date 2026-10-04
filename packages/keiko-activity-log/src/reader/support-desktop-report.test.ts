import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SUPPORT_INCIDENTS,
  listSupportIncidents,
  recordUserReportedIncident,
  recordRegisteredFailureIncident,
  prepareUnretainedUserReportIncident,
} from "../support-incident.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../../tests/support/activity-log-segments.js";
import {
  createDesktopSupportReport,
  createPreparedDesktopSupportReport,
  readDesktopSupportReportSelection,
} from "./support-desktop-report.js";
import { analyzeSupportReport, parseSupportReport } from "./support-report.js";
import * as supportAnalysis from "./support-analyze.js";
import {
  MAX_SUPPORT_REPORT_TIMELINE_RECORDS,
  MAX_SUPPORT_REPORT_TIMELINE_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-desktop-report-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function writeFailures(): void {
  const now = Date.now();
  const process = fixtureProcess(4242, "aabbccdd");
  writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
    fixtureLine(process, now, {
      op: "client.diagnostic",
      correlationId: "desktop-failure-1",
      errorKind: "timeout",
      level: "error",
      fields: { frames: ["packages/keiko-server/dist/chat-stream-handlers.js:42:7"] },
    }),
    fixtureLine(process, now + 1, {
      op: "client.diagnostic",
      correlationId: "unrelated-failure-2",
      errorKind: "internal",
      level: "error",
    }),
  ]);
}

describe("desktop canonical support report", () => {
  function transientReport(correlationId: string): ReturnType<typeof analyzeSupportReport> {
    const selected = readDesktopSupportReportSelection(stateDir, correlationId);
    const response = createPreparedDesktopSupportReport(
      stateDir,
      prepareUnretainedUserReportIncident(stateDir, correlationId),
      correlationId,
      selected.evidence,
    );
    return analyzeSupportReport(response.reportJson);
  }

  it.each(["warn", "error"] as const)(
    "prefers a framed error diagnostic over a %s summary in the selected child closure",
    (level) => {
      const now = Date.now();
      const process = fixtureProcess(4242, "aabbccdd");
      writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
        fixtureLine(process, now, {
          op: "client.diagnostic",
          correlationId: "selected-root",
          level,
          errorKind: "timeout",
        }),
        fixtureLine(process, now + 1, {
          op: "client.diagnostic",
          correlationId: "selected-child",
          parentCorrelationId: "selected-root",
          level: "error",
          errorKind: "internal",
          fields: { frames: ["packages/keiko-server/dist/chat-stream-handlers.js:42:7"] },
        }),
      ]);
      const analyzed = transientReport("selected-root");
      expect(analyzed.incident).toMatchObject({
        trigger: "registered-failure",
        op: "client.diagnostic",
        errorKind: "internal",
        frameCount: 1,
      });
      expect(analyzed.incident.correlation.childCorrelationIds).toHaveLength(1);
      expect(listSupportIncidents(stateDir)).toHaveLength(0);
    },
  );

  it("retains a grandchild failure without inventing a direct parent edge from the requested root", () => {
    const now = Date.now();
    const process = fixtureProcess(4242, "aabbccdd");
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      fixtureLine(process, now, { op: "client.diagnostic", correlationId: "selected-root" }),
      fixtureLine(process, now + 1, {
        op: "client.diagnostic",
        correlationId: "selected-child",
        parentCorrelationId: "selected-root",
      }),
      fixtureLine(process, now + 2, {
        op: "client.diagnostic",
        correlationId: "selected-grandchild",
        parentCorrelationId: "selected-child",
        level: "error",
        errorKind: "internal",
        fields: { frames: ["packages/keiko-server/dist/chat-stream-handlers.js:42:7"] },
      }),
    ]);
    const analyzed = transientReport("selected-root");
    expect(analyzed.incident).toMatchObject({
      trigger: "user-report",
      op: "unattributed",
      frameCount: 0,
    });
    const failure = analyzed.analysis.timelines
      .flatMap((timeline) => timeline.lines)
      .find((line) => line.level === "error");
    expect(failure?.errorKind).toBe("internal");
    expect(failure?.frames).toHaveLength(1);
    expect(listSupportIncidents(stateDir)).toHaveLength(0);
  });

  it.each(["non-failure", "no-error", "unrelated"])(
    "preserves manual identity for a selected %s event",
    (caseName) => {
      const now = Date.now();
      const process = fixtureProcess(4242, "aabbccdd");
      writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
        fixtureLine(process, now, {
          op: caseName === "non-failure" ? "support.report.ui.delivered" : "client.diagnostic",
          correlationId: "manual-root",
          level: caseName === "non-failure" ? "error" : "info",
          ...(caseName === "non-failure" ? { errorKind: "internal" as const } : {}),
          ...(caseName === "non-failure" ? { fields: { reportBytes: 10 } } : {}),
        }),
        fixtureLine(process, now + 1, {
          op: "client.diagnostic",
          correlationId: "other-root",
          level: "error",
          errorKind: "internal",
        }),
      ]);
      expect(transientReport("manual-root").incident).toMatchObject({
        trigger: "user-report",
        op: "unattributed",
        errorKind: "unknown",
        frameCount: 0,
      });
      expect(listSupportIncidents(stateDir)).toHaveLength(0);
    },
  );

  it("exports retained error evidence even when every incident slot is occupied", () => {
    writeFailures();
    for (let index = 0; index < MAX_SUPPORT_INCIDENTS; index += 1) {
      expect(
        recordUserReportedIncident(stateDir, { correlationId: `previous-report-${String(index)}` })
          .status,
      ).toBe("created");
    }
    const response = createDesktopSupportReport(stateDir, "desktop-failure-1");
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(
      analyzed.analysis.timelines
        .flatMap((timeline) => timeline.lines)
        .some((line) => line.op === "client.diagnostic" && line.errorKind === "timeout"),
    ).toBe(true);
    expect(listSupportIncidents(stateDir)).toHaveLength(MAX_SUPPORT_INCIDENTS);
    expect(parseSupportReport(response.reportJson).incident).toMatchObject({
      trigger: "registered-failure",
      op: "client.diagnostic",
      errorKind: "timeout",
      frameCount: 1,
      pin: { status: "rejected" },
    });
  });

  it("exports the selected failure through the canonical analyzer without unrelated evidence or paths", () => {
    writeFailures();
    const response = createDesktopSupportReport(stateDir, "desktop-failure-1");
    const report = parseSupportReport(response.reportJson);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(response.fileName).toMatch(/^keiko-support-v1-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json$/u);
    expect(
      analyzed.analysis.timelines.some((timeline) =>
        timeline.lines.some((line) => line.op === "client.diagnostic"),
      ),
    ).toBe(true);
    expect(analyzed.selection.status).toBe("complete");
    expect(report.incident.correlation.rootCorrelationId).toMatch(/^id\d{6}$/u);
    expect(response.reportJson).not.toContain("desktop-failure-1");
    expect(response.reportJson).not.toContain(stateDir);
    const decoded = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
    expect(decoded).not.toContain("unrelated-failure-2");
    expect(decoded).not.toContain("desktop-failure-1");
    const failures = analyzed.analysis.timelines
      .flatMap((timeline) => timeline.lines)
      .filter((line) => line.level === "error");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorKind).toBe("timeout");
    expect(listSupportIncidents(stateDir)).toHaveLength(1);
  });

  it("derives sufficiency from the selected failure even when reported long after its segment sealed", () => {
    const failureAt = Date.now() - 75 * 60 * 1000;
    const process = fixtureProcess(4242, "aabbccdd");
    const path = writeFixtureSegment(stateDir, segmentIdentity(process, failureAt, 1), [
      fixtureLine(process, failureAt, {
        op: "client.diagnostic",
        correlationId: "aged-desktop-failure",
        errorKind: "timeout",
        level: "error",
      }),
    ]);
    utimesSync(path, failureAt / 1000, failureAt / 1000);
    const response = createDesktopSupportReport(stateDir, "aged-desktop-failure");
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(analyzed.selection.status).toBe("complete");
    expect(analyzed.selection.reasons).not.toContain("no-registered-failure");
    expect(
      analyzed.analysis.timelines
        .flatMap((timeline) => timeline.lines)
        .some((line) => line.op === "client.diagnostic" && line.errorKind === "timeout"),
    ).toBe(true);
  });

  it("bounds selected incident analysis before timeline expansion and exports explicit incompleteness", () => {
    const now = Date.now();
    const process = fixtureProcess(4242, "aabbccdd");
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      fixtureLine(process, now, {
        op: "client.diagnostic",
        correlationId: "bounded-analysis",
        errorKind: "timeout",
        level: "error",
      }),
      fixtureLine(process, now + 1, {
        op: "client.diagnostic",
        correlationId: "bounded-analysis",
        errorKind: "internal",
        level: "error",
      }),
    ]);
    const analyze = supportAnalysis.analyzeLogLines;
    const selectedAnalysis = vi
      .spyOn(supportAnalysis, "analyzeLogLines")
      .mockImplementationOnce((lines, options) =>
        analyze(lines, { ...options, maxTimelineRecords: 1 }),
      );
    const response = createDesktopSupportReport(stateDir, "bounded-analysis");
    const report = parseSupportReport(response.reportJson);
    expect(selectedAnalysis).toHaveBeenCalledWith(expect.any(Array), {
      maxTimelineRecords: MAX_SUPPORT_REPORT_TIMELINE_RECORDS,
      maxTimelineBytes: MAX_SUPPORT_REPORT_TIMELINE_BYTES,
    });
    expect(report.incident.sufficiencyReasons).toContain("report-budget-exceeded");
    expect(report.selection.status).toBe("insufficient");
    expect(report.selection.reasons).toContain("report-budget-exceeded");
    expect(analyzeSupportReport(response.reportJson).selection.status).toBe("insufficient");
  });

  it("rejects an unknown correlation without pinning a fabricated incident", () => {
    writeFailures();
    expect(() => createDesktopSupportReport(stateDir, "unknown-failure")).toThrow(
      "selection-unavailable",
    );
    expect(listSupportIncidents(stateDir)).toHaveLength(0);
  });

  it("keeps the manual report available and labels absent evidence honestly", () => {
    const response = createDesktopSupportReport(stateDir);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(
      analyzed.analysis.timelines.every((timeline) =>
        timeline.lines.every((line) => line.op !== "client.diagnostic"),
      ),
    ).toBe(true);
    expect(analyzed.selection.status).not.toBe("complete");
    expect(listSupportIncidents(stateDir)).toHaveLength(1);
  });

  it("exports joined opaque references without customer labels in headers or compressed evidence", () => {
    const now = Date.now();
    const process = fixtureProcess(4242, "aabbccdd");
    const parent = "ClientAcmePayroll.xlsx";
    const child = "ClientAcmeConfidentialChat";
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      fixtureLine(process, now, { op: "client.diagnostic", correlationId: parent }),
      fixtureLine(process, now + 1, {
        op: "client.diagnostic",
        correlationId: child,
        parentCorrelationId: parent,
        fields: { workspaceId: parent, repositoryId: child },
      }),
    ]);
    const response = createDesktopSupportReport(stateDir, child);
    const report = parseSupportReport(response.reportJson);
    const evidence = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
    for (const canary of [parent, child]) {
      expect(response.reportJson).not.toContain(canary);
      expect(evidence).not.toContain(canary);
    }
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(analyzed.selection.status).toBe("complete");
    expect(report.evidence.recordCount).toBeGreaterThanOrEqual(2);
    expect(
      analyzed.analysis.timelines.some((timeline) =>
        timeline.lines.some((line) => line.parentCorrelationId !== undefined),
      ),
    ).toBe(true);
  });
  it("makes a manual report select the latest retained failure instead of overflowing on unrelated traffic", () => {
    writeFailures();
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    recordRegisteredFailureIncident(stateDir, {
      op: "client.diagnostic",
      errorKind: "timeout",
      correlationId: "desktop-failure-1",
    });
    vi.setSystemTime(now + 1000);
    recordRegisteredFailureIncident(stateDir, {
      op: "client.diagnostic",
      errorKind: "internal",
      correlationId: "unrelated-failure-2",
    });
    const process = fixtureProcess(4444, "ccddeeff");
    const noise = Array.from({ length: 3000 }, (_, index) =>
      fixtureLine(process, now + index, {
        op: "http.request.body.received",
        correlationId: `routine-request-${String(index)}`,
        fields: { contentType: "application/json", receivedBytes: 2 },
      }),
    );
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), noise);
    const response = createDesktopSupportReport(stateDir);
    const report = parseSupportReport(response.reportJson);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(report.incident.correlation.rootCorrelationId).toMatch(/^id\d{6}$/u);
    expect(analyzed.selection.status).toBe("complete");
    expect(report.incident.incidentId).toBe(listSupportIncidents(stateDir).at(-1)?.incidentId);
    const decoded = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
    expect(decoded).not.toContain("routine-request-2999");
    const failures = analyzed.analysis.timelines
      .flatMap((timeline) => timeline.lines)
      .filter((line) => line.level === "error");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorKind).toBe("internal");
    expect(listSupportIncidents(stateDir)).toHaveLength(2);
  });
});
