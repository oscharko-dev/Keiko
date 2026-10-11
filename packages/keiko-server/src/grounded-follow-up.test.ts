import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { deriveGroundedContextAssembly } from "./grounded-context-diagnostics.js";
import { connectedSearchNoEvidenceAnswer } from "./grounded-faithfulness.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { withPromptExcerptByteLimit } from "./grounded-qa.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

const files = {
  "src/Feature.ts": "export function Feature() { return true; }\n",
  "lib/Companion.ts": "42;\n",
};
const first = "I need more evidence.\nMissing evidence: [lib/Companion.ts]";

async function scriptedTurn(
  followUpPassesMax: 0 | 1,
  second = "Companion is 42 [lib/Companion.ts:1].",
): Promise<{
  readonly result: Awaited<ReturnType<typeof runConnectedRetrievalEval>>;
  readonly received: string[][];
}> {
  const received: string[][] = [];
  const result = await runConnectedRetrievalEval({
    files,
    query: "Explain src/Feature.ts",
    budget: { ...DEFAULT_EXPLORATION_BUDGET, followUpPassesMax },
    answerer: {
      answer: async (_question, pack) => {
        await Promise.resolve();
        received.push(pack.files.map((file) => file.scopePath));
        return received.length === 1 ? first : second;
      },
    },
  });
  return { result, received };
}

describe("one server-owned follow-up under the original turn budgets", () => {
  it("reads a genuinely unselected in-scope declaration and returns only the second answer", async () => {
    const { result, received } = await scriptedTurn(1);
    expect(received[0]).not.toContain("lib/Companion.ts");
    expect(received).toHaveLength(2);
    expect(received[1]).toContain("lib/Companion.ts");
    expect(result.answer).toMatchObject({
      assistantContent: "Companion is 42 [lib/Companion.ts:1].",
      followUp: { passCount: 1, outcome: "answered", admittedPathCount: 1 },
    });
    expect(result.pack.budget).toEqual({ ...DEFAULT_EXPLORATION_BUDGET, followUpPassesMax: 1 });
  });

  it("keeps a disabled pass honest and carries the verified unread declaration", async () => {
    const { result, received } = await scriptedTurn(0);
    expect(received).toHaveLength(1);
    expect(result.answer).toMatchObject({
      followUp: { passCount: 0, outcome: "disabled" },
      insufficiencyDeclarations: [{ scopePath: "lib/Companion.ts", state: "unread-in-scope" }],
    });
  });

  it("returns second insufficiency and never makes a third synthesis or repair call", async () => {
    const { result, received } = await scriptedTurn(1, first);
    expect(received).toHaveLength(2);
    expect(result.answer).toMatchObject({
      answerKind: "insufficiency",
      followUp: { passCount: 1, outcome: "still-insufficient" },
    });
  });

  it("retains the first answer when its real content-read grant is exhausted", async () => {
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1, followUpPassesMax: 1 },
      answerer: {
        answer: async () => {
          await Promise.resolve();
          calls += 1;
          return first;
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.answer).toMatchObject({
      assistantContent: first,
      followUp: { passCount: 0, outcome: "budget-refused" },
    });
    expect(result.pack.usage.filesRead).toBe(1);
  });

  it("refuses canonical high context pressure with positive remaining grants", async () => {
    const profile = deriveContextProfile({
      maxInputTokens: 1500,
      inputTokenLimit: 1000,
      reservedOutputTokens: 100,
      safetyMarginTokens: 0,
    });
    let calls = 0;
    let pressure: string | undefined;
    const result = await runConnectedRetrievalEval({
      files: {
        ...files,
        "src/Feature.ts": `export function Feature() { return true; }\n${"// Feature details are intentionally long for the canonical context allocator.\n".repeat(200)}`,
      },
      query: "Explain src/Feature.ts",
      contextProfile: profile,
      answerer: {
        answer: async (_question, pack) => {
          await Promise.resolve();
          calls += 1;
          pressure = deriveGroundedContextAssembly(pack, profile).budgetPressure;
          return first;
        },
      },
    });
    expect(["high", "exceeded"]).toContain(pressure);
    expect(calls).toBe(1);
    expect(result.pack.usage.modelInputTokens).toBeLessThan(result.pack.budget.modelInputTokensMax);
    expect(result.answer?.followUp).toMatchObject({ passCount: 0, outcome: "budget-refused" });
  });

  it.each([
    "Which function do you mean?",
    connectedSearchNoEvidenceAnswer("Explain src/Feature.ts"),
  ])(
    "returns a second non-answer honestly without resolving the original declared miss: %s",
    async (second) => {
      const { result, received } = await scriptedTurn(1, second);
      expect(received).toHaveLength(2);
      expect(result.answer?.answerKind).not.toBe("answer");
      expect(result.answer?.followUp).toMatchObject({
        passCount: 1,
        outcome: "still-insufficient",
      });
    },
  );

  it("refuses an elapsed pass without another content read or answer call", async () => {
    let now = 0;
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      nowMs: () => now,
      budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 1000 },
      answerer: {
        answer: async () => {
          await Promise.resolve();
          calls += 1;
          now = 1001;
          return first;
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.answer?.followUp).toMatchObject({ passCount: 0, outcome: "elapsed-refused" });
    expect(result.pack.usage.filesRead).toBe(1);
  });

  it("propagates caller abort before a second pass", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      runConnectedRetrievalEval({
        files,
        query: "Explain src/Feature.ts",
        signal: controller.signal,
        answerer: {
          answer: async () => {
            await Promise.resolve();
            calls += 1;
            controller.abort(new Error("synthetic caller abort"));
            return first;
          },
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("keeps an uncited second answer honest and shares the extra call slot with repair", async () => {
    let calls = 0;
    let repairs = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      answerer: {
        answer: async () => {
          await Promise.resolve();
          calls += 1;
          return calls === 1 ? first : "Companion is 42.";
        },
        repair: async () => {
          await Promise.resolve();
          repairs += 1;
          return "Companion is 42 [lib/Companion.ts:1].";
        },
      },
    });
    expect(calls).toBe(2);
    expect(repairs).toBe(0);
    expect(result.answer).toMatchObject({
      assistantContent: "Companion is 42.",
      citationBehaviour: "never",
      followUp: { passCount: 1, outcome: "answered" },
    });
    expect(result.pack.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(true);
  });

  it("never reopens a physically read file that final prompt fitting omitted", async () => {
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      answerer: {
        answer: async (_question, pack) => {
          await Promise.resolve();
          calls += 1;
          return {
            content: "Missing evidence: [src/Feature.ts]",
            usage: { promptTokens: 10, completionTokens: 10 },
            sentEvidencePacks: [withPromptExcerptByteLimit(pack, 0)],
          };
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.answer?.insufficiencyDeclarations).toEqual([
      { scopePath: "src/Feature.ts", state: "unread-in-scope" },
    ]);
    expect(result.answer?.followUp).toMatchObject({ passCount: 0, outcome: "not-needed" });
    expect(result.pack.usage.filesRead).toBe(1);
  });

  it("retains first insufficiency when an injected second answer omitted the newly read source", async () => {
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      answerer: {
        answer: async (_question, pack) => {
          await Promise.resolve();
          calls += 1;
          return calls === 1
            ? first
            : {
                content: "Companion is 42.",
                usage: { promptTokens: 10, completionTokens: 10 },
                sentEvidencePacks: [withPromptExcerptByteLimit(pack, 0)],
              };
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.answer).toMatchObject({
      assistantContent: first,
      followUp: { passCount: 1, outcome: "budget-refused", admittedPathCount: 1 },
    });
    expect(result.pack.usage.modelInputTokens).toBe(10);
    expect(result.pack.usage.modelOutputTokens).toBe(10);
  });

  it("keeps actual second-pass read usage when its provider fails", async () => {
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      answerer: {
        answer: async () => {
          await Promise.resolve();
          calls += 1;
          if (calls === 1) return first;
          throw new TypeError("synthetic second-call fault");
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.answer).toMatchObject({
      assistantContent: first,
      followUp: { passCount: 1, outcome: "budget-refused" },
    });
    expect(result.pack.usage.filesRead).toBeGreaterThan(1);
  });

  it("keeps actual admission counts when fitting refuses a second provider dispatch", async () => {
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      answerer: {
        answer: async () => {
          await Promise.resolve();
          calls += 1;
          return calls === 1
            ? first
            : {
                content: connectedSearchNoEvidenceAnswer("Explain src/Feature.ts"),
                usage: { promptTokens: 0, completionTokens: 0 },
                modelInvoked: false,
                sentEvidencePacks: [],
              };
        },
      },
    });
    expect(result.answer).toMatchObject({
      assistantContent: first,
      followUp: { passCount: 1, admittedPathCount: 1, outcome: "budget-refused" },
    });
    // The second retrieval reads Feature again plus Companion; all three physical reads remain charged.
    expect(result.pack.usage.filesRead).toBe(3);
  });

  it.each(["../private.ts", ".env", "outside/private.ts", "dist/generated.ts"])(
    "never follows an unverified or denied declaration %s",
    async (path) => {
      let calls = 0;
      const result = await runConnectedRetrievalEval({
        files: { ...files, ".env": "PRIVATE_CANARY=true", "dist/generated.ts": "PRIVATE_CANARY" },
        query: "Explain src/Feature.ts",
        answerer: {
          answer: async () => {
            await Promise.resolve();
            calls += 1;
            return `Missing evidence: [${path}]`;
          },
        },
      });
      expect(calls).toBe(1);
      expect(result.answer?.assistantContent).not.toContain(path);
      expect(result.answer?.insufficiencyDeclarations ?? []).toEqual([]);
    },
  );
});
