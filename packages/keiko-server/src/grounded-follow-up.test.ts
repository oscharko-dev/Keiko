import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

const files = {
  "src/Feature.ts": "export function Feature() { return true; }\n",
  "src/Companion.ts": "export const companion = 42;\n",
};
const first = "I need more evidence.\nMissing evidence: [src/Companion.ts]";

async function scriptedTurn(
  followUpPassesMax: 0 | 1,
  second = "Companion is 42 [src/Companion.ts:1].",
) {
  const received: string[][] = [];
  const result = await runConnectedRetrievalEval({
    files,
    query: "Explain Feature",
    budget: { ...DEFAULT_EXPLORATION_BUDGET, followUpPassesMax },
    answerer: {
      answer: async (_question, pack) => {
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
    expect(received[0]).not.toContain("src/Companion.ts");
    expect(received).toHaveLength(2);
    expect(received[1]).toContain("src/Companion.ts");
    expect(result.answer).toMatchObject({
      assistantContent: "Companion is 42 [src/Companion.ts:1].",
      followUp: { passCount: 1, outcome: "answered", admittedPathCount: 1 },
    });
    expect(result.pack.budget).toEqual({ ...DEFAULT_EXPLORATION_BUDGET, followUpPassesMax: 1 });
  });

  it("keeps a disabled pass honest and carries the verified unread declaration", async () => {
    const { result, received } = await scriptedTurn(0);
    expect(received).toHaveLength(1);
    expect(result.answer).toMatchObject({
      followUp: { passCount: 0, outcome: "disabled" },
      insufficiencyDeclarations: [{ scopePath: "src/Companion.ts", state: "unread-in-scope" }],
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
      query: "Explain Feature",
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1, followUpPassesMax: 1 },
      answerer: {
        answer: async () => {
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

  it.each(["../private.ts", ".env", "outside/private.ts", "dist/generated.ts"])(
    "never follows an unverified or denied declaration %s",
    async (path) => {
      let calls = 0;
      const result = await runConnectedRetrievalEval({
        files: { ...files, ".env": "PRIVATE_CANARY=true", "dist/generated.ts": "PRIVATE_CANARY" },
        query: "Explain Feature",
        answerer: {
          answer: async () => {
            calls += 1;
            return `Missing evidence: [${path}]`;
          },
        },
      });
      expect(calls).toBe(1);
      expect(result.answer?.assistantContent).not.toContain(path);
      expect(result.answer?.insufficiencyDeclarations).toEqual([]);
    },
  );
});
