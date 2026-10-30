// Pre-checkout tree scan (Issue #4133, AC4): case and Unicode-normalization collisions are refused
// from the listing alone, undecodable names are refused, and large and binary blobs are excluded.

import { describe, expect, it } from "vitest";
import type { GitReviewTreeEntry } from "@oscharko-dev/keiko-git";
import {
  preflightReviewTree,
  reviewTreeCollision,
  scanReviewTree,
  type ReviewTreeLimits,
} from "./treeScan.js";

const LIMITS: ReviewTreeLimits = {
  blobLimitBytes: 2 * 1024 * 1024,
  maxPaths: 1_000,
  maxMaterializedBytes: 10 * 1024 * 1024,
};

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
      LIMITS,
    );
    expect(scan).toEqual({
      kind: "accepted",
      materializedCount: 2,
      skippedLarge: ["big.dat"],
      skippedBinary: ["img.png"],
    });
  });

  it("refuses before checkout on a collision or an undecodable name", () => {
    expect(scanReviewTree([blob("A"), blob("a")], new Set(), LIMITS)).toEqual({
      kind: "refused",
      reason: "case-collision",
    });
    expect(scanReviewTree([blob("bad\uFFFDname")], new Set(), LIMITS)).toEqual({
      kind: "refused",
      reason: "checkout-failed",
    });
  });
});

describe("budget and malformed-tree preflight", () => {
  it("refuses a git bomb of one reused blob below the per-file limit before anything is written", () => {
    // 100 directories x 100 paths of the same 1.5 MiB blob: tiny as a pack, 15 GiB on disk.
    const bomb = Array.from({ length: 10_000 }, (_, index) =>
      blob(`d${String(Math.floor(index / 100))}/f${String(index % 100)}`, 1_572_864),
    );
    expect(preflightReviewTree(bomb, { ...LIMITS, maxPaths: 100_000 })).toBe("tree-too-large");
    expect(preflightReviewTree(bomb.slice(0, 6), LIMITS)).toBeUndefined();
  });

  it("counts every path of a reused blob, ignores excluded oversized blobs, and caps paths", () => {
    expect(
      preflightReviewTree([blob("a", 6 * 1024 * 1024), blob("b", 6 * 1024 * 1024)], {
        ...LIMITS,
        blobLimitBytes: 8 * 1024 * 1024,
      }),
    ).toBe("tree-too-large");
    expect(preflightReviewTree([blob("huge", 3_000_000_000)], LIMITS)).toBeUndefined();
    const many = Array.from({ length: 1_001 }, (_, index) => blob(`f${String(index)}`, 1));
    expect(preflightReviewTree(many, LIMITS)).toBe("tree-too-large");
  });

  it("refuses duplicate paths, which a malformed tree could use to replace a skipped entry", () => {
    expect(preflightReviewTree([blob("x", 6), blob("x", 3_000_000)], LIMITS)).toBe(
      "checkout-failed",
    );
  });
});
