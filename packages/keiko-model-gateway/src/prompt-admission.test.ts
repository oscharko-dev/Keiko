import { describe, expect, it } from "vitest";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { admitGatewayPrompt } from "./prompt-admission.js";
import { createDefaultChatCapability } from "./capabilities.js";
import { countGatewayPromptTokens } from "./prompt-token-accounting.js";
import type { GatewayFailureEvidence, ModelGatewayLogEvent } from "./observability.js";
import type { GatewayCallRequest } from "./gateway.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

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

it("retains schema cost when the remote message count wins", () => {
  const log = recorder();
  const responseFormat = {
    type: "json_schema" as const,
    name: "result",
    schema: { description: "item ".repeat(500) },
  };
  const complete = { ...request, maxOutputTokens: 800, responseFormat };
  const profile = deriveContextProfileFromCapability(capability);
  const schemaCost = countGatewayPromptTokens({ messages: [], responseFormat });
  const remote = profile.maxInputTokens - 800 - profile.safetyMarginTokens;
  expect(() =>
    admitGatewayPrompt(complete, capability, log, "schema-remote", {
      status: "available",
      tokens: remote,
    }),
  ).toThrow(expect.objectContaining({ code: "GATEWAY_CONTEXT_OVERFLOW" }));
  expect(log.events[0]?.extra?.promptTokens).toBe(remote + schemaCost);
});

it("classifies overflow refusals with structured evidence before throwing", () => {
  const log = {
    ...recorder(),
    errorEvidence: (): GatewayFailureEvidence => ({
      frames: ["packages/keiko-model-gateway/dist/prompt-admission.js:80:4"],
      causeChain: [],
    }),
  };
  expect(() =>
    admitGatewayPrompt({ ...request, maxOutputTokens: 1025 }, capability, log, "refused-call"),
  ).toThrow();
  expect(log.events[0]).toMatchObject({
    correlationId: "refused-call",
    errorKind: "invalid-request",
    extra: {
      state: "overflow",
      frames: ["packages/keiko-model-gateway/dist/prompt-admission.js:80:4"],
    },
  });
});

it("retains the text/tool/schema floor when a provider reports the image contribution", () => {
  const image = {
    type: "image_url" as const,
    image_url: { url: "https://fixture.example/image.png" },
  };
  const imageRequest = {
    ...request,
    messages: [
      {
        role: "user" as const,
        content: "describe",
        contentParts: [{ type: "text" as const, text: "requirement ".repeat(8000) }, image],
      },
    ],
  };
  expect(() =>
    admitGatewayPrompt(
      imageRequest,
      { ...capability, contextWindow: 8192 },
      recorder(),
      "image-text-floor",
      { status: "available", tokens: 100 },
    ),
  ).toThrow(expect.objectContaining({ code: "GATEWAY_CONTEXT_OVERFLOW" }));
});

it("refuses multiple unmeasured images when their combined allowance exceeds the budget", () => {
  const images = Array.from({ length: 5 }, () => ({
    type: "image_url" as const,
    image_url: { url: "https://fixture.example/image.png" },
  }));
  expect(() =>
    admitGatewayPrompt(
      { ...request, messages: [{ role: "user", content: "describe", contentParts: images }] },
      { ...capability, contextWindow: 8192 },
      recorder(),
      "image-fallback-overflow",
    ),
  ).toThrow(expect.objectContaining({ code: "GATEWAY_CONTEXT_OVERFLOW" }));
});

function imageAccountingRequest(length: number): GatewayCallRequest {
  return {
    ...request,
    maxOutputTokens: 1024,
    messages: [
      {
        role: "user",
        content: "private-image-prompt",
        contentParts: [
          { type: "text", text: "x".repeat(length) },
          { type: "image_url", image_url: { url: "https://private.example/image.png" } },
        ],
      },
    ],
  };
}

it.each([0, 100])(
  "persists the image accounting rule when the local floor wins over %s",
  (reported) => {
    const log = recorder();
    const vision = { ...capability, contextWindow: 8192, supportsImageInput: true };
    const profile = deriveContextProfileFromCapability(vision);
    const input = imageAccountingRequest(reported === 0 ? 2832 : 10_000);
    const measured = {
      status: "available" as const,
      tokens: reported,
      tokenizer: "openai" as const,
    };
    const fallback = countGatewayPromptTokens(input, profile.tokenAccounting, {
      contextWindow: 8192,
    });
    const textFloor = countGatewayPromptTokens(input, profile.tokenAccounting, {
      contextWindow: 8192,
      imageTokensMeasured: true,
    });
    admitGatewayPrompt(input, vision, log, "image-accounting-floor", measured);
    const line = formatActivityLogProofLine(log.events[0] ?? {});
    const persisted = expectActivityLogProof("gateway.prompt.admission.bounds", line);
    expect(persisted).toMatchObject({
      imageCount: 1,
      imageAccounting: reported === 0 ? "fallback-estimated" : "provider-measured",
      imageReserveTokens: reported === 0 ? fallback - textFloor : 0,
      reportedPromptTokens: reported,
      providerPromptTokens: reported,
      fallbackPromptTokens: fallback,
      localPromptTokens: reported === 0 ? fallback : textFloor,
      counterSource: "fallback-estimated",
    });
    expect(line).not.toContain("private-image-prompt");
    expect(line).not.toContain("private.example");
  },
);

describe("independent model input ceiling admission", () => {
  it.each([undefined, 128, 1_024])(
    "bounds actual input even when the output allocation is %s",
    (maxOutputTokens) => {
      const constrained = { ...capability, maxInputTokens: 128 };
      const boundedRequest = {
        ...request,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      };
      const log = recorder();
      expect(() =>
        admitGatewayPrompt(boundedRequest, constrained, log, "input-ceiling", {
          status: "available",
          tokens: 129,
        }),
      ).toThrow(expect.objectContaining({ code: "GATEWAY_CONTEXT_OVERFLOW" }));
      expect(log.events[0]?.extra).toMatchObject({
        contextWindow: constrained.contextWindow,
        inputBudget: constrained.maxInputTokens,
        state: "overflow",
      });
      expect(() =>
        admitGatewayPrompt(boundedRequest, constrained, recorder(), "input-ceiling", {
          status: "available",
          tokens: 128,
        }),
      ).not.toThrow();
    },
  );
});
