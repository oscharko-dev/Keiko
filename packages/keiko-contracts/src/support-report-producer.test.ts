import { describe, expect, it } from "vitest";
import { supportIncidentBuild } from "./support-incident.js";
import { KEIKO_PRODUCT_VERSION } from "./version.js";
import { ACTIVITY_LOG_UNKNOWN_CORRELATION_ID } from "./observability.js";
import {
  clientOnlySupportReportSections,
  type ClientOnlySupportReportInput,
} from "./support-report-producer.js";

function input(correlationId?: string): ClientOnlySupportReportInput {
  return {
    incidentId: "a".repeat(32),
    nowMs: Date.UTC(2026, 9, 3),
    build: supportIncidentBuild(KEIKO_PRODUCT_VERSION, "darwin-arm64"),
    defectFingerprint: "b".repeat(64),
    availabilityReason: "service-unavailable",
    correlationId,
  };
}

describe("limited support report correlation normalization", () => {
  it.each([
    undefined,
    ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    "short",
    "proxy:original-id",
    "customer@example.test",
    `sk-proj-${"a".repeat(32)}`,
  ])(
    "keeps an artifact available without inventing or exposing selected id %j",
    (correlationId) => {
      const sections = clientOnlySupportReportSections(input(correlationId));
      expect(sections.incident.correlation).toEqual({
        rootCorrelationId: "id000001",
        childCorrelationIds: [],
      });
      expect(sections.evidence.recordCount).toBe(0);
      expect(sections.incident.clientReport?.availabilityReason).toBe("service-unavailable");
    },
  );

  it("preserves an explicitly selected safe request identity", () => {
    expect(
      clientOnlySupportReportSections(input("selected-health-request")).incident.correlation,
    ).toEqual({ rootCorrelationId: "selected-health-request", childCorrelationIds: [] });
  });
});
