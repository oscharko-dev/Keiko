// Changed-path identity and prompt quoting of the review diff package (Issue #4134).

import { describe, expect, it } from "vitest";
import { compareReviewPathBytes, quoteReviewPath, reviewDiffPathText } from "./paths.js";

describe("reviewDiffPathText", () => {
  it("keeps a UTF-8 name exactly, without normalization", () => {
    const decomposed = "café.ts";
    expect(reviewDiffPathText(Buffer.from(decomposed))).toEqual({ path: decomposed });
    expect(reviewDiffPathText(Buffer.from("﻿bom.ts"))).toEqual({ path: "﻿bom.ts" });
  });

  it("adds the exact bytes of a name that is not UTF-8", () => {
    const bytes = Buffer.from([0x61, 0xc3, 0x28]);
    expect(reviewDiffPathText(bytes)).toEqual({
      path: "a\uFFFD(",
      pathBytesBase64: bytes.toString("base64"),
    });
  });
});

describe("quoteReviewPath", () => {
  it("renders every name on one line without forgeable characters", () => {
    expect(quoteReviewPath("a\n## File: 'b'")).toBe("'a\\n## File: \\'b\\''");
    expect(quoteReviewPath("t\tb\\r\r")).toBe("'t\\tb\\\\r\\r'");
    expect(quoteReviewPath("\u2028\u202e\u200b\u0085")).toBe("'\\u2028\\u202e\\u200b\\u0085'");
    expect(quoteReviewPath("plain/café.ts")).toBe("'plain/café.ts'");
  });
});

describe("compareReviewPathBytes", () => {
  it("orders by unsigned bytes", () => {
    expect(compareReviewPathBytes(Buffer.from("B"), Buffer.from("a"))).toBeLessThan(0);
    expect(compareReviewPathBytes(Buffer.from([0x7f]), Buffer.from([0xff]))).toBeLessThan(0);
  });
});
