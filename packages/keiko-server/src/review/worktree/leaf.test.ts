// The review run leaf (Issue #4133): one fixed, path- and ref-safe shape on every platform,
// including Windows, whatever the run id contains.

import { describe, expect, it } from "vitest";
import { win32 } from "node:path";
import { REVIEW_RUN_LEAF_PATTERN, reviewRunLeaf } from "./leaf.js";

describe("reviewRunLeaf", () => {
  it("is deterministic, distinct per run and free of path and ref separators", () => {
    const leaves = ["run:1", "run:2", "a.b-c_d", "x".repeat(128)].map(reviewRunLeaf);
    expect(new Set(leaves).size).toBe(4);
    for (const leaf of leaves) {
      expect(leaf).toMatch(REVIEW_RUN_LEAF_PATTERN);
      expect(win32.basename(win32.join("C:\\state\\review-worktrees", leaf))).toBe(leaf);
    }
    expect(reviewRunLeaf("run:1")).toBe(reviewRunLeaf("run:1"));
  });
});
