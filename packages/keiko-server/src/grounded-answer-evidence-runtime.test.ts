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

describe("single-source bounded citation repair", () => {
  it("repairs a substantive uncited answer once and preserves cumulative usage", async () => {
    let calls = 0;
    const answerer = {
      answer: async () => {
        calls += 1;
        return {
          content: "Feature returns true.",
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
      repair: async () => {
        calls += 1;
        return {
          content: "Feature returns true [src/Feature.ts:1].",
          usage: { promptTokens: 120, completionTokens: 15 },
        };
      },
    };
    const result = await runConnectedRetrievalEval({ files, query: "Explain feature", answerer });
    expect(calls).toBe(2);
    expect(result.answer).toMatchObject({
      citationBehaviour: "cites-after-repair",
      citationRepairDisposition: "applied",
    });
    expect(result.pack.usage).toMatchObject({ modelInputTokens: 220, modelOutputTokens: 25 });
    expect(result.pack.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(false);
  });

  it("retains the original answer when repair changes substantive text", async () => {
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain feature",
      answerer: {
        answer: async () => "Feature returns true.",
        repair: async () => "Feature returns false [src/Feature.ts:1].",
      },
    });
    expect(result.answer).toMatchObject({
      assistantContent: "Feature returns true.",
      citationRepairDisposition: "rejected-content-changed",
      citationBehaviour: "never",
    });
  });

  it("keeps the original when an extra provider call fails", async () => {
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain feature",
      answerer: {
        answer: async () => "Feature returns true.",
        repair: async () => {
          throw new TypeError("synthetic repair fault");
        },
      },
    });
    expect(result.answer).toMatchObject({
      assistantContent: "Feature returns true.",
      citationRepairDisposition: "failed",
    });
  });

  it.each(["Which function do you mean?", "Missing evidence: [src/Feature.ts]"])(
    "never repairs %s",
    async (answer) => {
      let repairCalls = 0;
      const result = await runConnectedRetrievalEval({
        files,
        query: "Explain feature",
        answerer: {
          answer: async () => answer,
          repair: async () => {
            repairCalls += 1;
            return answer;
          },
        },
      });
      expect(repairCalls).toBe(0);
      expect(result.answer).toMatchObject({ citationRepairDisposition: "not-needed" });
    },
  );
});
