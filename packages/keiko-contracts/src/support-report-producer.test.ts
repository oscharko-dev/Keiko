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

import * as publicSupportProducer from "@oscharko-dev/keiko-contracts/runtime/observability";

describe("actual limited support producer public preservation", () => {
  it("keeps the actual producer's closed insufficiency and unavailable facts", () => {
    const result = publicSupportProducer.clientOnlySupportReportSections(
      input("selected-health-request"),
    );
    expect(publicSupportProducer.parseSupportIncidentPrivateProjection(result.incident)).toBe(
      result.incident,
    );
    expect(result.incident.clientReport?.serverEvidence).toBe("unavailable");
    expect(result.incident.sufficiencyStatus).toBe("insufficient");
    expect(result.selection.requiredBytes).toBe(0);
    expect(result.evidence.recordCount).toBe(0);
    expect(result.evidence.encoding).toBe("deflate-base64");
    expect(result.incident.correlation.rootCorrelationId).toBe("selected-health-request");
  });
});

import { isClientReportFailure as sourceClientReportFailure } from "./support-incident.js";

describe("closed browser context physical membership", () => {
  for (const [surface, admit] of [
    ["source", sourceClientReportFailure],
    ["public", publicSupportProducer.isClientReportFailure],
  ] as const) {
    it(`${surface}: refuses a foreign context hidden behind caller traversal`, () => {
      const context = Object.assign(["foreign-context"], { every: () => true });
      expect(admit({ errorKind: "internal", context })).toBe(false);
    });
    it(`${surface}: preserves healthy browser context facts`, () => {
      const context = ["kind:window-error"];
      expect(admit({ errorKind: "internal", context })).toBe(true);
    });
  }
});
