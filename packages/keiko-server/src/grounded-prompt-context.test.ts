// PR #3678 review: folder, multi-source and hybrid answers report the share their rendered excerpts
// took, so the context meter no longer shows 0 knowledge tokens for those grounded chats.
import { describe, expect, it } from "vitest";
import { renderedSourcePromptContext } from "./grounded-prompt-context.js";

describe("renderedSourcePromptContext", () => {
  const prompt = {
    sourceText: "File: src/a.ts\n```ts\nexport const answer = 42;\n```",
    instructions: "Answer only from the excerpts.",
    referenceCount: 3,
  };

  it("prefers the provider-measured prompt and counts every rendered reference as sent", () => {
    const context = renderedSourcePromptContext(
      { ...prompt, measuredPromptTokens: 812 },
      undefined,
    );
    expect(context).toMatchObject({
      promptTokens: 812,
      promptTokensMeasured: true,
      sentReferenceCount: 3,
      availableReferenceCount: 3,
    });
    expect(context.sourceTokens).toBeGreaterThan(0);
    expect(context.instructionTokens).toBeGreaterThan(0);
  });

  it("falls back to the estimate when the provider reported no usage", () => {
    const context = renderedSourcePromptContext({ ...prompt, measuredPromptTokens: 0 }, undefined);
    expect(context.promptTokensMeasured).toBe(false);
    expect(context.promptTokens).toBe(context.sourceTokens + context.instructionTokens);
  });

  it("reports no source share for a prompt without excerpts", () => {
    const context = renderedSourcePromptContext(
      { ...prompt, sourceText: "", referenceCount: 0, measuredPromptTokens: 0 },
      undefined,
    );
    expect(context.sourceTokens).toBe(0);
    expect(context.sentReferenceCount).toBe(0);
  });
});
