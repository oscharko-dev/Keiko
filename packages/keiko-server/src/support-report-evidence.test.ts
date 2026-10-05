import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-activity-log";
import {
  prepareDesktopSupportReport,
  createPreparedDesktopSupportReport,
  parseSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  resetServerLogger,
  occupySupportIncidentRetentionForTests,
} from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { emitSupportReportStarted, emitSupportReportCompleted } from "./support-report-evidence.js";

afterEach(resetServerLogger);
it("retains registered report lifecycle evidence without credential-shaped selected identifiers", () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const selected = "sk-synthetic-diagnostic-selector";
  emitSupportReportStarted("safe-report-request", true, selected);
  const event = sink.events[0];
  if (event === undefined) throw new TypeError("Missing report start evidence");
  expect(event.extra).not.toHaveProperty("selectedCorrelationId");
  expect(
    expectActivityLogProof(
      "support.report.ui.started.lifecycle",
      formatActivityLogProofLine(event),
    ),
  ).toMatchObject({ correlationId: "safe-report-request", selector: "correlation" });
  expect(sink.lines().join("\n")).not.toContain(selected);
});
it("projects canonical byte integrity independently of diagnostic sufficiency", () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  emitSupportReportCompleted("safe-report-request", {
    fileName: "keiko-support-v1-aabbccddeeff-2026-10-03.json",
    reportJson: "{}",
    summary: {
      status: "degraded",
      reasons: ["context-truncated"],
      recordCount: 1,
      reportDigest: "a".repeat(64),
      incidentId: "b".repeat(32),
      manifestUnreadableCount: 0,
      manifestReusedCount: 0,
      completeness: "complete",
      loss: "none",
    },
  });
  const event = sink.events[0];
  if (event === undefined) throw new TypeError("Missing report completion evidence");
  expect(
    expectActivityLogProof(
      "support.report.ui.completed.lifecycle",
      formatActivityLogProofLine(event),
    ),
  ).toMatchObject({ sufficiency: "degraded", completeness: "complete", loss: "none" });
});

it.each(["stored", "transient"] as const)(
  "records actual %s server preparation without exposing its reservation slot",
  (retentionDisposition) => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-report-retention-evidence-"));
    try {
      if (retentionDisposition === "transient") {
        vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
        occupySupportIncidentRetentionForTests(stateDir);
      }
      const descriptor = prepareDesktopSupportReport(stateDir, undefined, "retention-evidence");
      const report = createPreparedDesktopSupportReport(stateDir, descriptor);
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "debug" }));
      emitSupportReportCompleted("retention-report-request", report);
      const event = sink.events[0];
      if (event === undefined) throw new TypeError("Missing report completion evidence");
      const proof = expectActivityLogProof(
        "support.report.ui.completed.lifecycle",
        formatActivityLogProofLine(event),
      );
      expect(proof).toMatchObject({
        correlationId: "retention-report-request",
        evidenceScope: "server",
        retentionDisposition,
      });
      if (retentionDisposition === "stored")
        expect(proof).toHaveProperty(
          "pinDisposition",
          parseSupportReport(report.reportJson).incident.pin.status,
        );
      else expect(proof).not.toHaveProperty("pinDisposition");
      expect(proof).not.toHaveProperty("slotIndex");
    } finally {
      closeFileServerLogSinks();
      vi.unstubAllEnvs();
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
