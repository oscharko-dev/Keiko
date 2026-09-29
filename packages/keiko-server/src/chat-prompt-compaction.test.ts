import { describe, expect, it, vi } from "vitest";
import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  compactCurrentChatPrompt,
  type CurrentPromptCompactionInput,
} from "./chat-prompt-compaction.js";

function response(content: string): NormalizedResponse {
  return {
    content,
    modelId: "Qwen3-Coder-custom-alias",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "prompt-compaction-fixture",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "medium",
    },
  };
}

function fixture(content: string): CurrentPromptCompactionInput {
  return {
    content,
    modelId: "Qwen3-Coder-custom-alias",
    profile: deriveContextProfile({
      maxInputTokens: 4096,
      reservedOutputTokens: 1024,
      safetyMarginTokens: 128,
    }),
    call: vi.fn(() =>
      Promise.resolve(
        response(
          "Aufgabe: Prüfe Projekt Linden. Budget: 60.000 EUR. Termin: 19. November. Symbol: parseLocalStateFlags. Unsichere Angaben überprüfen.",
        ),
      ),
    ),
    signal: new AbortController().signal,
    correlationId: "prompt-compaction-fixture",
    redact: (value) => value,
  };
}

describe("current prompt semantic compaction", () => {
  it("preserves a fitting current prompt without another model call", async () => {
    const input = fixture("Hallo, prüfe bitte diese Funktion.");
    expect(await compactCurrentChatPrompt(input)).toBe(input.content);
    expect(input.call).not.toHaveBeenCalled();
  });

  it("compacts a large first prompt while preserving its original input", async () => {
    const original =
      "Prüfe Projekt Linden. ".repeat(900) +
      "\nKorrektur: 60.000 EUR, 19. November. parseLocalStateFlags.";
    const input = fixture(original);
    const compacted = await compactCurrentChatPrompt(input);
    expect(compacted).toContain("60.000 EUR");
    expect(compacted).toContain("19. November");
    expect(compacted).toContain("parseLocalStateFlags");
    expect(compacted.length).toBeLessThan(original.length / 2);
    expect(input.content).toBe(original);
    expect(input.call).toHaveBeenCalled();
  });

  it("covers every source character in bounded requests accepted by the selected model", async () => {
    const original = Array.from(
      { length: 400 },
      (_, index) => `Fact ${String(index)}: ${"important context ".repeat(8)}\n`,
    ).join("");
    const input = fixture(original);
    const sources: string[] = [];
    const call: CurrentPromptCompactionInput["call"] = vi.fn(
      (request: GatewayCallRequest): Promise<NormalizedResponse> => {
        expect(
          countGatewayPromptTokens(request, input.profile.tokenAccounting, {
            contextWindow: input.profile.maxInputTokens,
          }) +
            (request.maxOutputTokens ?? 0) +
            input.profile.safetyMarginTokens,
        ).toBeLessThanOrEqual(input.profile.maxInputTokens);
        const content = request.messages.at(-1)?.content ?? "";
        sources.push(content);
        return Promise.resolve(response("Keep all numbered facts and resolve the final task."));
      },
    );
    await compactCurrentChatPrompt({ ...input, call });
    expect(sources.join("")).toBe(original);
  });

  it.each(["length", "content_filter", "tool_calls"] as const)(
    "rejects incomplete summaries with finish reason %s",
    async (finishReason) => {
      const input = fixture("Important instructions. ".repeat(900));
      const call: CurrentPromptCompactionInput["call"] = () =>
        Promise.resolve({ ...response("Partial task."), finishReason });
      await expect(compactCurrentChatPrompt({ ...input, call })).rejects.toMatchObject({
        code: "GATEWAY_PROVIDER_ERROR",
      });
    },
  );

  it("refuses a summary that does not reduce the prompt", async () => {
    const input = fixture("Important instructions. ".repeat(900));
    const call: CurrentPromptCompactionInput["call"] = (request) =>
      Promise.resolve(response(request.messages.at(-1)?.content ?? ""));
    await expect(compactCurrentChatPrompt({ ...input, call })).rejects.toMatchObject({
      code: "GATEWAY_CONTEXT_OVERFLOW",
    });
  });

  it("refuses empty or redacted-away summaries", async () => {
    const input = fixture("Important instructions. ".repeat(900));
    await expect(compactCurrentChatPrompt({ ...input, redact: () => "" })).rejects.toMatchObject({
      code: "GATEWAY_PROVIDER_ERROR",
    });
  });

  it("does not dispatch after cancellation", async () => {
    const input = fixture("Important instructions. ".repeat(900));
    const controller = new AbortController();
    controller.abort();
    await expect(
      compactCurrentChatPrompt({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(input.call).not.toHaveBeenCalled();
  });
});
