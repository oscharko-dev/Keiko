import {
  occupySupportIncidentRetentionForTests,
  supportIncidentReservationsForTests,
} from "../../../../tests/support/activity-log-test-support.js";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSupportIncidents,
  dismissSupportIncident,
  recordRegisteredFailureIncident,
  prepareUnretainedUserReportIncident,
} from "../support-incident.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../../tests/support/activity-log-segments.js";
import {
  createDesktopSupportReport,
  prepareManualSupportReportIncident,
  prepareDesktopSupportReport,
  createClientOnlySupportReport,
  createPreparedDesktopSupportReport,
  readDesktopSupportReportSelection,
} from "./support-desktop-report.js";
import { analyzeSupportReport, parseSupportReport } from "./support-report.js";
import * as supportLocalQuery from "./support-local-query.js";
import { ActivityLogScanner } from "./support-segment-scan.js";
import * as supportAnalysis from "./support-analyze.js";
import { executeLocalSupportQuery } from "./support-local-query.js";
import { DEFAULT_SUPPORT_QUERY_LIMITS } from "./support-query.js";
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
  vi.unstubAllEnvs();
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
  it("grants abandonment ownership only for a newly retained manual preparation", () => {
    const onCreated = vi.fn();
    const fresh = prepareDesktopSupportReport(stateDir, "new-manual-root", undefined, onCreated);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(fresh);
    onCreated.mockClear();
    expect(
      prepareDesktopSupportReport(stateDir, "new-manual-root", "another-request", onCreated),
    ).toEqual(fresh);
    expect(onCreated).not.toHaveBeenCalled();
    expect(
      dismissSupportIncident(stateDir, fresh.incidentId, {
        correlationId: "abandoned-preparation-request",
        retirementReason: "abandoned",
      }),
    ).toBe("dismissed");
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.dismissed",
    );
    expect(
      expectActivityLogProof("support.incident.dismissed.emitted-line", lines[0] ?? ""),
    ).toMatchObject({
      reason: "abandoned",
      incidentState: "candidate",
      trigger: "user-report",
      pinRelease: "released",
      openIncidentCount: 0,
    });
  });

  it("does not grant abandonment ownership for a transient quota descriptor", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    occupySupportIncidentRetentionForTests(stateDir);
    const onCreated = vi.fn();
    const descriptor = prepareDesktopSupportReport(stateDir, undefined, "quota-request", onCreated);
    expect(descriptor).not.toHaveProperty("slotIndex");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("projects canonical pin and availability disposition into body-free transport summary", () => {
    const limited = createClientOnlySupportReport("summary-correlation", "session-unavailable");
    const canonical = parseSupportReport(limited.reportJson);
    expect(limited.summary?.pinDisposition).toBe(canonical.incident.pin.status);
    expect(limited.summary?.availabilityReason).toBe(
      canonical.incident.clientReport?.availabilityReason,
    );
    writeFailures();
    const full = createDesktopSupportReport(stateDir, "desktop-failure-1");
    expect(full.summary?.pinDisposition).toBe(
      parseSupportReport(full.reportJson).incident.pin.status,
    );
    expect(full.summary?.availabilityReason).toBeUndefined();
  });

  it("normalizes invalid correlation consistently when young claims exhaust retention", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    occupySupportIncidentRetentionForTests(stateDir);
    const before = supportIncidentReservationsForTests(stateDir);
    const record = prepareManualSupportReportIncident(stateDir, "invalid correlation with spaces");
    expect(record.correlation.rootCorrelationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(record.correlation.rootCorrelationId).not.toContain("invalid");
    expect(supportIncidentReservationsForTests(stateDir)).toEqual(before);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
  });

  it("omits a credential-shaped client correlation instead of exposing it or reading private evidence", () => {
    const token = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".");
    const response = createClientOnlySupportReport(token, "session-unavailable");
    expect(response.reportJson).not.toContain(token);
    expect(parseSupportReport(response.reportJson).evidence.recordCount).toBe(0);
  });

  it.each(["session-unavailable", "diagnostic-delivery-unavailable"] as const)(
    "exports an honest limited %s artifact without opening a private log",
    (availabilityReason) => {
      const localQuery = vi.spyOn(supportLocalQuery, "executeLocalSupportQuery");
      const drain = vi.spyOn(ActivityLogScanner.prototype, "drain");
      const response = createClientOnlySupportReport(
        "original-client-support-id",
        availabilityReason,
      );
      expect(localQuery).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
      const report = parseSupportReport(response.reportJson);
      expect(report.evidence.recordCount).toBe(0);
      expect(report.incident).toMatchObject({
        op: "unattributed",
        errorKind: "unknown",
        frameCount: 0,
        clientReport: { serverEvidence: "unavailable", availabilityReason },
      });
      expect(report.incident.segments).toEqual([]);
      expect(report.incident.sufficiencyStatus).toBe("insufficient");
      expect(analyzeSupportReport(response.reportJson).selection.status).toBe("insufficient");
      expect(report.incident.correlation.rootCorrelationId).toBe("original-client-support-id");
      expect(analyzeSupportReport(response.reportJson).incident.correlation.rootCorrelationId).toBe(
        "original-client-support-id",
      );
      expect(() =>
        parseSupportReport(response.reportJson.replace(availabilityReason, "tampered")),
      ).toThrow();
      expect(response.summary).toMatchObject({ status: "insufficient", recordCount: 0 });
    },
  );

  it("exports historical pin protection failure without inventing missing process evidence", () => {
    const now = Date.now() - 100;
    const process = fixtureProcess(4242, "aabbccdd");
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      fixtureLine(process, now, { op: "cli.lifecycle.stop-requested" }),
      fixtureLine(process, now + 1, {
        op: "activity-log.pin.created",
        correlationId: "pin-protection-failure",
        fields: {
          pinStatus: "created",
          pinKind: "window",
          pinReason: "incident",
          pinnedSegmentCount: 1,
          pinnedBytes: 512,
          expiresInSeconds: 3600,
          quotaStatus: "exceeded",
          completeness: "partial",
        },
      }),
      fixtureLine(process, now + 2, {
        op: "activity-log.pin.quota-exhausted",
        correlationId: "pin-protection-failure",
        fields: {
          pinQuotaBytes: 1,
          requestedPinnedBytes: 512,
          protectedPinnedBytes: 0,
          protectedSegmentCount: 0,
          unprotectedSegmentCount: 1,
          unprotectedBytes: 512,
          unprotectedSeqSpan: 1,
          unknownSpanSegmentCount: 0,
          activePinCount: 1,
          completeness: "partial",
          loss: "event-dropped",
        },
      }),
      fixtureLine(process, now + 3, {
        op: "client.diagnostic",
        correlationId: "pin-protection-failure",
      }),
    ]);
    const response = createDesktopSupportReport(stateDir);
    const report = parseSupportReport(response.reportJson);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(report.selection.lifetimes).toEqual(
      expect.arrayContaining([
        { pid: process.pid, instanceId: process.instanceId, start: "absent" },
      ]),
    );
    expect(report.selection.lifetimes.some((lifetime) => lifetime.start === "lost")).toBe(false);
    for (const reason of ["activity-log-loss", "evidence-not-retained"])
      expect(report.selection.reasons).not.toContain(reason);
    expect(report.selection.status).not.toBe("insufficient");
    expect(
      analyzed.analysis.sufficiency.classes.find(
        (entry) => entry.failureClass === "activity-log-pin",
      ),
    ).toMatchObject({ status: "degraded", reasons: ["evidence-partial"] });
  });

  it("describes an empty budget-rejected manual export instead of its unexported complete window", () => {
    writeFailures();
    const record = prepareUnretainedUserReportIncident(stateDir, "manual-report");
    const evidence = executeLocalSupportQuery(
      stateDir,
      {
        kind: "closure",
        queryClass: "incident",
        roots: [],
        windows: [{ fromMs: record.window.fromMs, toMs: record.window.toMs }],
        requiredClasses: { kind: "observed-failures" },
        unresolved: false,
      },
      { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxResultBytes: 1 },
      { trigger: "export", persist: false },
    );
    const response = createPreparedDesktopSupportReport(stateDir, record, undefined, evidence);
    const report = parseSupportReport(response.reportJson);
    expect(report.evidence.recordCount).toBe(0);
    expect(report.incident.sufficiencyStatus).toBe("insufficient");
    expect(report.incident.sufficiencyReasons).toContain("report-budget-exceeded");
    expect(report.incident.coverage).toMatchObject({
      requiredClassCount: 0,
      completeClassCount: 0,
    });
    expect(analyzeSupportReport(response.reportJson).selection.status).toBe("insufficient");
  });

  it("exports actual manual-window diagnostics despite 8100 unrelated successful requests", () => {
    const now = Date.now() - 1000;
    const process = fixtureProcess(4242, "aabbccdd");
    const requests = Array.from({ length: 8100 }, (_, index) =>
      fixtureLine(process, now, {
        op: "request",
        correlationId: `routine-request-${String(index)}`,
        status: 200,
        fields: {
          method: "GET",
          path: "/api/health",
          queryParamNames: [],
          responseBytes: 0,
          aborted: false,
        },
      }),
    );
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      ...requests,
      fixtureLine(process, now + 1, {
        op: "client.diagnostic",
        correlationId: "manual-failure",
        level: "error",
        errorKind: "internal",
      }),
      fixtureLine(process, now + 2, {
        op: "search.connected-context.completed",
        correlationId: "manual-search",
        parentCorrelationId: "manual-failure",
        fields: {
          scopeIdentitySha256: "a".repeat(64),
          queryIdentitySha256: "b".repeat(64),
          activityDetailStatus: "complete",
        },
      }),
    ]);
    const response = createDesktopSupportReport(stateDir);
    const report = parseSupportReport(response.reportJson);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(report.evidence.recordCount).toBeGreaterThan(2);
    expect(report.incident.op).toBe("unattributed");
    expect(report.selection.reasons).not.toContain("report-budget-exceeded");
    expect(analyzed.analysis.clusters.map((cluster) => cluster.op)).toEqual(
      expect.arrayContaining(["client.diagnostic", "search.connected-context.completed"]),
    );
    expect(report.incident.sufficiencyReasons).toContain("context-truncated");
    expect(report.incident.sufficiencyStatus).toBe(report.selection.status);
  });

  it("keeps authoritative failure attribution when regeneration creates a retained manual descriptor", () => {
    writeFailures();
    const root = "desktop-failure-1";
    const selected = readDesktopSupportReportSelection(stateDir, root);
    const manual = prepareManualSupportReportIncident(stateDir, root);
    expect(manual).toHaveProperty("slotIndex");
    const response = createPreparedDesktopSupportReport(stateDir, manual, root, selected.evidence);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(analyzed.incident).toMatchObject({
      trigger: "registered-failure",
      op: "client.diagnostic",
      errorKind: "timeout",
      frameCount: 1,
    });
    expect(analyzed.analysis.evidence.supportedLineCount).toBeGreaterThan(0);
  });

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
          ...(caseName === "non-failure"
            ? {
                fields: {
                  reportBytes: 10,
                  evidenceScope: "server",
                  deliveryAuthority: "session-bound",
                },
              }
            : {}),
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
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    occupySupportIncidentRetentionForTests(stateDir);
    const reservations = supportIncidentReservationsForTests(stateDir);
    const response = createDesktopSupportReport(stateDir, "desktop-failure-1");
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(
      analyzed.analysis.timelines
        .flatMap((timeline) => timeline.lines)
        .some((line) => line.op === "client.diagnostic" && line.errorKind === "timeout"),
    ).toBe(true);
    expect(listSupportIncidents(stateDir)).toHaveLength(0);
    expect(supportIncidentReservationsForTests(stateDir)).toEqual(reservations);
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
      sourceKind: "support-report",
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
