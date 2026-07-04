import { describe, expect, it } from "vitest";
import { toPosix } from "./path-utils.js";

describe("toPosix (shared bug-investigation path normalization)", () => {
  it("converts Windows backslash separators to POSIX slashes", () => {
    expect(toPosix("src\\bug-investigation\\guard.ts")).toBe("src/bug-investigation/guard.ts");
  });

  it("leaves an already-POSIX path unchanged", () => {
    expect(toPosix("src/bug-investigation/guard.ts")).toBe("src/bug-investigation/guard.ts");
  });

  it("replaces every backslash, not just the first (global replace)", () => {
    expect(toPosix("a\\b\\c\\d")).toBe("a/b/c/d");
  });

  it("returns the empty string unchanged", () => {
    expect(toPosix("")).toBe("");
  });

  it("leaves a string with no separators unchanged", () => {
    expect(toPosix("file.ts")).toBe("file.ts");
  });
});
