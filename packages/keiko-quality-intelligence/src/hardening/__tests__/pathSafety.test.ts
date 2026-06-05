// Adversarial coverage for `isSafeRelativePath` (Issue #284).
//
// Each rejection branch in `pathSafety.ts` has at least one negative case, and
// realistic safe paths have positive cases. No IO; the predicate is pure.

import { describe, expect, it } from "vitest";

import { MAX_SAFE_RELATIVE_PATH_LENGTH, isSafeRelativePath } from "../pathSafety.js";

describe("isSafeRelativePath — accepts safe relative paths", () => {
  const cases: readonly string[] = [
    "a",
    "src/index.ts",
    "src/domain/intentDerivation.ts",
    "deeply/nested/relative/path/to/file.md",
    "with-hyphens_and_underscores.json",
    "file.with.many.dots.txt",
    "unicode/тест/файл.md",
    "scoped/@org/package-name.ts",
  ];

  for (const value of cases) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      expect(isSafeRelativePath(value)).toBe(true);
    });
  }
});

describe("isSafeRelativePath — rejects each forbidden pattern", () => {
  it("rejects an empty string", () => {
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("rejects a non-string (defensive)", () => {
    // Forced cast: callers may pass an untrusted value typed `string` whose
    // runtime shape is unknown. The predicate must still return false.
    expect(isSafeRelativePath(123 as unknown as string)).toBe(false);
    expect(isSafeRelativePath(null as unknown as string)).toBe(false);
    expect(isSafeRelativePath(undefined as unknown as string)).toBe(false);
  });

  it("rejects `..` as a sole segment", () => {
    expect(isSafeRelativePath("..")).toBe(false);
  });

  it("rejects a leading `../` segment", () => {
    expect(isSafeRelativePath("../etc/passwd")).toBe(false);
  });

  it("rejects an embedded `/../` segment", () => {
    expect(isSafeRelativePath("a/../b")).toBe(false);
  });

  it("rejects a trailing `/..` segment", () => {
    expect(isSafeRelativePath("a/b/..")).toBe(false);
  });

  it("rejects a Windows-style `..\\` segment", () => {
    expect(isSafeRelativePath("..\\windows\\system32")).toBe(false);
  });

  it("rejects an embedded `\\..\\` segment", () => {
    expect(isSafeRelativePath("a\\..\\b")).toBe(false);
  });

  it("rejects a null byte", () => {
    expect(isSafeRelativePath("a/b\0c")).toBe(false);
  });

  it("rejects a C0 control character (TAB)", () => {
    expect(isSafeRelativePath("a/\t/b")).toBe(false);
  });

  it("rejects a C0 control character (LF)", () => {
    expect(isSafeRelativePath("a/\n/b")).toBe(false);
  });

  it("rejects DEL (0x7F)", () => {
    expect(isSafeRelativePath("a/\x7f/b")).toBe(false);
  });

  it("rejects a C1 control character (0x9B CSI)", () => {
    const c1 = String.fromCharCode(0x9b);
    expect(isSafeRelativePath(`a/${c1}/b`)).toBe(false);
  });

  it("rejects POSIX absolute path", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
  });

  it("rejects Windows root path", () => {
    expect(isSafeRelativePath("\\Windows\\System32")).toBe(false);
  });

  it("rejects Windows drive letter", () => {
    expect(isSafeRelativePath("C:\\Windows")).toBe(false);
  });

  it("rejects scheme-prefixed string", () => {
    expect(isSafeRelativePath("file:///etc/passwd")).toBe(false);
  });

  it("rejects NTFS alternate data stream", () => {
    expect(isSafeRelativePath("file.txt:hidden")).toBe(false);
  });

  it("accepts exactly the max length", () => {
    const value = "a".repeat(MAX_SAFE_RELATIVE_PATH_LENGTH);
    expect(isSafeRelativePath(value)).toBe(true);
  });

  it("rejects one over the max length", () => {
    const value = "a".repeat(MAX_SAFE_RELATIVE_PATH_LENGTH + 1);
    expect(isSafeRelativePath(value)).toBe(false);
  });

  it("does NOT mistake `..` substring inside a filename for a traversal segment", () => {
    expect(isSafeRelativePath("file..name.txt")).toBe(true);
  });

  it("does NOT mistake `.` as a standalone segment for traversal", () => {
    expect(isSafeRelativePath("./relative")).toBe(true);
  });
});
