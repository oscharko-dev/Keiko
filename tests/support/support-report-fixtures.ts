import { inflateSync } from "node:zlib";
import type {
  SupportReport,
  SupportReportEvent,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  encodeSupportReportEvidence,
  sealSupportReport,
} from "../../packages/keiko-activity-log/src/reader/support-report.js";
import { fixtureLine, fixtureProcess } from "./activity-log-segments.js";

/** Creates a resealed hostile graph through the production formatter, encoder and integrity owner. */
export function resealSupportReportWithParentFanOut(report: SupportReport): SupportReport {
  const retained = JSON.parse(
    inflateSync(Buffer.from(report.evidence.payload, "base64")).toString(),
  ) as readonly SupportReportEvent[];
  const first = retained[0];
  const correlationId = report.incident.correlation.rootCorrelationId;
  if (
    first === undefined ||
    correlationId === undefined ||
    typeof first.record.pid !== "number" ||
    typeof first.record.instanceId !== "string"
  )
    throw new TypeError("missing report fixture identity");
  const process = fixtureProcess(first.record.pid, first.record.instanceId);
  const events = Array.from({ length: 300 }, (_, index) => ({
    sourceSegmentId: first.sourceSegmentId,
    record: JSON.parse(
      fixtureLine(process, Date.now() + index, {
        op: "client.diagnostic",
        correlationId,
        parentCorrelationId: `amplified-parent-${String(index)}`,
      }),
    ) as Record<string, unknown>,
  }));
  return sealSupportReport(report.incident, report.selection, encodeSupportReportEvidence(events));
}
