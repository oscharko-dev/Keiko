import { afterEach, describe, expect, it, vi } from "vitest";

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

// #4436: Knowledge Pod scope globs follow the shared workspace path-case rule.
describe("glob letter case", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches every case spelling under the case-insensitive rule", () => {
    const g = compileGlob("**/*.pdf", "case-insensitive");
    expect(matchesGlob(g, "Scans/SCAN.PDF")).toBe(true);
    expect(matchesGlob(g, "scan.pdf")).toBe(true);
    expect(matchesGlob(g, "scan.pdfx")).toBe(false);
    // Folding adds no wildcard: metacharacters stay literal and `*` still stops at `/`.
    const literal = compileGlob("Notes(1)+.MD", "case-insensitive");
    expect(matchesGlob(literal, "notes(1)+.md")).toBe(true);
    expect(matchesGlob(literal, "notes1.md")).toBe(false);
    expect(matchesGlob(compileGlob("*.MD", "case-insensitive"), "a/b.md")).toBe(false);
  });

  it("keeps exact case under the case-sensitive rule", () => {
    const g = compileGlob("**/*.pdf", "case-sensitive");
    expect(matchesGlob(g, "Scans/SCAN.PDF")).toBe(false);
    expect(matchesGlob(g, "Scans/scan.pdf")).toBe(true);
  });

  it("defaults to the platform rule for single globs and lists", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(matchesGlob(compileGlob("*.pdf"), "SCAN.PDF")).toBe(true);
    expect(matchesAny(compileGlobList(["*.pdf"]), "SCAN.PDF", false)).toBe(true);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(matchesGlob(compileGlob("*.pdf"), "SCAN.PDF")).toBe(false);
    expect(matchesAny(compileGlobList(["*.pdf"]), "SCAN.PDF", false)).toBe(false);
  });
});
