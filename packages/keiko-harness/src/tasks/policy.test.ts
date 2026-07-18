import { describe, expect, it } from "vitest";
import { resolveTaskPlan } from "./policy.js";

describe("resolveTaskPlan", () => {
  it("routes explain-plan to a read-only plan", () => {
    const plan = resolveTaskPlan({ taskType: "explain-plan", input: { filePath: "src/foo.ts" } });
    expect(plan.allowsTools).toBe(false);
    expect(plan.targetFile).toBe("src/foo.ts");
  });

  it("routes generate-unit-tests to its task plan", () => {
    const plan = resolveTaskPlan({
      taskType: "generate-unit-tests",
      input: { filePath: "src/foo.ts" },
    });
    expect(plan.targetFile).toBe("src/foo.ts");
  });

  it("routes investigate-bug to its task plan", () => {
    const plan = resolveTaskPlan({
      taskType: "investigate-bug",
      input: { description: "bug description" },
    });
    expect(plan.messages.at(-1)?.content).toContain("bug description");
  });

  it("routes verify to its deterministic, tool-free plan", () => {
    const plan = resolveTaskPlan({ taskType: "verify", input: { workspaceRoot: "/repo" } });
    expect(plan.allowsTools).toBe(false);
  });

  // Issue #2489 (Findings 1/2) — the Keiko-native producer's task type.
  it("routes editor-agent-turn to a tool-allowing, patch-free plan", () => {
    const plan = resolveTaskPlan({
      taskType: "editor-agent-turn",
      input: { goal: "search the workspace", sessionId: "session-1" },
    });
    expect(plan.allowsTools).toBe(true);
    expect(plan.allowsPatch).toBe(false);
    expect(plan.targetFile).toBe("session-1");
  });
});
