import { describe, expect, it } from "vitest";
import {
  costClassLabel,
  formatBytes,
  formatDate,
  formatMs,
  formatTokens,
  outcomeLabel,
  runStatusLabel,
  toDateString,
  verificationStatusLabel,
} from "./format";

describe("format presenters", () => {
  it("formats byte and token counts for compact UI badges", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1550)).toBe("1.6k");
  });

  it("formats durations across millisecond, second and minute ranges", () => {
    expect(formatMs(999)).toBe("999 ms");
    expect(formatMs(12_345)).toBe("12.3 s");
    expect(formatMs(125_000)).toBe("2m 5s");
  });

  it("maps enum-like backend status values to user-facing labels", () => {
    expect(costClassLabel("low")).toBe("Low cost");
    expect(costClassLabel("medium")).toBe("Medium cost");
    expect(costClassLabel("high")).toBe("High cost");
    expect(costClassLabel("unknown")).toBe("Unknown cost");

    expect(runStatusLabel("dry-run")).toBe("Dry run");
    expect(runStatusLabel("fix-applied")).toBe("Fix applied");
    expect(runStatusLabel("investigation-only")).toBe("Investigation only");

    expect(verificationStatusLabel("timed-out")).toBe("Timed out");
    expect(verificationStatusLabel("resource-exceeded")).toBe("Resource exceeded");
    expect(verificationStatusLabel("cancelled")).toBe("Cancelled");
  });

  it("derives local display dates and stable UTC date keys", () => {
    const value = Date.parse("2026-06-15T23:30:00Z");

    expect(formatDate(value)).toContain("2026");
    expect(toDateString(value)).toBe("2026-06-15");
    expect(toDateString("2026-06-16T01:00:00+02:00")).toBe("2026-06-15");
  });

  it("maps known outcomes and keeps unknown outcomes readable", () => {
    expect(outcomeLabel("fix-proposed")).toBe("Fix proposed (dry-run)");
    expect(outcomeLabel("limit-exceeded")).toBe("Limit exceeded");
    expect(outcomeLabel("custom-outcome")).toBe("Custom-outcome");
  });
});
