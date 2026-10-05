import {
  occupySupportIncidentRetentionForTests,
  supportIncidentReservationsForTests,
} from "../../../tests/support/activity-log-test-support.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSupportIncidents,
  recordRegisteredFailureIncident,
  createFileServerLogSink,
  closeFileServerLogSinks,
} from "@oscharko-dev/keiko-activity-log";
import {
  analyzeSupportReport,
  parseSupportReport,
  prepareDesktopSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../tests/support/activity-log-segments.js";
import {
  ACTIVITY_LOG_OPERATION_REGISTRY,
  activityLogEvent,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { runSupportReportJob } from "../dist/support-report-job.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-report-worker-"));
});
afterEach(() => {
  closeFileServerLogSinks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

function failure(): void {
  const now = Date.now();
  const process = fixtureProcess(4242, "aabbccdd");
  writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
    fixtureLine(process, now, {
      op: "client.diagnostic",
      correlationId: "desktop-worker-failure",
      errorKind: "timeout",
      level: "error",
    }),
  ]);
}

describe("real canonical support report worker", () => {
  it("exports a retained raw browser chunk failure through the actual worker", async () => {
    const operation = ACTIVITY_LOG_OPERATION_REGISTRY.find(
      (entry) => entry.op === "client.diagnostic",
    );
    if (operation === undefined) throw new TypeError("Missing client diagnostic operation.");
    const sink = createFileServerLogSink(stateDir);
    sink.write(
      activityLogEvent(
        operation,
        {
          level: "error",
          errorKind: "internal",
          correlationId: "raw-chunk-worker-failure",
        },
        {
          clientNoteDigest: "b".repeat(64),
          clientKind: "boundary",
          renderFailure: "window-body",
          frames: ["dist/ui/static/_next/static/chunks/customerpayroll.js:4:2"],
          errorClass: "Error",
          causeChain: ["TypeError"],
        },
      ),
    );
    sink.close?.();
    recordRegisteredFailureIncident(stateDir, {
      op: "client.diagnostic",
      errorKind: "internal",
      correlationId: "raw-chunk-worker-failure",
      clientKind: "boundary",
      renderFailure: "window-body",
      frames: ["dist/ui/static/_next/static/chunks/customerpayroll.js:4:2"],
    });
    const response = await runSupportReportJob(stateDir, "raw-chunk-worker-failure");
    const report = parseSupportReport(response.reportJson);
    expect(report.incident.fingerprintAlgorithm).toBe(2);
    expect(report.incident.frameCount).toBe(1);
    expect(analyzeSupportReport(response.reportJson).selection.status).toBe("complete");
    const evidence = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
    expect(evidence).toMatch(/chunks\/sha256-[a-f0-9]{64}\.js:4:2/u);
    expect(evidence).not.toContain("customerpayroll");
    expect(evidence).not.toContain("raw-chunk-worker-failure");
  });
  it("prepares the incident on the writer thread and analyzes in the real worker", async () => {
    failure();
    const response = await runSupportReportJob(stateDir, "desktop-worker-failure");
    const report = parseSupportReport(response.reportJson);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(report.incident.correlation.rootCorrelationId).toMatch(/^id\d{6}$/u);
    expect(response.reportJson).not.toContain("desktop-worker-failure");
    expect(analyzed.selection.status).toBe("complete");
    expect(listSupportIncidents(stateDir)).toHaveLength(1);
    expect(response.reportJson).not.toContain(stateDir);
    // The worker may compute a missing acceleration manifest, but never publish it.
    expect(existsSync(join(stateDir, "activity-log-manifests"))).toBe(false);
  });

  it("downloads the selected failure through the real worker when all candidate slots are occupied", async () => {
    failure();
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    occupySupportIncidentRetentionForTests(stateDir);
    const reservations = supportIncidentReservationsForTests(stateDir);
    const retainedIds = listSupportIncidents(stateDir).map((incident) => incident.incidentId);
    const response = await runSupportReportJob(stateDir, "desktop-worker-failure");
    const report = parseSupportReport(response.reportJson);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(analyzed.selection.status).toBe("complete");
    expect(report.incident.pin.status).toBe("rejected");
    expect(listSupportIncidents(stateDir).map((incident) => incident.incidentId)).toEqual(
      retainedIds,
    );
    expect(listSupportIncidents(stateDir)).toHaveLength(0);
    expect(supportIncidentReservationsForTests(stateDir)).toEqual(reservations);
    const evidence = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
    expect(evidence).toContain('"op":"client.diagnostic"');
    expect(evidence).toContain('"errorKind":"timeout"');
    expect(evidence).not.toContain("desktop-worker-failure");
    expect(existsSync(join(stateDir, "activity-log-manifests"))).toBe(false);
  });

  it("rejects an unknown correlation before creating any incident", async () => {
    failure();
    await expect(runSupportReportJob(stateDir, "unknown-worker-failure")).rejects.toMatchObject({
      reason: "selection-unavailable",
    });
    expect(listSupportIncidents(stateDir)).toHaveLength(0);
  });

  it("creates a manual report with honest absent-evidence status through the real worker", async () => {
    const requestId = "manual-worker-export-request";
    const response = await runSupportReportJob(stateDir, undefined, undefined, requestId);
    expect(analyzeSupportReport(response.reportJson).selection.status).not.toBe("complete");
    const retained = listSupportIncidents(stateDir);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.correlation.rootCorrelationId).not.toBe(requestId);
    expect(retained[0]?.correlation.rootCorrelationId).toMatch(/^[a-f0-9-]{36}$/u);
    const report = parseSupportReport(response.reportJson);
    expect(report.incident.incidentId).toBe(retained[0]?.incidentId);
    expect(report.incident.trigger).toBe("user-report");
    expect(report.incident.correlation.rootCorrelationId).toMatch(/^id\d{6}$/u);
    expect(response.reportJson).not.toContain(requestId);
  });

  it("keeps manual export focused on a retained failure under unrelated request traffic", async () => {
    failure();
    // Footer selection reuses real automatic failure candidates, not unattributed user reports.
    recordRegisteredFailureIncident(stateDir, {
      op: "client.diagnostic",
      correlationId: "desktop-worker-failure",
      errorKind: "timeout",
    });
    const retained = prepareDesktopSupportReport(stateDir, "desktop-worker-failure");
    const now = Date.now();
    const process = fixtureProcess(4444, "ccddeeff");
    writeFixtureSegment(
      stateDir,
      segmentIdentity(process, now, 1),
      Array.from({ length: 3000 }, (_, index) =>
        fixtureLine(process, now + index, {
          op: "http.request.body.received",
          correlationId: `routine-request-${String(index)}`,
          fields: { contentType: "application/json", receivedBytes: 2 },
        }),
      ),
    );
    const response = await runSupportReportJob(stateDir);
    const report = parseSupportReport(response.reportJson);
    expect(report.incident.incidentId).toBe(retained.incidentId);
    expect(report.incident.correlation.rootCorrelationId).toMatch(/^id\d{6}$/u);
    expect(analyzeSupportReport(response.reportJson).selection.status).toBe("complete");
    const evidence = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
    expect(evidence).toContain('"op":"client.diagnostic"');
    expect(evidence).toContain('"errorKind":"timeout"');
    expect(evidence).not.toContain('"op":"http.request.body.received"');
    expect(evidence).not.toContain("desktop-worker-failure");
    expect(evidence).not.toContain("routine-request-");
    expect(listSupportIncidents(stateDir)).toHaveLength(1);
    expect(existsSync(join(stateDir, "activity-log-manifests"))).toBe(false);
  });
});
