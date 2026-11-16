import { describe, expect, it, vi } from "vitest";
import { parseUnifiedDiff, PatchParseError, type UnifiedDiffFileSource } from "./unified-diff.js";

describe("unified diff source observations", () => {
  it.each(["\n", "\r\n"])("retains exact UTF16 source ranges with %j endings", (eol) => {
    const text = [
      "😀 preamble",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@ public context",
      "--- removed",
      "+new",
      "\\ No newline at end of file",
      "",
      "tail",
    ].join(eol);
    let observed: readonly UnifiedDiffFileSource[] = [];
    const plain = parseUnifiedDiff(text);
    const result = parseUnifiedDiff(text, (files) => {
      observed = files;
    });
    expect(result).toEqual(plain);
    expect(observed).toHaveLength(1);
    const file = observed[0];
    expect(file?.oldPath).toBe("x.ts");
    const hunk = file?.hunks[0];
    expect(hunk?.hunk).toBe(result.files[0]?.hunks[0]);
    expect(hunk?.lines.map((line) => text.slice(line.start, line.end))).toEqual([
      "--- removed" + eol,
      "+new" + eol,
      "\\ No newline at end of file" + eol,
    ]);
    expect(text.slice(hunk?.contextStart, hunk?.header.end)).toBe(" public context" + eol);
    expect(text.slice(file?.oldHeader.start, file?.oldHeader.end)).toBe("--- a/x.ts" + eol);
  });

  it("publishes no partial observation when a later hunk is malformed", () => {
    const observe = vi.fn();
    expect(() =>
      parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ bad", observe),
    ).toThrow(PatchParseError);
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not grant ownership to incomplete or header-only files", () => {
    const observe = vi.fn();
    parseUnifiedDiff("--- a/x\n+++ b/x\n--- a/incomplete", observe);
    expect(observe).toHaveBeenCalledExactlyOnceWith([]);
  });
});

describe("a format-patch signature after the last hunk", () => {
  const HUNK = "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";

  it.each(["-- \n2.40.0\n", "--\n2.40.0\n"])(
    "ends the patch at %j, not at an extra line",
    (tail) => {
      const parsed = parseUnifiedDiff(`${HUNK}${tail}`);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0]).toMatchObject({ path: "x.txt", addedLines: 1, removedLines: 1 });
    },
  );

  it("still rejects a genuine extra removed line once the hunk budget is spent", () => {
    expect(() => parseUnifiedDiff(`${HUNK}-extra\n`)).toThrow(PatchParseError);
  });
});

// #4271 property testing: each of these shapes used to parse without an error and silently lose a
// change, so a patch tool applied the rest of the patch as if it were complete.
describe("malformed patches that would lose a change", () => {
  it("refuses hunks of a file whose +++ line is missing instead of applying the other files", () => {
    const diff = [
      "--- a/x",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/y",
      "+++ b/y",
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    expect(() => parseUnifiedDiff(diff)).toThrow(/file header has no \+\+\+ line/u);
  });

  it("still ignores a lone --- line that no hunk follows", () => {
    expect(
      parseUnifiedDiff("--- notes\nprose\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n").files,
    ).toHaveLength(1);
  });

  it("refuses a change line after the +++ header that no hunk header opened", () => {
    expect(() => parseUnifiedDiff("--- a/x\n+++ b/x\n-a\n+b\n")).toThrow(
      /body line outside a hunk/u,
    );
  });

  it("still ignores prose after a finished hunk, such as a Markdown list", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\n- a note\n+ another\n";
    expect(parseUnifiedDiff(diff).files[0]?.hunks[0]?.lines).toEqual(["-a", "+b"]);
  });

  it("refuses a hunk header number a JavaScript number cannot hold exactly", () => {
    expect(() =>
      parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -99999999999999999999 +1 @@\n-a\n+b\n"),
    ).toThrow(/hunk header number out of range/u);
  });
});
