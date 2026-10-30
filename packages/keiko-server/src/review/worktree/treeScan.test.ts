// Pre-checkout tree scan (Issue #4133, AC4): case and Unicode-normalization collisions are refused
// from the listing alone, undecodable names are refused, and large and binary blobs are excluded.

import { describe, expect, it } from "vitest";
import type { GitReviewTreeEntry } from "@oscharko-dev/keiko-git";
import {
  filterDriversInAttributes,
  isGitAttributesPath,
  reviewTreeCollision,
  scanReviewTree,
} from "./treeScan.js";

function blob(path: string, size = 10): GitReviewTreeEntry {
  return { mode: "100644", type: "blob", oid: "a".repeat(40), size, path };
}

describe("collision detection", () => {
  it("refuses case collisions of files and of directory prefixes", () => {
    expect(reviewTreeCollision(["README.md", "readme.md"])).toBe("case-collision");
    expect(reviewTreeCollision(["Docs/a.md", "docs/b.md"])).toBe("case-collision");
    expect(reviewTreeCollision(["src", "SRC/x"])).toBe("case-collision");
    expect(reviewTreeCollision(["stra\u00dfe", "STRASSE"])).toBe("case-collision");
  });

  it("refuses names that differ only by Unicode normalization", () => {
    expect(reviewTreeCollision(["caf\u00e9.txt", "cafe\u0301.txt"])).toBe(
      "normalization-collision",
    );
    expect(reviewTreeCollision(["d\u00e9/a", "de\u0301/b"])).toBe("normalization-collision");
  });

  it("accepts distinct names and repeated directory prefixes", () => {
    expect(
      reviewTreeCollision(["src/a.ts", "src/b.ts", "src/sub/c.ts", "README.md"]),
    ).toBeUndefined();
    expect(reviewTreeCollision([])).toBeUndefined();
  });
});

describe("scanReviewTree", () => {
  it("excludes blobs above the limit and binary blobs and counts the rest", () => {
    const scan = scanReviewTree(
      [
        blob("a.ts"),
        blob("big.dat", 3_000_000),
        blob("img.png"),
        blob("-dash"),
        {
          mode: "160000",
          type: "commit",
          oid: "b".repeat(40),
          size: undefined,
          path: "vendor/sub",
        },
      ],
      new Set(["img.png", "big.dat"]),
      2 * 1024 * 1024,
    );
    expect(scan).toEqual({
      kind: "accepted",
      materializedCount: 2,
      skippedLarge: ["big.dat"],
      skippedBinary: ["img.png"],
    });
  });

  it("refuses before checkout on a collision or an undecodable name", () => {
    expect(scanReviewTree([blob("A"), blob("a")], new Set(), 10)).toEqual({
      kind: "refused",
      reason: "case-collision",
    });
    expect(scanReviewTree([blob("bad�name")], new Set(), 10)).toEqual({
      kind: "refused",
      reason: "checkout-failed",
    });
  });
});

describe("attribute filter drivers", () => {
  it("collects filter names and ignores comments", () => {
    expect(
      filterDriversInAttributes(
        "# filter=commented\n*.bin filter=lfs diff=lfs -text\n*.x  filter=Custom.v2\r\n",
      ),
    ).toEqual(["lfs", "Custom.v2"]);
    expect(isGitAttributesPath(".gitattributes")).toBe(true);
    expect(isGitAttributesPath("sub/dir/.gitattributes")).toBe(true);
    expect(isGitAttributesPath("x.gitattributes")).toBe(false);
  });
});
