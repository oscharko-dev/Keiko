import { describe, expect, it } from "vitest";

import { compileGlob, compileGlobList, matchesAny, matchesGlob } from "./glob.js";

describe("compileGlob + matchesGlob", () => {
  it("matches a literal segment exactly", () => {
    const g = compileGlob("README.md");
    expect(matchesGlob(g, "README.md")).toBe(true);
    expect(matchesGlob(g, "docs/README.md")).toBe(false);
  });

  it("treats `*` as 'any chars except slash'", () => {
    const g = compileGlob("*.md");
    expect(matchesGlob(g, "README.md")).toBe(true);
    expect(matchesGlob(g, "docs/README.md")).toBe(false);
  });

  it("treats `**` as 'any chars including slash'", () => {
    const g = compileGlob("**/*.md");
    expect(matchesGlob(g, "README.md")).toBe(true);
    expect(matchesGlob(g, "docs/README.md")).toBe(true);
    expect(matchesGlob(g, "deep/nested/README.md")).toBe(true);
    expect(matchesGlob(g, "README.txt")).toBe(false);
  });

  it("treats a bare `**` as 'any chars including slash'", () => {
    const g = compileGlob("vendor/**");
    expect(matchesGlob(g, "vendor/lib.js")).toBe(true);
    expect(matchesGlob(g, "vendor/nested/lib.js")).toBe(true);
    expect(matchesGlob(g, "src/index.ts")).toBe(false);
  });

  it("treats `?` as a single non-slash character", () => {
    const g = compileGlob("a?.txt");
    expect(matchesGlob(g, "ab.txt")).toBe(true);
    expect(matchesGlob(g, "abc.txt")).toBe(false);
    expect(matchesGlob(g, "a/b.txt")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    const g = compileGlob("path.with+special$chars(1).md");
    expect(matchesGlob(g, "path.with+special$chars(1).md")).toBe(true);
    expect(matchesGlob(g, "pathXwith+special$chars(1).md")).toBe(false);
  });

  it("anchors at both ends", () => {
    const g = compileGlob("docs");
    expect(matchesGlob(g, "docs")).toBe(true);
    expect(matchesGlob(g, "docs/inner")).toBe(false);
    expect(matchesGlob(g, "prefix-docs")).toBe(false);
  });
});

describe("matchesAny + compileGlobList", () => {
  it("matchesAny defaults to true when the list is empty (includeGlobs semantic)", () => {
    expect(matchesAny([], "any/path.txt", true)).toBe(true);
  });

  it("matchesAny defaults to false when the list is empty (excludeGlobs semantic)", () => {
    expect(matchesAny([], "any/path.txt", false)).toBe(false);
  });

  it("matchesAny short-circuits on first match", () => {
    const globs = compileGlobList(["*.txt", "**/*.md"]);
    expect(matchesAny(globs, "README.md", false)).toBe(true);
    expect(matchesAny(globs, "binary.bin", false)).toBe(false);
  });

  it("compileGlobList returns an empty readonly array for undefined", () => {
    expect(compileGlobList(undefined)).toStrictEqual([]);
    expect(compileGlobList([])).toStrictEqual([]);
  });
});
