// PR #3678 review: folder, multi-source and hybrid answers report the share their SENT prompt took,
// so the context meter no longer shows 0 knowledge tokens for those grounded chats.
import { describe, expect, it } from "vitest";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { sentPromptContext } from "./grounded-prompt-context.js";

describe("sentPromptContext", () => {
  const system = { role: "system" as const, content: "Answer only from the excerpts." };
  const prompt = {
    messages: [
      system,
      {
        role: "user" as const,
        content: "Question: what is the answer?\nFile: src/a.ts\nexport const answer = 42;",
      },
    ],
    withoutSources: [system, { role: "user" as const, content: "Question: what is the answer?" }],
    sentReferenceCount: 2,
    availableReferenceCount: 3,
  };

  it("prefers the provider-measured prompt and keeps the estimate of the sent request", () => {
    const context = sentPromptContext(prompt, 812, undefined);
    expect(context).toMatchObject({
      promptTokens: 812,
      promptTokensMeasured: true,
      estimatedPromptTokens: countGatewayPromptTokens({ messages: prompt.messages }),
      sentReferenceCount: 2,
      availableReferenceCount: 3,
    });
    expect(context.sourceTokens).toBeGreaterThan(0);
    expect(context.instructionTokens).toBeGreaterThan(0);
  });

  it("estimates the whole sent request when the provider reported no usage", () => {
    const context = sentPromptContext(prompt, 0, undefined);
    expect(context.promptTokensMeasured).toBe(false);
    expect(context.promptTokens).toBe(countGatewayPromptTokens({ messages: prompt.messages }));
  });

  it("stamps the admission geometry without claiming unknown profile metadata", () => {
    const profile = deriveContextProfileFromCapability({
      id: "bounded-alias",
      contextWindow: 32_000,
      maxInputTokens: 8_000,
      maxOutputTokens: 2_048,
    });
    expect(sentPromptContext(prompt, 812, profile)).toMatchObject({
      modelId: profile.model?.id,
      contextWindowTokens: profile.maxInputTokens,
      inputBudgetTokens: profile.effectiveInputBudget,
      reservedOutputTokens: profile.reservedOutputTokens,
    });
    const unknown = sentPromptContext(prompt, 812, undefined);
    expect(unknown.modelId).toBeUndefined();
    expect(unknown.contextWindowTokens).toBeUndefined();
    expect(unknown.inputBudgetTokens).toBeUndefined();
    expect(unknown.reservedOutputTokens).toBeUndefined();
  });

  it("reports no source share for a prompt without excerpts", () => {
    const context = sentPromptContext(
      { ...prompt, messages: prompt.withoutSources, sentReferenceCount: 0 },
      0,
      undefined,
    );
    expect(context.sourceTokens).toBe(0);
  });
});
