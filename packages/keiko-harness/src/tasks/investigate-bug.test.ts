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

  it("falls back to an unspecified target when no file paths are given", () => {
    const plan = buildInvestigateBug({ description: "mystery" });
    expect(plan.targetFile.length).toBeGreaterThan(0);
  });
});
