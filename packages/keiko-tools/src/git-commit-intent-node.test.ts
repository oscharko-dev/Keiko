// Unit coverage for the commit-intent change summarizer (Issue #475). Pure mapping from staged paths
// to the content-free GitCommitChangeSummary the keiko-contracts analyzer consumes.

import { describe, expect, it } from "vitest";
import { MAX_COMMIT_SUMMARY_AREAS, summarizeStagedChangeset } from "./git-commit-intent-node.js";

describe("summarizeStagedChangeset", () => {
  it("counts staged files and distinct top-level areas", () => {
    const summary = summarizeStagedChangeset([
      "packages/keiko-ui/src/a.tsx",
      "packages/keiko-server/src/b.ts",
      "docs/adr/ADR-0062.md",
    ]);
    expect(summary.stagedFileCount).toBe(3);
    expect(summary.areaCount).toBe(2); // "packages" + "docs"
    expect([...summary.areas].sort()).toEqual(["docs", "packages"]);
    expect(summary.touchesTests).toBe(false);
  });

  it("treats a single-area changeset as not mixed-scope downstream (areaCount 1)", () => {
    const summary = summarizeStagedChangeset(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(summary.areaCount).toBe(1);
    expect(summary.areas).toEqual(["src"]);
  });

  it("detects test files via __tests__ dirs and .test/.spec suffixes", () => {
    expect(summarizeStagedChangeset(["src/a.test.ts"]).touchesTests).toBe(true);
    expect(summarizeStagedChangeset(["src/__tests__/a.ts"]).touchesTests).toBe(true);
    expect(summarizeStagedChangeset(["src/a.spec.tsx"]).touchesTests).toBe(true);
    expect(summarizeStagedChangeset(["src/a.ts"]).touchesTests).toBe(false);
  });

  it("maps a root-level file to the (root) sentinel area", () => {
    const summary = summarizeStagedChangeset(["README.md", "./package.json"]);
    expect(summary.areas).toEqual(["(root)"]);
    expect(summary.areaCount).toBe(1);
  });

  it("ignores empty path entries", () => {
    const summary = summarizeStagedChangeset(["", "src/a.ts", ""]);
    expect(summary.stagedFileCount).toBe(1);
    expect(summary.areaCount).toBe(1);
  });

  it("caps the carried area tokens at MAX_COMMIT_SUMMARY_AREAS but keeps the true count", () => {
    const paths = Array.from(
      { length: MAX_COMMIT_SUMMARY_AREAS + 5 },
      (_v, i) => `area${String(i)}/f.ts`,
    );
    const summary = summarizeStagedChangeset(paths);
    expect(summary.areaCount).toBe(MAX_COMMIT_SUMMARY_AREAS + 5);
    expect(summary.areas).toHaveLength(MAX_COMMIT_SUMMARY_AREAS);
  });

  it("is deterministic for identical input", () => {
    const paths = ["packages/x/a.ts", "docs/b.md"];
    expect(summarizeStagedChangeset(paths)).toEqual(summarizeStagedChangeset(paths));
  });
});
