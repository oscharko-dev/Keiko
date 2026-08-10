import { describe, expect, it } from "vitest";

import { createRequire } from "node:module";

import { KEIKO_MEMORY_RETRIEVAL_VERSION } from "./version.js";

// The packaged manifest owns the version; a literal here re-states it and goes
// stale on every release cut (KfQ findings on #3055).
const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

describe("KEIKO_MEMORY_RETRIEVAL_VERSION", () => {
  it("is the pinned literal 0.3.1", () => {
    expect(KEIKO_MEMORY_RETRIEVAL_VERSION).toBe(packageVersion);
  });

  it("has a semver-shaped value", () => {
    // Non-capturing groups keep the regex linear-time; no alternation backtracking risk.
    expect(KEIKO_MEMORY_RETRIEVAL_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  });
});
