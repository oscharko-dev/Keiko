import { describe, expect, it } from "vitest";
import { buildGenerateUnitTests } from "../../../src/harness/tasks/generate-unit-tests.js";

describe("buildGenerateUnitTests", () => {
  it("allows patch and verification but not free tool use", () => {
    const plan = buildGenerateUnitTests({ filePath: "src/foo.ts" });
    expect(plan.allowsPatch).toBe(true);
    expect(plan.allowsVerification).toBe(true);
    expect(plan.allowsTools).toBe(false);
  });

  it("targets the source file and names the target function when provided", () => {
    const plan = buildGenerateUnitTests({ filePath: "src/foo.ts", targetFunction: "parseConfig" });
    expect(plan.targetFile).toBe("src/foo.ts");
    expect(plan.messages[1]?.content).toContain("parseConfig");
  });

  it("appends supplied context to the user message", () => {
    const plan = buildGenerateUnitTests({ filePath: "src/foo.ts", context: "uses zod schemas" });
    expect(plan.messages[1]?.content).toContain("uses zod schemas");
  });
});
