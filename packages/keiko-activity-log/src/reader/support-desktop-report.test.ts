import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSupportIncidents, recordRegisteredFailureIncident } from "../support-incident.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../../tests/support/activity-log-segments.js";
import { createDesktopSupportReport } from "./support-desktop-report.js";
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
