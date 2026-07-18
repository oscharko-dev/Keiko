import { describe, expect, it } from "vitest";
import { buildEditorAgentTurn } from "./editor-agent-turn.js";

describe("buildEditorAgentTurn", () => {
  it("allows tools but disallows patch and harness-native verification", () => {
    const plan = buildEditorAgentTurn({ goal: "search the workspace", sessionId: "session-1" });
    expect(plan.allowsTools).toBe(true);
    expect(plan.allowsPatch).toBe(false);
    expect(plan.allowsVerification).toBe(false);
  });

  it("targets the given session and seeds a system + user message", () => {
    const plan = buildEditorAgentTurn({ goal: "search the workspace", sessionId: "session-1" });
    expect(plan.targetFile).toBe("session-1");
    expect(plan.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(plan.messages[1]?.content).toContain("session-1");
    expect(plan.messages[1]?.content).toContain("search the workspace");
  });

  it("scopes the system prompt to the governed tool surface", () => {
    const plan = buildEditorAgentTurn({ goal: "goal", sessionId: "session-2" });
    expect(plan.messages[0]?.content).toContain("only the tools offered to you");
    expect(plan.rationale).toContain("session-2");
  });
});
