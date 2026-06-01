import { describe, expect, it } from "vitest";
import { buildExplainPlan } from "../../../src/harness/tasks/explain-plan.js";

describe("buildExplainPlan", () => {
  it("is read-only: tools, patch, and verification are all disallowed", () => {
    const plan = buildExplainPlan({ filePath: "src/foo.ts" });
    expect(plan.allowsTools).toBe(false);
    expect(plan.allowsPatch).toBe(false);
    expect(plan.allowsVerification).toBe(false);
  });

  it("targets the requested file and seeds a system + user message", () => {
    const plan = buildExplainPlan({ filePath: "src/foo.ts", question: "what does bar do?" });
    expect(plan.targetFile).toBe("src/foo.ts");
    expect(plan.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(plan.messages[1]?.content).toContain("what does bar do?");
  });

  it("includes the file path in the user message when no question is given", () => {
    const plan = buildExplainPlan({ filePath: "src/baz.ts" });
    expect(plan.messages[1]?.content).toContain("src/baz.ts");
  });

  it("grounds the prompt with provided file context", () => {
    const plan = buildExplainPlan({
      filePath: "src/baz.ts",
      context: "--- src/baz.ts ---\nexport const value = 1;",
    });
    expect(plan.messages[0]?.content).toContain("Do not infer");
    expect(plan.messages[1]?.content).toContain("export const value = 1;");
  });
});
