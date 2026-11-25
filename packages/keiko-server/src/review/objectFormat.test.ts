import { describe, expect, it } from "vitest";

import { reviewObjectFormat } from "./objectFormat.js";

describe("reviewObjectFormat", () => {
  it("names SHA-1 for a 40-digit id and SHA-256 for a 64-digit id", () => {
    expect(reviewObjectFormat("a".repeat(40))).toBe("sha1");
    expect(reviewObjectFormat("b".repeat(64))).toBe("sha256");
  });
});
