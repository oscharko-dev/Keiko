import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./patch-parse.js";

describe("parseUnifiedDiff", () => {
  it("parses a modify with explicit hunk counts", () => {
    const diff = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
    const { files } = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/x.ts");
    expect(files[0]?.kind).toBe("modify");
    expect(files[0]?.addedLines).toBe(1);
    expect(files[0]?.removedLines).toBe(1);
    expect(files[0]?.hunks).toHaveLength(1);
  });

  it("classifies a create from /dev/null", () => {
    const { files } = parseUnifiedDiff("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+line\n");
    expect(files[0]?.kind).toBe("create");
    expect(files[0]?.path).toBe("new.ts");
  });

  it("classifies a delete to /dev/null", () => {
    const { files } = parseUnifiedDiff("--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-line\n");
    expect(files[0]?.kind).toBe("delete");
    expect(files[0]?.path).toBe("gone.ts");
  });

  it("parses multiple files in one diff", () => {
    const diff =
      "--- a/one.ts\n+++ b/one.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n" +
      "--- a/two.ts\n+++ b/two.ts\n@@ -1,1 +1,1 @@\n-c\n+d\n";
    expect(parseUnifiedDiff(diff).files).toHaveLength(2);
  });

  it("defaults the omitted hunk count to 1", () => {
    const { files } = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    expect(files[0]?.hunks[0]?.oldLines).toBe(1);
    expect(files[0]?.hunks[0]?.newLines).toBe(1);
  });

  it("ignores a trailing blank line (no phantom context line)", () => {
    const { files } = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n");
    expect(files[0]?.hunks[0]?.lines).toEqual(["-a", "+b"]);
  });

  it("strips a tab-delimited timestamp from the header path", () => {
    const { files } = parseUnifiedDiff(
      "--- a/x.ts\t2024-01-01\n+++ b/x.ts\t2024-01-02\n@@ -1,1 +1,1 @@\n-a\n+b\n",
    );
    expect(files[0]?.path).toBe("x.ts");
  });

  it("throws PatchParseError on a malformed hunk header", () => {
    expect(() => parseUnifiedDiff("--- a/x\n+++ b/x\n@@ not a header @@\n+y\n")).toThrow();
  });

  it("throws when a hunk body has fewer lines than its header declares", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n";
    expect(() => parseUnifiedDiff(diff)).toThrow(/fewer lines/);
  });

  it("throws when a hunk body has more lines than its header declares", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n+extra\n";
    expect(() => parseUnifiedDiff(diff)).toThrow(/more lines/);
  });

  it("treats body lines beginning '-- '/'++ ' as hunk content, not a new file header (C6)", () => {
    // The added line renders as `+-- dashes` and the removed as `--- text`/`+++ text`. With a
    // hunk line-count budget, these stay BODY until the hunk is consumed.
    const diff =
      "--- a/doc.md\n" +
      "+++ b/doc.md\n" +
      "@@ -1,2 +1,2 @@\n" +
      " context\n" +
      "--- removed dashes\n" +
      "+++ added dashes\n";
    const { files } = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("doc.md");
    expect(files[0]?.kind).toBe("modify");
    // Lines are stored verbatim WITH the leading marker; content here begins "-- "/"++ ".
    const lines = files[0]?.hunks[0]?.lines ?? [];
    expect(lines).toEqual([" context", "--- removed dashes", "+++ added dashes"]);
    expect(files[0]?.addedLines).toBe(1);
    expect(files[0]?.removedLines).toBe(1);
  });

  it("accepts a NEW file header only after the prior hunk's budget is consumed (C6)", () => {
    const diff =
      "--- a/one.md\n" +
      "+++ b/one.md\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-- old\n" +
      "++ new\n" +
      "--- a/two.md\n" +
      "+++ b/two.md\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-x\n" +
      "+y\n";
    const { files } = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["one.md", "two.md"]);
    expect(files[0]?.hunks[0]?.lines).toEqual(["-- old", "++ new"]);
  });
});
