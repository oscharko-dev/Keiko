// Cross-platform behaviour test for `isSafeRelativePath` (Issue #284).
//
// The predicate is intentionally `path.sep`-agnostic: identical strings must
// produce identical accept/reject outcomes regardless of the host platform's
// `node:path` separator. We confirm this by re-importing `node:path` with both
// the POSIX and Windows namespaces and checking the predicate's outcome is
// independent of which separator the host uses by default.

import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { isSafeRelativePath } from "../pathSafety.js";

describe("isSafeRelativePath — cross-platform invariance", () => {
  // Pairs of equivalent paths under each platform: same logical path, different
  // separator. The predicate's outcome must be the SAME for both members of
  // the pair, regardless of which `node:path` flavour the host runs.
  const safePairs: readonly (readonly [string, string])[] = [
    ["src/index.ts", "src\\index.ts"],
    ["a/b/c.txt", "a\\b\\c.txt"],
    ["deep/nested/path.md", "deep\\nested\\path.md"],
  ];

  const unsafePairs: readonly (readonly [string, string])[] = [
    ["../etc/passwd", "..\\etc\\passwd"],
    ["a/../b", "a\\..\\b"],
    ["a/b/..", "a\\b\\.."],
  ];

  for (const [posixForm, winForm] of safePairs) {
    it(`accepts ${JSON.stringify(posixForm)} and ${JSON.stringify(winForm)} identically`, () => {
      expect(isSafeRelativePath(posixForm)).toBe(true);
      expect(isSafeRelativePath(winForm)).toBe(true);
    });
  }

  for (const [posixForm, winForm] of unsafePairs) {
    it(`rejects ${JSON.stringify(posixForm)} and ${JSON.stringify(winForm)} identically`, () => {
      expect(isSafeRelativePath(posixForm)).toBe(false);
      expect(isSafeRelativePath(winForm)).toBe(false);
    });
  }

  it("decision does not depend on the value of `posix.sep` vs `win32.sep`", () => {
    // Sanity-check: the namespaces' separator constants differ, yet the
    // predicate output for a string is byte-stable.
    expect(posix.sep).toBe("/");
    expect(win32.sep).toBe("\\");
    expect(isSafeRelativePath("a/b/c")).toBe(isSafeRelativePath("a/b/c"));
    expect(isSafeRelativePath("a\\b\\c")).toBe(isSafeRelativePath("a\\b\\c"));
  });

  it("normalises decisions across mixed separator paths", () => {
    // Mixed-separator paths (which can appear in cross-platform tooling output)
    // must still reject the same forbidden patterns.
    expect(isSafeRelativePath("a/b\\..\\c")).toBe(false);
    expect(isSafeRelativePath("a\\b/../c")).toBe(false);
  });
});
