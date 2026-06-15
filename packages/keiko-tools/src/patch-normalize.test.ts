import { describe, expect, it } from "vitest";
import { normalizeUnifiedDiffHunks } from "./patch-normalize.js";

describe("normalizeUnifiedDiffHunks", () => {
  it("rewrites stale hunk counts from the body", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,99 +1,99 @@\n keep\n-old\n+new\n";
    const out = normalizeUnifiedDiffHunks(diff);
    expect(out).toContain("@@ -1,2 +1,2 @@");
  });

  it("promotes blank context lines between body lines to space-prefixed lines", () => {
    // A blank "" line sandwiched between body lines should become " " (context marker).
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@\n keep\n\n keep\n+add\n";
    const out = normalizeUnifiedDiffHunks(diff);
    expect(out).toContain(" keep\n \n keep");
  });

  it("does not promote a leading blank line that has no body line before it", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n\n-old\n+new\n";
    const out = normalizeUnifiedDiffHunks(diff);
    // The first blank has no body line before it, so it must stay blank ("") and NOT be promoted
    // to a " " context marker. Assert directly on the header→body boundary (the bare header line
    // itself legitimately starts with a space, so a /^ /m scan would false-positive on it).
    expect(out).toContain("@@ -1,1 +1,1 @@\n\n-old");
    expect(out).not.toContain("@@ -1,1 +1,1 @@\n \n-old");
  });

  it("does not promote a trailing blank line that has no body line after it", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n\n";
    const out = normalizeUnifiedDiffHunks(diff);
    // Trailing blank has no body line after it, so it must NOT become " ".
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("leaves a diff with no @@ marker unchanged", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\nsome preamble\n";
    expect(normalizeUnifiedDiffHunks(diff)).toBe(diff);
  });

  it("handles multiple hunks independently", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d\n";
    const out = normalizeUnifiedDiffHunks(diff);
    expect(out).toContain("@@ -1,1 +1,1 @@");
    expect(out).toContain("@@ -10,1 +10,1 @@");
  });

  // RED (before fix): O(n²) impl allocates slice(0,i) + slice(i+1) per blank line.
  // With N=10_000 blank lines that is ~100M iterations and the test exceeds 5 s.
  // GREEN (after fix): single forward+backward O(n) scan finishes in <100 ms.
  it("completes a hunk with 10 000 blank context lines within 1 second (O(n) guard)", () => {
    const body = ["-remove", ...Array.from({ length: 10_000 }, () => ""), "+add"].join("\n");
    const diff = `--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n${body}\n`;
    const start = performance.now();
    normalizeUnifiedDiffHunks(diff);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });
});
