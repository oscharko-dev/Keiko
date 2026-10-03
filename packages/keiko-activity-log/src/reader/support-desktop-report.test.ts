import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSupportIncidents } from "../support-incident.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../../tests/support/activity-log-segments.js";
import { createDesktopSupportReport } from "./support-desktop-report.js";
import { analyzeSupportReport, parseSupportReport } from "./support-report.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-desktop-report-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
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
    expect(report.incident.correlation.rootCorrelationId).toBe("desktop-failure-1");
    expect(response.reportJson).not.toContain(stateDir);
    expect(response.reportJson).not.toContain("unrelated-failure-2");
    expect(listSupportIncidents(stateDir)).toHaveLength(1);
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
});
