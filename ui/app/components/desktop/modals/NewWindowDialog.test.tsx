import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@/lib/types";
import { isAgentWorkflowModel } from "./NewWindowDialog";

function model(patch: Partial<ModelCapability>): ModelCapability {
  return {
    id: "test-model",
    kind: "chat",
    contextWindow: 1,
    maxOutputTokens: 1,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    ...patch,
  };
}

describe("isAgentWorkflowModel", () => {
  it("allows only chat models with tool calling and structured output", () => {
    expect(isAgentWorkflowModel(model({ id: "gpt-oss-120b" }))).toBe(true);
    expect(isAgentWorkflowModel(model({ id: "Qwen2.5-Coder-7B-Instruct", structuredOutput: false }))).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "basic-chat", toolCalling: false }))).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "embedding", kind: "embedding" }))).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "dotsocr", kind: "ocr-vision" }))).toBe(false);
  });
});
