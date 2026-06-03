import { describe, expect, it } from "vitest";
import { parseModelOutput } from "../../../src/workflows/unit-tests/parse.js";

const DIFF_BODY =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,3 @@\n+import { add } from '../src/add';\n+test('adds', () => expect(add(1,2)).toBe(3));\n";

describe("parseModelOutput (model-output contract, steering note B)", () => {
  it("extracts the diff from a fenced ```diff block", () => {
    const content = ["```diff", DIFF_BODY.trimEnd(), "```"].join("\n");
    const parsed = parseModelOutput(content);
    expect(parsed.diff).toContain("+++ b/tests/add.test.ts");
    expect(parsed.diff).not.toContain("```");
    expect(parsed.coveredBehavior).toBeUndefined();
    expect(parsed.knownGaps).toBeUndefined();
  });

  it("falls back to the whole content as diff when no fence is present", () => {
    const parsed = parseModelOutput(DIFF_BODY);
    expect(parsed.diff).toBe(DIFF_BODY.trim());
    expect(parsed.coveredBehavior).toBeUndefined();
    expect(parsed.knownGaps).toBeUndefined();
  });

  it("extracts labeled prose sections following the fenced diff", () => {
    const content = [
      "```diff",
      DIFF_BODY.trimEnd(),
      "```",
      "",
      "## Covered behavior",
      "Happy path and the zero case.",
      "",
      "## Known gaps",
      "Negative inputs are not covered.",
    ].join("\n");
    const parsed = parseModelOutput(content);
    expect(parsed.diff).toContain("+++ b/tests/add.test.ts");
    expect(parsed.coveredBehavior).toBe("Happy path and the zero case.");
    expect(parsed.knownGaps).toBe("Negative inputs are not covered.");
  });

  it("omits prose sections when they are absent", () => {
    const content = ["```diff", DIFF_BODY.trimEnd(), "```", "", "## Covered behavior", ""].join(
      "\n",
    );
    const parsed = parseModelOutput(content);
    // An empty section body resolves to undefined rather than an empty string.
    expect(parsed.coveredBehavior).toBeUndefined();
    expect(parsed.knownGaps).toBeUndefined();
  });

  it("returns an empty diff for empty content", () => {
    expect(parseModelOutput("").diff).toBe("");
  });

  it("handles an unterminated fence by taking everything after the opener", () => {
    const content = ["```diff", DIFF_BODY.trimEnd()].join("\n");
    const parsed = parseModelOutput(content);
    expect(parsed.diff).toContain("+++ b/tests/add.test.ts");
    expect(parsed.diff).not.toContain("```");
  });

  it("is case-insensitive on section headings", () => {
    const content = ["```diff", DIFF_BODY.trimEnd(), "```", "", "## KNOWN GAPS", "none"].join("\n");
    expect(parseModelOutput(content).knownGaps).toBe("none");
  });
});
