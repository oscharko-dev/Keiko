import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedAnswerPayload } from "./grounded-answer.js";
import { repairGroundedAnswer, type GroundedRepairContext } from "./grounded-answer-repair.js";

function context(content: string, numeric = false): GroundedRepairContext {
  return {
    question: "Explain the supplied source.",
    budget: DEFAULT_EXPLORATION_BUDGET,
    answer: {
      content,
      answerKind: "answer",
      filesInPrompt: numeric ? 0 : 2,
      usage: { promptTokens: 17, completionTokens: 7 },
    },
    ...(numeric ? { numericMarkers: new Set([1]) } : {}),
    nowMs: () => 0,
    deps: {},
  };
}

describe("citation repair dispatch eligibility", () => {
  it("applies a bounded citation annotation without asking the model to copy generated code", async () => {
    const content = "The feature returns true.\n\n```ts\nconst feature = true;\n```";
    const ctx = context(content, true);
    const repair = vi.fn((): Promise<GroundedAnswerPayload> =>
      Promise.resolve({
        content: JSON.stringify({
          insertions: [{ after: "The feature returns true.", marker: "[1]" }],
        }),
        usage: { promptTokens: 11, completionTokens: 5 },
      }),
    );
    const result = await repairGroundedAnswer({ ...ctx, invokeRepair: repair });
    expect(result.disposition).toBe("applied");
    expect(result.answer.content).toBe(
      "The feature returns true. [1]\n\n```ts\nconst feature = true;\n```",
    );
    expect(result.answer.usage).toEqual({ promptTokens: 28, completionTokens: 12 });
    expect(repair).toHaveBeenCalledOnce();
  });

  it("propagates malformed annotation evidence while retaining the completed repair's spend", async () => {
    const ctx = context("The feature returns true.", true);
    const result = await repairGroundedAnswer({
      ...ctx,
      invokeRepair: (): Promise<GroundedAnswerPayload> =>
        Promise.resolve({
          content: '{"insertions":[',
          usage: { promptTokens: 11, completionTokens: 5 },
        }),
    });
    expect(result.disposition).toBe("failed");
    expect(result.failure).toBeInstanceOf(SyntaxError);
    expect(result.answer.content).toBe(ctx.answer.content);
    expect(result.answer.usage).toEqual({ promptTokens: 28, completionTokens: 12 });
    expect(result.answer.completedSynthesisCallCount).toBe(2);
  });

  it.each([
    { length: 131_072, astral: false, numeric: false, calls: 1 },
    { length: 131_073, astral: false, numeric: false, calls: 0 },
    { length: 131_072, astral: true, numeric: false, calls: 1 },
    { length: 131_073, astral: true, numeric: false, calls: 0 },
    { length: 131_072, astral: false, numeric: true, calls: 1 },
    { length: 131_073, astral: false, numeric: true, calls: 0 },
    { length: 131_072, astral: true, numeric: true, calls: 1 },
    { length: 131_073, astral: true, numeric: true, calls: 0 },
  ])("bounds dispatch at $length UTF-16 units (astral=$astral, numeric=$numeric)", async (test) => {
    const content = test.astral
      ? "𐐀".repeat(65_536) + "x".repeat(test.length - 131_072)
      : "x".repeat(test.length);
    expect(content).toHaveLength(test.length);
    const ctx = context(content, test.numeric);
    const repair = vi.fn((): Promise<GroundedAnswerPayload> => Promise.resolve("Changed text."));
    const result = await repairGroundedAnswer({ ...ctx, invokeRepair: repair });
    expect(repair).toHaveBeenCalledTimes(test.calls);
    expect(result.disposition).toBe(
      test.calls === 0 ? "skipped-capability" : "rejected-content-changed",
    );
    expect(result.answer.content).toBe(content);
    expect(result.answer.usage).toEqual(ctx.answer.usage);
    if (test.calls === 0) expect(result.answer).toBe(ctx.answer);
  });

  it.each([
    { answer: { filesInPrompt: 0 }, suffix: "" },
    { answer: { modelInvoked: false }, suffix: "" },
    { answer: { answerKind: "clarification" as const }, suffix: "" },
    { answer: {}, suffix: " [src/Feature.ts:1]" },
  ])("preserves the earlier not-needed decision for $answer $suffix", async (test) => {
    const ctx = context("x".repeat(131_073) + test.suffix);
    const repair = vi.fn((): Promise<GroundedAnswerPayload> => Promise.resolve("Unused."));
    const result = await repairGroundedAnswer({
      ...ctx,
      answer: { ...ctx.answer, ...test.answer },
      invokeRepair: repair,
    });
    expect(result.disposition).toBe("not-needed");
    expect(repair).not.toHaveBeenCalled();
  });

  it.each(["calls", "tokens", "deadline"] as const)(
    "preserves the %s admission bound",
    async (kind) => {
      const ctx = context("Feature is true.");
      const repair = vi.fn((): Promise<GroundedAnswerPayload> => Promise.resolve("Unused."));
      const result = await repairGroundedAnswer({
        ...ctx,
        invokeRepair: repair,
        ...(kind === "calls"
          ? { deps: { answerer: { remainingSynthesisCalls: (): number => 0 } } }
          : {}),
        ...(kind === "tokens"
          ? { budget: { ...DEFAULT_EXPLORATION_BUDGET, modelOutputTokensMax: 7 } }
          : {}),
        ...(kind === "deadline" ? { deadlineAtMs: 0 } : {}),
      });
      expect(result.disposition).toBe("skipped-budget");
      expect(repair).not.toHaveBeenCalled();
      expect(result.answer).toBe(ctx.answer);
    },
  );

  it("propagates cancellation instead of turning it into a completed repair", async () => {
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation");
    controller.abort(reason);
    await expect(
      repairGroundedAnswer({
        ...context("Feature is true."),
        deps: { signal: controller.signal },
        invokeRepair: () => Promise.reject(reason),
      }),
    ).rejects.toBe(reason);
  });
});
