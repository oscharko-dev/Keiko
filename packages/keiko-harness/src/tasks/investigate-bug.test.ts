import { describe, expect, it } from "vitest";
import { buildInvestigateBug } from "./investigate-bug.js";

describe("buildInvestigateBug", () => {
  it("allows tools, patch, and verification", () => {
    const plan = buildInvestigateBug({ description: "crash on empty input" });
    expect(plan.allowsTools).toBe(true);
    expect(plan.allowsPatch).toBe(true);
    expect(plan.allowsVerification).toBe(true);
  });

  it("puts the bug description into the user message", () => {
    const plan = buildInvestigateBug({ description: "crash on empty input" });
    expect(plan.messages[1]?.content).toContain("crash on empty input");
  });

  it("lists the suspected file paths and uses the first as the patch target", () => {
    const plan = buildInvestigateBug({
      description: "off-by-one",
      filePaths: ["src/a.ts", "src/b.ts"],
    });
    expect(plan.targetFile).toBe("src/a.ts");
    expect(plan.messages[1]?.content).toContain("src/a.ts");
    expect(plan.messages[1]?.content).toContain("src/b.ts");
  });

  // KEIKO-0613: pin the exact documented sentinel (UNSPECIFIED_TARGET), not just non-emptiness —
  // targetFile is the patch target a later patch-proposal/apply stage acts on, so a regression that
  // silently swaps the fallback for some other non-empty value must fail this test.
  it("falls back to an unspecified target when no file paths are given", () => {
    const plan = buildInvestigateBug({ description: "mystery" });
    expect(plan.targetFile).toBe("<unspecified>");
  });

  // KEIKO-0550: context: "" is defined-but-empty, distinct from an omitted field, but must not
  // survive as a labeled-but-empty "Context: " section in the rendered prompt.
  it("treats an empty-string context the same as an omitted context", () => {
    const omitted = buildInvestigateBug({ description: "mystery" });
    const empty = buildInvestigateBug({ description: "mystery", context: "" });
    expect(empty.messages).toEqual(omitted.messages);
  });
});
