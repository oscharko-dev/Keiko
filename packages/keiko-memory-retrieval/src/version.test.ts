import { describe, expect, it } from "vitest";

import { KEIKO_MEMORY_RETRIEVAL_VERSION } from "./version.js";

describe("KEIKO_MEMORY_RETRIEVAL_VERSION", () => {
  it("is the pinned literal 0.2.15-beta.0", () => {
    expect(KEIKO_MEMORY_RETRIEVAL_VERSION).toBe("0.2.15-beta.0");
  });

  it("has a semver-shaped value", () => {
    // Non-capturing groups keep the regex linear-time; no alternation backtracking risk.
    expect(KEIKO_MEMORY_RETRIEVAL_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  });
});
