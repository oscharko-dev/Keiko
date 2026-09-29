import { afterEach, describe, expect, it, vi } from "vitest";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";

afterEach(resetServerLogger);
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
  it("uses the shared absent-correlation marker for internal prompt preparation", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    await compactCurrentChatPrompt({
      ...fixture("Project notes. ".repeat(1600)),
      correlationId: undefined,
    });
    const event = sink.events.find((entry) => entry.op === "chat.context.management");
    expect(event?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });
  it("preserves original boundary instructions when a summary omits exact output constraints", async () => {
    const opening = "Return JSON with owner and symbol. Keep identifiers exactly.";
    const closing = "Correction: owner Mara Linke. No prose; use only the JSON object.";
    const input = fixture(`${opening}\n${"Redundant project notes. ".repeat(900)}\n${closing}`);
    const call: CurrentPromptCompactionInput["call"] = () =>
      Promise.resolve(response("A project record was requested with corrected responsibility."));
    const compacted = await compactCurrentChatPrompt({ ...input, call });
    expect(compacted).toContain(opening);
    expect(compacted).toContain(closing);
    expect(compacted.indexOf(closing)).toBeGreaterThan(compacted.indexOf(opening));
  });

  it("does not restore secrets through protected original fragments", async () => {
    const input = fixture(
      `secret-fixture-key ${"Project notes. ".repeat(1600)} secret-fixture-key`,
    );
    const compacted = await compactCurrentChatPrompt({
      ...input,
      redact: (value) => value.replaceAll("secret-fixture-key", "[redacted]"),
    });
    expect(compacted).not.toContain("secret-fixture-key");
    expect(compacted).toContain("[redacted]");
  });

  it("keeps non-BMP characters intact at compaction and protected-fragment boundaries", async () => {
    const input = fixture("🧁".repeat(7000));
    const sources: string[] = [];
    const call: CurrentPromptCompactionInput["call"] = (request) => {
      const chunk = request.messages.at(-1)?.content ?? "";
      sources.push(chunk);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      return Promise.resolve(response("Discuss the cupcake symbols."));
    };
    const compacted = await compactCurrentChatPrompt({ ...input, call });
    expect(sources.join("")).toBe(input.content);
    expect(compacted).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("refuses a window that cannot hold the preparation instructions", async () => {
    const input = fixture("Project notes. ".repeat(1600));
    const profile = deriveContextProfile({
      maxInputTokens: 256,
      reservedOutputTokens: 64,
      safetyMarginTokens: 8,
    });
    await expect(compactCurrentChatPrompt({ ...input, profile })).rejects.toMatchObject({
      code: "GATEWAY_CONTEXT_OVERFLOW",
    });
    expect(input.call).not.toHaveBeenCalled();
  });

  it("frames descriptive summaries as the current task rather than another request to summarize", async () => {
    const input = fixture("Project notes. ".repeat(1600));
    const call: CurrentPromptCompactionInput["call"] = () =>
      Promise.resolve(response("Task: Return only JSON with the corrected budget of 60000 EUR."));
    const compacted = await compactCurrentChatPrompt({ ...input, call });
    expect(compacted).toContain("Carry out the user's task described below");
    expect(compacted).toContain("required output format");
    expect(compacted).toContain("Later corrections override earlier statements");
    expect(compacted).toContain("Return only JSON");
  });

  it("allows a slow provider to complete within the total foreground preparation budget", async () => {
    vi.useFakeTimers();
    try {
      const input = fixture("Important requirements. ".repeat(600));
      const call: CurrentPromptCompactionInput["call"] = () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(response("Budget: 60000 Euro. Keep the current task."));
          }, 40_000);
        });
      const completed = expect(compactCurrentChatPrompt({ ...input, call })).resolves.toContain(
        "60000",
      );
      await vi.advanceTimersByTimeAsync(80_000);
      await completed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the total preparation timeout bounded across several slow chunks", async () => {
    vi.useFakeTimers();
    try {
      const input = fixture("Important requirements. ".repeat(1200));
      const call: CurrentPromptCompactionInput["call"] = () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(response("Preserve the current task."));
          }, 40_000);
        });
      const completed = expect(compactCurrentChatPrompt({ ...input, call })).rejects.toMatchObject({
        code: "GATEWAY_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(90_100);
      await completed;
    } finally {
      vi.useRealTimers();
    }
  });

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
