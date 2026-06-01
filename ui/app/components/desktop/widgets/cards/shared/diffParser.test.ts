import { describe, expect, it } from "vitest";
import { MAX_DIFF_BYTES, parseUnifiedDiff } from "./diffParser";

// noUncheckedIndexedAccess: use non-null assertions only in tests where we've
// already asserted the array length, making the element access safe.

function assertDefined<T>(val: T | undefined, label = "value"): T {
  if (val === undefined) throw new Error(`Expected ${label} to be defined`);
  return val;
}

describe("parseUnifiedDiff", () => {
  it("returns empty result for empty input", () => {
    const result = parseUnifiedDiff("");
    expect(result).toEqual({ files: [], truncated: false, totalBytes: 0 });
  });

  it("parses a single-file diff with one hunk and advances line numbers correctly", () => {
    const raw = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,4 +10,5 @@ function foo() {",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 3;",
      "+const z = 4;",
      " return x;",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);

    const file = assertDefined(result.files[0], "file");
    expect(file.path).toBe("src/foo.ts");
    expect(file.addedLines).toBe(2);
    expect(file.removedLines).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = assertDefined(file.hunks[0], "hunk");
    expect(hunk.lines).toHaveLength(5);

    // context line: both sides advance
    expect(hunk.lines[0]).toMatchObject({ kind: "ctx", oldLine: 10, newLine: 10, text: "const x = 1;" });
    // del line: old advances, new is null
    expect(hunk.lines[1]).toMatchObject({ kind: "del", oldLine: 11, newLine: null, text: "const y = 2;" });
    // add line: old is null, new advances
    expect(hunk.lines[2]).toMatchObject({ kind: "add", oldLine: null, newLine: 11, text: "const y = 3;" });
    // second add
    expect(hunk.lines[3]).toMatchObject({ kind: "add", oldLine: null, newLine: 12, text: "const z = 4;" });
    // context after adds
    expect(hunk.lines[4]).toMatchObject({ kind: "ctx", oldLine: 12, newLine: 13, text: "return x;" });
  });

  it("parses a multi-file diff preserving order and per-file totals", () => {
    const raw = [
      "diff --git a/alpha.ts b/alpha.ts",
      "--- a/alpha.ts",
      "+++ b/alpha.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+line2",
      " line3",
      "diff --git a/beta.ts b/beta.ts",
      "--- a/beta.ts",
      "+++ b/beta.ts",
      "@@ -5,3 +5,2 @@",
      " ctx",
      "-old",
      " ctx2",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    expect(result.files).toHaveLength(2);

    const alpha = assertDefined(result.files[0], "alpha");
    expect(alpha.path).toBe("alpha.ts");
    expect(alpha.addedLines).toBe(1);
    expect(alpha.removedLines).toBe(0);

    const beta = assertDefined(result.files[1], "beta");
    expect(beta.path).toBe("beta.ts");
    expect(beta.addedLines).toBe(0);
    expect(beta.removedLines).toBe(1);
  });

  it("reflects rename in path and oldPath", () => {
    const raw = [
      "diff --git a/old.ts b/new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      " same",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    expect(result.files).toHaveLength(1);
    const file = assertDefined(result.files[0], "file");
    expect(file.path).toBe("new.ts");
    expect(file.oldPath).toBe("old.ts");
  });

  it("no-rename: oldPath is absent when a/ and b/ paths are identical", () => {
    const raw = [
      "diff --git a/same.ts b/same.ts",
      "--- a/same.ts",
      "+++ b/same.ts",
      "@@ -1 +1 @@",
      " x",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    const file = assertDefined(result.files[0], "file");
    expect(file.oldPath).toBeUndefined();
  });

  it("captures \\ No newline at end of file as a meta line with null line numbers", () => {
    const raw = [
      "diff --git a/noeol.ts b/noeol.ts",
      "--- a/noeol.ts",
      "+++ b/noeol.ts",
      "@@ -1 +1 @@",
      "-old line",
      "\\ No newline at end of file",
      "+new line",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    const hunk = assertDefined(assertDefined(result.files[0], "file").hunks[0], "hunk");
    const metaLine = hunk.lines.find((l) => l.kind === "meta");
    expect(metaLine).toBeDefined();
    expect(metaLine?.oldLine).toBeNull();
    expect(metaLine?.newLine).toBeNull();
    expect(metaLine?.text).toBe("\\ No newline at end of file");
  });

  it("preserves hunk body text that resembles file headers", () => {
    const raw = [
      "diff --git a/src/headerish.txt b/src/headerish.txt",
      "--- a/src/headerish.txt",
      "+++ b/src/headerish.txt",
      "@@ -1,3 +1,3 @@",
      "--- literal removed text",
      "+++ literal added text",
      " unchanged",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    expect(result.files).toHaveLength(1);

    const file = assertDefined(result.files[0], "file");
    expect(file.path).toBe("src/headerish.txt");
    expect(file.addedLines).toBe(1);
    expect(file.removedLines).toBe(1);

    const hunk = assertDefined(file.hunks[0], "hunk");
    expect(hunk.lines[0]).toMatchObject({ kind: "del", text: "-- literal removed text" });
    expect(hunk.lines[1]).toMatchObject({ kind: "add", text: "++ literal added text" });
    expect(hunk.lines[2]).toMatchObject({ kind: "ctx", text: "unchanged" });
  });

  it("parses hunk header without count (default 1)", () => {
    const raw = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10 +10 @@",
      " ctx",
      "+add",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    const hunk = assertDefined(assertDefined(result.files[0], "file").hunks[0], "hunk");
    // oldStart = 10, newStart = 10
    expect(hunk.lines[0]).toMatchObject({ kind: "ctx", oldLine: 10, newLine: 10 });
    expect(hunk.lines[1]).toMatchObject({ kind: "add", oldLine: null, newLine: 11 });
  });

  it("truncates oversized input and sets truncated:true without throwing", () => {
    // Build input larger than MAX_DIFF_BYTES
    const header = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,3 +1,3 @@",
      " ctx",
      "-del",
      "+add",
      "",
    ].join("\n");

    // Pad to exceed the limit with valid diff add-lines
    const padding = "+added line\n".repeat(Math.ceil((MAX_DIFF_BYTES + 1024) / "+added line\n".length));
    const raw = header + padding;

    const result = parseUnifiedDiff(raw);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBeGreaterThan(MAX_DIFF_BYTES);
    // The prefix must have parsed cleanly — no exception and files array is populated
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("mutation guard: 2 added + 1 removed reports addedLines:2 removedLines:1", () => {
    const raw = [
      "diff --git a/m.ts b/m.ts",
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -1,3 +1,4 @@",
      " ctx",
      "-del",
      "+add1",
      "+add2",
      " ctx2",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(raw);
    const file = assertDefined(result.files[0], "file");
    expect(file.addedLines).toBe(2);
    expect(file.removedLines).toBe(1);
  });
});
