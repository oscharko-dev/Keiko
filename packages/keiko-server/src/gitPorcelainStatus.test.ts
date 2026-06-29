import { describe, expect, it } from "vitest";
import { parsePorcelainV2Branch } from "./gitPorcelainStatus.js";

// Porcelain v2 records are NUL-separated under `-z`; helper joins them with the trailing NUL git emits.
function porcelain(records: readonly string[]): string {
  return records.join("\0") + "\0";
}

describe("parsePorcelainV2Branch", () => {
  it("parses a clean branch with upstream and ahead/behind", () => {
    const result = parsePorcelainV2Branch(
      porcelain([
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
      ]),
    );

    expect(result).toMatchObject({
      branch: "main",
      detached: false,
      upstream: { ref: "origin/main", remote: "origin", branch: "main" },
      ahead: 2,
      behind: 3,
      dirty: false,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
    });
  });

  it("reports a detached HEAD with no branch name", () => {
    const result = parsePorcelainV2Branch(
      porcelain(["# branch.head (detached)", "# branch.ab +0 -0"]),
    );

    expect(result.detached).toBe(true);
    expect(result.branch).toBeUndefined();
  });

  it("omits upstream and zeroes ahead/behind when there is no tracking branch", () => {
    const result = parsePorcelainV2Branch(porcelain(["# branch.head feature"]));

    expect(result.upstream).toBeUndefined();
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });

  it("counts staged, unstaged, untracked, and conflicted change records", () => {
    const result = parsePorcelainV2Branch(
      porcelain([
        "# branch.head main",
        "1 M. N... 100644 100644 100644 aaa bbb src/staged.ts",
        "1 .M N... 100644 100644 100644 ccc ddd src/dirty.ts",
        "u UU N... 100644 100644 100644 100644 eee fff ggg src/conflict.ts",
        "? src/new.ts",
      ]),
    );

    expect(result).toMatchObject({
      dirty: true,
      stagedCount: 1,
      unstagedCount: 1,
      conflictedCount: 1,
      untrackedCount: 1,
    });
  });

  it("counts a record that is both staged and unstaged in both buckets", () => {
    const result = parsePorcelainV2Branch(
      porcelain(["# branch.head main", "1 MM N... 100644 100644 100644 aaa bbb src/both.ts"]),
    );

    expect(result.stagedCount).toBe(1);
    expect(result.unstagedCount).toBe(1);
  });

  it("skips the extra NUL-separated original path of a rename record", () => {
    // The original-path field is crafted to look like an untracked record (`? `) so that a mutation
    // dropping the skip would over-count untracked entries and fail this assertion.
    const result = parsePorcelainV2Branch(
      porcelain([
        "# branch.head main",
        "2 R. N... 100644 100644 100644 aaa bbb R100 src/new-name.ts",
        "? src/old-name.ts",
        "? src/new.ts",
      ]),
    );

    expect(result.stagedCount).toBe(1);
    expect(result.untrackedCount).toBe(1);
    expect(result.dirty).toBe(true);
  });

  it("treats an empty porcelain payload as a clean worktree", () => {
    const result = parsePorcelainV2Branch(porcelain(["# branch.head main"]));

    expect(result.dirty).toBe(false);
    expect(result.stagedCount).toBe(0);
  });

  it("keeps the raw upstream ref when it has no remote/branch separator", () => {
    const result = parsePorcelainV2Branch(
      porcelain(["# branch.head main", "# branch.upstream weirdref"]),
    );

    expect(result.upstream).toEqual({ ref: "weirdref" });
  });
});
