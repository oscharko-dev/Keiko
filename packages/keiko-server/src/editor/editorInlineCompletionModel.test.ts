import { describe, expect, it, vi } from "vitest";

import {
  buildInlineCompletionPrompt,
  generateInlineCompletion,
  parseInlineContinuation,
  type GenerateInlineCompletionInput,
} from "./editorInlineCompletionModel.js";
import type { ModelChatFn } from "./editorCompletionModel.js";

function input(
  overrides: Partial<GenerateInlineCompletionInput> = {},
): GenerateInlineCompletionInput {
  return {
    overlayText: "function add(a, b) {\n  return \n}\n",
    position: { line: 1, character: 9 },
    languageId: "typescript",
    maxInsertTextChars: 100,
    ...overrides,
  };
}

describe("buildInlineCompletionPrompt", () => {
  it("includes prefix and suffix around the cursor (suffix-aware FIM) and never leaks instructions", () => {
    const prompt = buildInlineCompletionPrompt(input());
    expect(prompt.user).toContain("<CURSOR>");
    expect(prompt.user).toContain("function add");
    // text after the cursor is present (suffix-aware)
    expect(prompt.user).toContain("}");
    expect(prompt.system).toContain("read-only reference material");
  });

  it("delimits reference context as read-only when a context pack is supplied", () => {
    const prompt = buildInlineCompletionPrompt(
      input({
        contextPack: {
          schemaVersion: "1",
          request: { purpose: "inline", documentPath: "a.ts" },
          excerpts: [
            {
              citation: {
                sourceKind: "repo-search",
                sourceTier: "first-party-workspace",
                id: "x",
                score: 1,
                rank: 0,
                byteCount: 5,
                truncated: false,
              },
              text: "helper()",
            },
          ],
          usedBytes: 5,
          budgetBytes: 8192,
          droppedForBudget: 0,
          omissions: [],
        } as unknown as GenerateInlineCompletionInput["contextPack"],
      }),
    );
    expect(prompt.user).toContain("Reference context");
    expect(prompt.user).toContain("[repo-search] helper()");
  });

  it("redacts prefix and suffix text before assembling the model prompt", () => {
    const prompt = buildInlineCompletionPrompt(
      input({
        overlayText: "const token = SECRET;\nreturn ",
        position: { line: 1, character: 7 },
        redactText: (value) => value.replaceAll("SECRET", "[REDACTED]"),
      }),
    );
    expect(prompt.user).not.toContain("SECRET");
    expect(prompt.user).toContain("[REDACTED]");
  });
});

describe("parseInlineContinuation — result filtering", () => {
  it("returns the continuation verbatim when usable", () => {
    expect(parseInlineContinuation("a + b;", "\n}\n", 100)).toEqual({
      text: "a + b;",
      truncated: false,
    });
  });

  it("strips a wrapping code fence", () => {
    expect(parseInlineContinuation("```ts\na + b;\n```", "\n}\n", 100)).toEqual({
      text: "a + b;",
      truncated: false,
    });
  });

  it("drops empty or whitespace-only output", () => {
    expect(parseInlineContinuation("", "x", 100).text).toBeNull();
    expect(parseInlineContinuation("   \n  ", "x", 100).text).toBeNull();
  });

  it("drops output that merely duplicates the closing context after the cursor", () => {
    // The suffix already contains `return value;` — a continuation repeating it is dropped.
    expect(parseInlineContinuation("return value;", "return value;\n}", 100).text).toBeNull();
  });

  it("truncates output beyond the character cap and flags it", () => {
    const long = "x".repeat(150);
    const parsed = parseInlineContinuation(long, "", 100);
    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toHaveLength(100);
  });
});

describe("generateInlineCompletion", () => {
  it("returns a filtered continuation plus a content-free prompt hash and usage", async () => {
    const chat: ModelChatFn = vi.fn(() =>
      Promise.resolve({
        content: "a + b;",
        usage: {
          requestId: "r1",
          promptTokens: 10,
          completionTokens: 4,
          latencyMs: 42,
          costClass: "low" as const,
        },
      }),
    );
    const result = await generateInlineCompletion(input(), chat, new AbortController().signal);
    expect(result.insertText).toBe("a + b;");
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.usage?.latencyMs).toBe(42);
  });

  it("returns null insertText when the model yields nothing usable", async () => {
    const chat: ModelChatFn = () => Promise.resolve("   ");
    const result = await generateInlineCompletion(input(), chat, new AbortController().signal);
    expect(result.insertText).toBeNull();
  });

  it("passes the abort signal through to the chat function", async () => {
    let seen: AbortSignal | null = null;
    const chat: ModelChatFn = (_req, signal) => {
      seen = signal;
      return Promise.resolve("x;");
    };
    const controller = new AbortController();
    await generateInlineCompletion(input(), chat, controller.signal);
    expect(seen).toBe(controller.signal);
  });
});
