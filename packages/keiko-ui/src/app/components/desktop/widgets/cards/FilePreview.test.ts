import { describe, expect, it } from "vitest";
import { fullPreviewPath } from "./FilePreview";

describe("fullPreviewPath", () => {
  it("joins a POSIX root and a relative path with a single '/'", () => {
    expect(fullPreviewPath("/Users/me/project", "src/index.ts")).toBe(
      "/Users/me/project/src/index.ts",
    );
  });

  it("strips a single trailing slash from the root before joining", () => {
    expect(fullPreviewPath("/Users/me/project/", "src/index.ts")).toBe(
      "/Users/me/project/src/index.ts",
    );
  });

  it("strips multiple trailing separators from the root", () => {
    expect(fullPreviewPath("/Users/me/project///", "src/index.ts")).toBe(
      "/Users/me/project/src/index.ts",
    );
  });

  it("uses a backslash separator and normalizes the relative path for a Windows-style root", () => {
    expect(fullPreviewPath("C:\\Users\\me\\project", "src/index.ts")).toBe(
      "C:\\Users\\me\\project\\src\\index.ts",
    );
  });

  it("strips multiple trailing backslashes from a Windows-style root", () => {
    expect(fullPreviewPath("C:\\Users\\me\\project\\\\", "src/index.ts")).toBe(
      "C:\\Users\\me\\project\\src\\index.ts",
    );
  });

  it("treats a root containing both slash and backslash as POSIX-separated", () => {
    // fullPreviewPath only picks "\\" when the root has a backslash AND no forward slash at all.
    expect(fullPreviewPath("/mnt/c\\project", "src/index.ts")).toBe("/mnt/c\\project/src/index.ts");
  });

  // Regression for S8786: the old `/[/\\]+$/u` pattern was unanchored at the start, so a root
  // built from a long run of separators that does NOT reach the end of the string forces the
  // engine to retry the trailing-run backtrack from every position — O(n^2) in the input length.
  //
  // An all-separator root (no other content) is NOT the adversarial shape: the greedy `[/\\]+`
  // consumes to the very end of the string and `$` succeeds on the very first attempt, so it
  // completes in well under a millisecond even at tens of thousands of characters regardless of
  // which implementation runs. The true pathological shape is a long separator run immediately
  // followed by at least one non-separator character, which forces the match to fail and the
  // engine to retry the backtrack from every one of the O(n) start positions before giving up
  // (measured ~700ms for the old regex at the size used below; the rewritten plain-JS scan stays
  // in the sub-millisecond range).
  it("stays well within a tight time budget for a long separator run that does not reach the end", () => {
    const adversarialRoot = `${"/\\".repeat(20_000)}project`; // 40,000 separators, then real content
    const start = Date.now();
    const result = fullPreviewPath(adversarialRoot, "src/index.ts");
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1500);
    // The trailing "project" is not a separator, so nothing is stripped from the root.
    expect(result).toBe(`${adversarialRoot}/src/index.ts`);
  });
});
