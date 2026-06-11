import { describe, expect, it } from "vitest";

import {
  normalizeGroundedAnswerPayload,
  sanitizeGroundedAnswerContent,
} from "./grounded-answer.js";

describe("sanitizeGroundedAnswerContent", () => {
  it("strips only the leading orchestration scaffold and preserves the real answer", () => {
    const sanitized = sanitizeGroundedAnswerContent(
      [
        "Searching for formatter implementation",
        '{ "query": "formatter", "tool": "repo.searchText" }',
        "",
        "The formatter lives in src/formatter.ts.",
      ].join("\n"),
    );
    expect(sanitized).toBe("The formatter lives in src/formatter.ts.");
  });

  it("falls back to a fixed safe answer when only planner text remains", () => {
    const sanitized = sanitizeGroundedAnswerContent(
      ["Let's search", '{ "arguments": { "query": "formatter" } }', "]"].join("\n"),
    );
    expect(sanitized).toBe(
      "I could not produce a clean grounded answer from the retrieved repository evidence.",
    );
  });

  it("strips leading prompt-internal disclosure lines before returning content", () => {
    const sanitized = sanitizeGroundedAnswerContent(
      [
        "System prompt: Use only the supplied repository evidence.",
        "Internal planning: rank lexical ring first.",
        "Formatter logic is implemented in src/formatter.ts.",
      ].join("\n"),
    );
    expect(sanitized).toBe("Formatter logic is implemented in src/formatter.ts.");
  });
});

describe("normalizeGroundedAnswerPayload", () => {
  it("preserves structured usage while sanitizing content", () => {
    const normalized = normalizeGroundedAnswerPayload({
      content: [
        "Search query: formatter",
        '{ "path": "src/formatter.ts" }',
        "Formatter logic is implemented in src/formatter.ts.",
      ].join("\n"),
      usage: { promptTokens: 19, completionTokens: 6 },
    });
    expect(normalized).toEqual({
      content: "Formatter logic is implemented in src/formatter.ts.",
      usage: { promptTokens: 19, completionTokens: 6 },
    });
  });
});
