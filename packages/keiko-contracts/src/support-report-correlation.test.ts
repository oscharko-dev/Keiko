import { describe, expect, it } from "vitest";
import { ACTIVITY_LOG_UNKNOWN_CORRELATION_ID } from "./observability.js";
import { normalizeSupportReportCorrelationId } from "./support-report-correlation.js";

describe("normalizeSupportReportCorrelationId", () => {
  it("keeps a reportable failure reference", () => {
    expect(normalizeSupportReportCorrelationId("corr-0123456789")).toBe("corr-0123456789");
  });

  it.each([
    ["a missing value", undefined],
    ["a non-string value", 42],
    ["an empty value", ""],
    ["the transport sentinel", ACTIVITY_LOG_UNKNOWN_CORRELATION_ID],
    ["a credential shape", `sk-${"a".repeat(24)}`],
    ["an email address", ["someone", "example.com"].join("@")],
    ["a lowercase IBAN", "de89370400440532013000"],
  ])("refuses %s", (_label, value) => {
    expect(normalizeSupportReportCorrelationId(value)).toBeUndefined();
  });
});
