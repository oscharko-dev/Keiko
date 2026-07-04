import { describe, expect, it } from "vitest";
import {
  costClassLabel,
  formatBytes,
  formatBytesPrecise,
  formatDate,
  formatDurationCompact,
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
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1550)).toBe("1.6k");
  });

  it("guards formatBytes against zero, negative and non-finite inputs", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("formats bytes with higher precision for file size chips", () => {
    // Two decimals below magnitude 10; one at or above.
    expect(formatBytesPrecise(1024)).toBe("1.00 KB");
    expect(formatBytesPrecise(1536)).toBe("1.50 KB");
    expect(formatBytesPrecise(11 * 1024)).toBe("11.0 KB");
    expect(formatBytesPrecise(18)).toBe("18 B");
    expect(formatBytesPrecise(1024 ** 3)).toBe("1.00 GB");
    expect(formatBytesPrecise(0)).toBe("0 B");
    expect(formatBytesPrecise(-5)).toBe("0 B");
    expect(formatBytesPrecise(Number.NaN)).toBe("0 B");
  });

  it("formats durations across millisecond, second and minute ranges", () => {
    expect(formatMs(999)).toBe("999 ms");
    expect(formatMs(12_345)).toBe("12.3 s");
    expect(formatMs(125_000)).toBe("2m 5s");
  });

  it("formats compact whole-second durations with zero-padded minutes", () => {
    expect(formatDurationCompact(0)).toBe("0s");
    expect(formatDurationCompact(-5)).toBe("0s");
    expect(formatDurationCompact(Number.NaN)).toBe("0s");
    expect(formatDurationCompact(999)).toBe("1s");
    expect(formatDurationCompact(30_000)).toBe("30s");
    expect(formatDurationCompact(59_999)).toBe("1m 00s");
    expect(formatDurationCompact(65_000)).toBe("1m 05s");
    expect(formatDurationCompact(90_000)).toBe("1m 30s");
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
