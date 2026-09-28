import { describe, expect, it } from "vitest";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { admitGatewayPrompt } from "./prompt-admission.js";
import { createDefaultChatCapability } from "./capabilities.js";
import { countGatewayPromptTokens } from "./prompt-token-accounting.js";
import type { ModelGatewayLogEvent } from "./observability.js";

const capability = {
  ...createDefaultChatCapability("fixture"),
  contextWindow: 4096,
  maxOutputTokens: 1024,
};
const request = { modelId: "fixture", messages: [{ role: "user" as const, content: "question" }] };

function recorder(): {
  events: ModelGatewayLogEvent[];
  write: (event: ModelGatewayLogEvent) => void;
} {
  const events: ModelGatewayLogEvent[] = [];
  return {
    events,
    write: (event): void => {
      events.push(event);
    },
  };
}

describe("complete prompt admission", () => {
  it.each([NaN, Infinity, -1, 0, 1.5, 1025])(
    "refuses invalid output allocation %s with finite diagnostics",
    (maxOutputTokens) => {
      const log = recorder();
      expect(() =>
        admitGatewayPrompt({ ...request, maxOutputTokens }, capability, log, "fixture"),
      ).toThrow(expect.objectContaining({ code: "GATEWAY_CONTEXT_OVERFLOW" }));
      expect(log.events[0]?.extra).toMatchObject({ state: "overflow" });
      expect(Number.isSafeInteger(log.events[0]?.extra?.outputBudget)).toBe(true);
    },
  );

  it("uses remote counts to reject a prompt that fits the local estimate", () => {
    const log = recorder();
    const profile = deriveContextProfileFromCapability(capability);
    expect(() =>
      admitGatewayPrompt(request, capability, log, "fixture", {
        status: "available",
        tokens: profile.effectiveInputBudget + 1,
        tokenizer: "huggingface",
      }),
    ).toThrow(expect.objectContaining({ code: "GATEWAY_CONTEXT_OVERFLOW" }));
    expect(log.events[0]?.extra).toMatchObject({
      counterSource: "gateway-reported",
      tokenizer: "huggingface",
    });
  });

  it("keeps the local complete projection when the remote counter omits context", () => {
    const log = recorder();
    admitGatewayPrompt(request, capability, log, "fixture", { status: "available", tokens: 1 });
    expect(log.events[0]?.extra).toMatchObject({
      counterSource: "fallback-estimated",
      counterStatus: "available",
      promptTokens: countGatewayPromptTokens(request),
    });
  });

  it.each(["disabled", "invalid", "unavailable"] as const)(
    "uses calibrated fallback for a %s counter",
    (status) => {
      const log = recorder();
      admitGatewayPrompt(request, capability, log, "fixture", { status });
      expect(log.events[0]?.extra).toMatchObject({ state: "admitted", counterStatus: status });
    },
  );

  it("includes structured response schemas in the final input budget", () => {
    const responseFormat = {
      type: "json_schema" as const,
      name: "fixture",
      schema: { description: "long schema ".repeat(4000) },
    };
    expect(() =>
      admitGatewayPrompt({ ...request, responseFormat }, capability, recorder(), "fixture"),
    ).toThrow(expect.objectContaining({ code: "GATEWAY_CONTEXT_OVERFLOW" }));
  });
});
