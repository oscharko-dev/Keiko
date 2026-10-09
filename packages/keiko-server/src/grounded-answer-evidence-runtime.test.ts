import { describe, expect, it } from "vitest";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

const files = { "src/Feature.ts": "export function feature() { return true; }\n" };

describe("single-source validated declaration delivery", () => {
  it("sanitizes unknown model-declared paths before returning the final answer", async () => {
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain feature",
      answer: "Missing evidence: [outside/private-canary.ts]",
    });
    expect(result.answer?.assistantContent).not.toContain("private-canary");
    expect(result.answer?.assistantContent.length).toBeGreaterThan(0);
    expect(result.answer).toMatchObject({ answerKind: "insufficiency" });
  });

  it("validates declarations against the evidence actually passed to the answerer", async () => {
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain feature",
      answer: "I need more evidence.\nMissing evidence: [src/Feature.ts]",
    });
    expect(result.answer).toMatchObject({
      insufficiencyDeclarations: [{ scopePath: "src/Feature.ts", state: "read-in-this-turn" }],
    });
  });

  it("does not flag a pure clarification as an uncited answer", async () => {
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain feature",
      answer: "Which function do you mean?",
    });
    expect(result.answer).toMatchObject({ answerKind: "clarification" });
    expect(result.pack.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(false);
  });
});
