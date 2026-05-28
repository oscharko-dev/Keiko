import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REGISTRY,
  findCapability,
  listCapabilities,
  selectCheapest,
} from "../../src/gateway/capabilities.js";

const REQUIRED_IDS = [
  "Qwen3-Coder-480B-A35B-Instruct-FP8",
  "Qwen/Qwen3-Coder-Next-FP8",
  "Devstral-2-123B-Instruct-2512",
  "gpt-oss-120b",
  "Mistral-Small-3.1-24B-Instruct-2503",
  "Qwen2.5-Coder-7B-Instruct",
  "gemma-4-31b-it",
  "dotsocr",
  "multilingual-e5-large Embedding",
] as const;

describe("capability registry", () => {
  it("registers exactly the nine required models", () => {
    expect(CAPABILITY_REGISTRY).toHaveLength(9);
    for (const id of REQUIRED_IDS) {
      expect(CAPABILITY_REGISTRY.some((c) => c.id === id)).toBe(true);
    }
  });

  it("declares mandatory metadata on every entry", () => {
    for (const cap of CAPABILITY_REGISTRY) {
      expect(typeof cap.contextWindow).toBe("number");
      expect(typeof cap.toolCalling).toBe("boolean");
      expect(typeof cap.structuredOutput).toBe("boolean");
      expect(["low", "medium", "high"]).toContain(cap.costClass);
      expect(["fast", "standard", "slow"]).toContain(cap.latencyClass);
      expect(cap.preferredUseCases.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("declares the documented modality for the non-chat models", () => {
    expect(findCapability("dotsocr")?.kind).toBe("ocr-vision");
    expect(findCapability("multilingual-e5-large Embedding")?.kind).toBe("embedding");
  });
});

describe("findCapability", () => {
  it("returns the entry for a valid id", () => {
    const cap = findCapability("gpt-oss-120b");
    expect(cap?.id).toBe("gpt-oss-120b");
    expect(cap?.kind).toBe("chat");
  });

  it("returns undefined for an unknown id", () => {
    expect(findCapability("no-such-model")).toBeUndefined();
  });
});

describe("listCapabilities", () => {
  it("returns a snapshot of every registered model", () => {
    expect(listCapabilities().map((c) => c.id)).toEqual(CAPABILITY_REGISTRY.map((c) => c.id));
  });
});

describe("selectCheapest", () => {
  it("finds the cheapest chat model that supports tool calling and structured output", () => {
    const cap = selectCheapest({ kind: "chat", toolCalling: true, structuredOutput: true });
    expect(cap?.id).toBe("Mistral-Small-3.1-24B-Instruct-2503");
    expect(cap?.costClass).toBe("medium");
  });

  it("finds the cheapest tool-calling chat model when structured output is not required", () => {
    const cap = selectCheapest({ kind: "chat", toolCalling: true });
    expect(cap?.id).toBe("Qwen2.5-Coder-7B-Instruct");
    expect(cap?.costClass).toBe("low");
  });

  it("returns undefined when no model satisfies the requirements", () => {
    expect(selectCheapest({ kind: "embedding", toolCalling: true })).toBeUndefined();
  });
});
