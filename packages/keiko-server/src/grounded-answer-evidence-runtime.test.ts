import { describe, expect, it } from "vitest";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";
import type { GroundedAnswerPayload } from "./grounded-answer.js";
import { withPromptExcerptBudget } from "./grounded-qa.js";

const files = { "src/Feature.ts": "export function feature() { return true; }\n" };

describe("single-source validated declaration delivery", () => {
  it("projects the sent source confidence without rewriting the assembled read accounting", async () => {
    const result = await runConnectedRetrievalEval({
      files: { "manual.md": "Unit-G42 has a shipment ceiling of 17 containers.\n" },
      query: "What is the shipment ceiling for Unit-G42?",
      answerer: {
        answer: (_question, pack): Promise<GroundedAnswerPayload> => {
          expect(pack.diagnostics?.selection?.selectionConfidence).toBe("high");
          const sent = withPromptExcerptBudget(pack, 0);
          return Promise.resolve({
            content: "The supplied evidence is insufficient to establish the shipment ceiling.",
            sentEvidencePacks: [sent],
            usage: { promptTokens: 0, completionTokens: 0 },
            modelInvoked: false,
          });
        },
      },
    });
    expect(result.pack.files.length).toBeGreaterThan(0);
    expect(result.pack.usage.filesRead).toBeGreaterThan(0);
    expect(result.pack.diagnostics?.selection).toMatchObject({
      selectionConfidence: "low",
      keepOneFallbackApplied: false,
    });
    expect(
      result.pack.uncertainty.filter((entry) => entry.kind === "low-confidence-selection"),
    ).toHaveLength(1);
    expect(result.answer?.filesInPrompt).toBe(0);
  });

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
      answer: (): Promise<GroundedAnswerPayload> => {
        calls += 1;
        return Promise.resolve({
          content: "Feature returns true.",
          usage: { promptTokens: 100, completionTokens: 10 },
        });
      },
      repair: (): Promise<GroundedAnswerPayload> => {
        calls += 1;
        return Promise.resolve({
          content: "Feature returns true [src/Feature.ts:1].",
          usage: { promptTokens: 120, completionTokens: 15 },
        });
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
        answer: (): Promise<string> => Promise.resolve("Feature returns true."),
        repair: (): Promise<string> => Promise.resolve("Feature returns false [src/Feature.ts:1]."),
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
        answer: (): Promise<string> => Promise.resolve("Feature returns true."),
        repair: (): Promise<string> => Promise.reject(new TypeError("synthetic repair fault")),
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
          answer: (): Promise<string> => Promise.resolve(answer),
          repair: (): Promise<string> => {
            repairCalls += 1;
            return Promise.resolve(answer);
          },
        },
      });
      expect(repairCalls).toBe(0);
      expect(result.answer).toMatchObject({ citationRepairDisposition: "not-needed" });
    },
  );
});
