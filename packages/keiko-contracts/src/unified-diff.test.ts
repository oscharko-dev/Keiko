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
