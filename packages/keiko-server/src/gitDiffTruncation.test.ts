import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@oscharko-dev/keiko-contracts/runtime/unified-diff";
import { completeTruncatedDiffPrefix } from "./gitDiffTruncation.js";

// #4113: fixtures are literal patches; expectations are written out, never derived from the helper.
const twoFiles = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,3 @@ export const rows = [",
  "-  { id: 0, elevationM: 0 },",
  "+  { id: 0, elevationMeters: 0 },",
  "   { id: 1 },",
  "-  { id: 2, elevationM: 2 },",
  "+  { id: 2, elevationMeters: 2 },",
  "diff --git a/b.ts b/b.ts",
  "index 3333333..4444444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -4 +4 @@",
  "-old",
  "+new",
  "",
].join("\n");

function cutAfter(marker: string, extra = 0): string {
  return twoFiles.slice(0, twoFiles.indexOf(marker) + marker.length + extra);
}

describe("completeTruncatedDiffPrefix (#4113)", () => {
  it("leaves a complete patch unchanged", () => {
    expect(completeTruncatedDiffPrefix(twoFiles)).toBe(twoFiles);
  });

  it("drops the partial last line and restates the cut hunk's shown counts", () => {
    const output = completeTruncatedDiffPrefix(cutAfter("+  { id: 0, elevationMeters: 0 },\n", 4));
    expect(output).toBe(
      [
        "diff --git a/a.ts b/a.ts",
        "index 1111111..2222222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@ export const rows = [",
        "-  { id: 0, elevationM: 0 },",
        "+  { id: 0, elevationMeters: 0 },",
        "",
      ].join("\n"),
    );
    expect(() => parseUnifiedDiff(output)).not.toThrow();
  });

  it("drops a hunk header the cut left without lines and keeps the file headers", () => {
    const output = completeTruncatedDiffPrefix(cutAfter("@@ -4 +4 @@\n"));
    expect(output).toBe(twoFiles.slice(0, twoFiles.indexOf("@@ -4 +4 @@")));
  });

  it("returns output that is not a patch unchanged", () => {
    expect(completeTruncatedDiffPrefix("staged-outpu")).toBe("staged-outpu");
  });

  it("keeps a deletion-only prefix of a cut hunk", () => {
    const output = completeTruncatedDiffPrefix(cutAfter("-  { id: 0, elevationM: 0 },\n"));
    expect(output).toContain(
      "@@ -1,1 +1,0 @@ export const rows = [\n-  { id: 0, elevationM: 0 },\n",
    );
    expect(() => parseUnifiedDiff(output)).not.toThrow();
  });

  it("returns an empty diff when the cut kept no complete line", () => {
    expect(completeTruncatedDiffPrefix("diff --git a/a.ts b/a")).toBe("");
  });

  it("reconciles a cut hunk that is followed by another run's diff", () => {
    const cut = cutAfter("+  { id: 0, elevationMeters: 0 },\n");
    const joined = cut + "\n" + twoFiles.slice(twoFiles.indexOf("diff --git a/b.ts"));
    const output = completeTruncatedDiffPrefix(joined);
    expect(output).toContain("@@ -1,1 +1,1 @@ export const rows = [\n");
    expect(output).toContain("@@ -4 +4 @@\n-old\n+new\n");
    expect(() => parseUnifiedDiff(output)).not.toThrow();
  });
});
