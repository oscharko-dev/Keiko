import { describe, expect, it } from "vitest";

import {
  LARGE_FILE_DEGRADED_BYTES,
  LARGE_FILE_DEGRADED_LINES,
  deriveLargeFileMode,
  exceedsLineCount,
  isLargeFileDegraded,
} from "./large-file-mode.js";

describe("deriveLargeFileMode (Issue #1207, ADR-0042 D3.6)", () => {
  it("treats a small buffer as normal", () => {
    expect(deriveLargeFileMode({ sizeBytes: 10_000, text: "const x = 1;\n" })).toBe("normal");
    expect(isLargeFileDegraded({ sizeBytes: 10_000, text: "const x = 1;\n" })).toBe(false);
  });

  it("degrades strictly above the 500 KB byte threshold, not at it", () => {
    expect(deriveLargeFileMode({ sizeBytes: LARGE_FILE_DEGRADED_BYTES, text: "" })).toBe("normal");
    expect(deriveLargeFileMode({ sizeBytes: LARGE_FILE_DEGRADED_BYTES + 1, text: "" })).toBe(
      "degraded",
    );
  });

  it("degrades strictly above the 10,000-line threshold, not at it", () => {
    const atLimit = "x\n".repeat(LARGE_FILE_DEGRADED_LINES - 1) + "x"; // exactly 10,000 lines
    const overLimit = "x\n".repeat(LARGE_FILE_DEGRADED_LINES) + "x"; // 10,001 lines
    expect(deriveLargeFileMode({ sizeBytes: atLimit.length, text: atLimit })).toBe("normal");
    expect(deriveLargeFileMode({ sizeBytes: overLimit.length, text: overLimit })).toBe("degraded");
  });

  it("degrades on the byte threshold without scanning lines (short text, large size)", () => {
    // A small text but a reported size over the byte ceiling (e.g. multi-byte UTF-8) still degrades.
    expect(deriveLargeFileMode({ sizeBytes: 600_000, text: "short" })).toBe("degraded");
  });

  it("counts the published thresholds at the documented ADR-0042 values", () => {
    expect(LARGE_FILE_DEGRADED_BYTES).toBe(500_000);
    expect(LARGE_FILE_DEGRADED_LINES).toBe(10_000);
  });
});

describe("exceedsLineCount", () => {
  it("returns false for fewer than the maximum lines", () => {
    expect(exceedsLineCount("a\nb\nc", 10)).toBe(false);
  });

  it("returns false at exactly the maximum line count", () => {
    expect(exceedsLineCount("a\nb\nc", 3)).toBe(false);
  });

  it("returns true once the line count is exceeded", () => {
    expect(exceedsLineCount("a\nb\nc\nd", 3)).toBe(true);
  });

  it("handles an empty string as a single line", () => {
    expect(exceedsLineCount("", 1)).toBe(false);
  });
});
