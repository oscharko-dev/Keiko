import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSupportIncidents } from "@oscharko-dev/keiko-activity-log";
import { analyzeSupportReport, parseSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../tests/support/activity-log-segments.js";
import { runSupportReportJob } from "../dist/support-report-job.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-report-worker-"));
});
afterEach(() => {
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
  it("prepares the incident on the writer thread and analyzes in the real worker", async () => {
    failure();
    const response = await runSupportReportJob(stateDir, "desktop-worker-failure");
    const report = parseSupportReport(response.reportJson);
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(report.incident.correlation.rootCorrelationId).toBe("desktop-worker-failure");
    expect(analyzed.selection.status).toBe("complete");
    expect(listSupportIncidents(stateDir)).toHaveLength(1);
    expect(response.reportJson).not.toContain(stateDir);
    // The worker may compute a missing acceleration manifest, but never publish it.
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
    const response = await runSupportReportJob(stateDir);
    expect(analyzeSupportReport(response.reportJson).selection.status).not.toBe("complete");
    expect(listSupportIncidents(stateDir)).toHaveLength(1);
  });
});
