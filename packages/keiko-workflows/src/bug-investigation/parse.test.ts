import { describe, expect, it } from "vitest";
import { parseBugModelOutput } from "../../../src/workflows/bug-investigation/parse.js";

const FULL = [
  "```diff",
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -1 +1 @@",
  "-export const half = (n) => n / 3;",
  "+export const half = (n) => n / 2;",
  "```",
  "## Root cause",
  "The divisor was 3 instead of 2.",
  "## Regression test",
  "Add a case asserting half(10) === 5.",
  "## Uncertainty",
  "Assumes no other caller depends on the /3 behaviour.",
  "## Confidence",
  "high",
].join("\n");

describe("parseBugModelOutput (AC #9 / D9 model-output contract)", () => {
  it("extracts the fenced diff and all four prose sections", () => {
    const out = parseBugModelOutput(FULL);
    expect(out.diff).toContain("+export const half = (n) => n / 2;");
    expect(out.rootCause).toContain("divisor was 3");
    expect(out.regressionTestStrategy).toContain("half(10) === 5");
    expect(out.uncertainty).toContain("no other caller");
    expect(out.confidence).toBe("high");
  });

  it("treats a prose-only response as investigation-only (empty diff, sections parsed)", () => {
    const content = [
      "## Root cause",
      "Likely a race condition, but the evidence is thin.",
      "## Uncertainty",
      "Need the full failing log to confirm.",
    ].join("\n");
    const out = parseBugModelOutput(content);
    expect(out.diff).toBe("");
    expect(out.rootCause).toContain("race condition");
    expect(out.uncertainty).toContain("full failing log");
  });

  it("returns undefined for missing sections", () => {
    const out = parseBugModelOutput("## Root cause\nSomething.");
    expect(out.regressionTestStrategy).toBeUndefined();
    expect(out.uncertainty).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });

  it("parses an unfenced raw diff via the diff-marker heuristic", () => {
    const out = parseBugModelOutput("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b");
    expect(out.diff).toContain("+b");
  });

  it("skips non-diff code fences before the actual patch", () => {
    const content = [
      "Evidence:",
      "```ts",
      "const detail = 'sensitive';",
      "```",
      "```diff",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "```",
      "## Root cause",
      "The value was stale.",
    ].join("\n");
    const out = parseBugModelOutput(content);
    expect(out.diff).toContain("--- a/x.ts");
    expect(out.diff).toContain("+b");
    expect(out.diff).not.toContain("const detail");
    expect(out.rootCause).toContain("stale");
  });

  it("picks the first recognised confidence level when the body is verbose", () => {
    const out = parseBugModelOutput("## Confidence\nI would say medium, leaning low.");
    expect(out.confidence).toBe("medium");
  });

  it("ignores an unrecognised confidence body", () => {
    const out = parseBugModelOutput("## Confidence\nnot sure at all");
    expect(out.confidence).toBeUndefined();
  });

  it("tolerates an unterminated fence (treats the remainder as the diff)", () => {
    const out = parseBugModelOutput("```diff\n--- a\n+++ b");
    expect(out.diff).toContain("+++ b");
  });
});
